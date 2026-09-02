import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DockerApiClient } from "./docker-api.js";

/**
 * Kernel settings the agent keeps in place on the customer server.
 *
 * Traefik's file provider and BuildKit both rely on inotify. Ubuntu ships with a small
 * `max_user_watches` budget (a few thousand on a 2 GB host), and when it is exhausted Traefik
 * silently stops noticing route-file changes. The install script applies the same values; this
 * module repairs servers that were installed before that step existed, or whose operators reset
 * the sysctl configuration.
 */
export const HOST_INOTIFY_MAX_USER_WATCHES = 524288;
export const HOST_INOTIFY_MAX_USER_INSTANCES = 512;
export const HOST_SYSCTL_CONFIG_PATH = "/etc/sysctl.d/60-nouva.conf";
export const HOST_TUNING_CONTAINER_NAME = "nouva-host-tuning";
export const HOST_TUNING_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const HOST_TUNING_TIMEOUT_MS = 60 * 1000;

export interface HostInotifyLimits {
  maxUserWatches: number | null;
  maxUserInstances: number | null;
}

export type HostTuningStatus = "satisfied" | "applied" | "failed" | "deferred";

export interface HostTuningResult {
  status: HostTuningStatus;
  limits: HostInotifyLimits;
  message: string | null;
}

async function readSysctlValue(hostRoot: string, key: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(hostRoot, "proc/sys", key), "utf8");
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readHostInotifyLimits(hostRoot = "/hostfs"): Promise<HostInotifyLimits> {
  return {
    maxUserWatches: await readSysctlValue(hostRoot, "fs/inotify/max_user_watches"),
    maxUserInstances: await readSysctlValue(hostRoot, "fs/inotify/max_user_instances"),
  };
}

export function hostInotifyLimitsSatisfied(limits: HostInotifyLimits): boolean {
  return (
    limits.maxUserWatches !== null &&
    limits.maxUserWatches >= HOST_INOTIFY_MAX_USER_WATCHES &&
    limits.maxUserInstances !== null &&
    limits.maxUserInstances >= HOST_INOTIFY_MAX_USER_INSTANCES
  );
}

/**
 * POSIX shell executed in the host mount namespace. It only ever raises the limits, persists them
 * in sysctl.d so they survive reboots, and falls back to /proc/sys when `sysctl` is unavailable.
 */
export function buildHostSysctlScript(): string {
  return [
    "set -eu",
    'watches="$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)"',
    'instances="$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 0)"',
    `[ "$watches" -ge ${HOST_INOTIFY_MAX_USER_WATCHES} ] || watches=${HOST_INOTIFY_MAX_USER_WATCHES}`,
    `[ "$instances" -ge ${HOST_INOTIFY_MAX_USER_INSTANCES} ] || instances=${HOST_INOTIFY_MAX_USER_INSTANCES}`,
    `mkdir -p "$(dirname ${HOST_SYSCTL_CONFIG_PATH})"`,
    `printf '%s\\n' '# Managed by the Nouva agent. Traefik and BuildKit rely on inotify.' "fs.inotify.max_user_watches = $watches" "fs.inotify.max_user_instances = $instances" > ${HOST_SYSCTL_CONFIG_PATH}`,
    "if command -v sysctl >/dev/null 2>&1; then",
    `  sysctl -q -p ${HOST_SYSCTL_CONFIG_PATH}`,
    "else",
    '  echo "$watches" > /proc/sys/fs/inotify/max_user_watches',
    '  echo "$instances" > /proc/sys/fs/inotify/max_user_instances',
    "fi",
  ].join("\n");
}

let lastFailedAttemptAt: number | null = null;

export function resetHostTuningBackoffForTests(): void {
  lastFailedAttemptAt = null;
}

/**
 * Raises the host inotify limits when they are below the Nouva baseline.
 *
 * The agent container mounts the host read-only, so the change is applied by a short-lived
 * privileged helper (running the agent image) that enters PID 1's mount namespace with `nsenter`.
 * Failures are reported, not thrown, and retried on a slow cadence so a locked-down host does not
 * block heartbeats.
 */
export async function ensureHostKernelSettings(
  docker: Pick<
    DockerApiClient,
    "createContainer" | "startContainer" | "waitContainer" | "containerLogs" | "removeContainer"
  >,
  options: {
    image: string;
    hostRoot?: string;
    labels?: Record<string, string>;
    now?: () => number;
  }
): Promise<HostTuningResult> {
  const hostRoot = options.hostRoot ?? "/hostfs";
  const now = options.now ?? Date.now;
  const limits = await readHostInotifyLimits(hostRoot);

  if (hostInotifyLimitsSatisfied(limits)) {
    return { status: "satisfied", limits, message: null };
  }

  if (lastFailedAttemptAt !== null && now() - lastFailedAttemptAt < HOST_TUNING_RETRY_INTERVAL_MS) {
    return {
      status: "deferred",
      limits,
      message: "Host tuning recently failed; waiting before retrying",
    };
  }

  try {
    await docker.removeContainer(HOST_TUNING_CONTAINER_NAME, true);
    const id = await docker.createContainer({
      name: HOST_TUNING_CONTAINER_NAME,
      image: options.image,
      entrypoint: ["nsenter"],
      cmd: ["-t", "1", "-m", "-u", "-i", "-n", "--", "sh", "-c", buildHostSysctlScript()],
      labels: options.labels,
      hostConfig: {
        AutoRemove: false,
        Privileged: true,
        PidMode: "host",
        NetworkMode: "host",
      },
    });

    let statusCode: number;
    let logs = "";
    try {
      await docker.startContainer(id);
      statusCode = await docker.waitContainer(id, HOST_TUNING_TIMEOUT_MS);
      logs = await docker.containerLogs(id).catch(() => "");
    } finally {
      await docker.removeContainer(HOST_TUNING_CONTAINER_NAME, true).catch(() => undefined);
    }

    if (statusCode !== 0) {
      throw new Error(`host tuning helper exited with status ${statusCode}: ${logs.trim()}`);
    }

    const updated = await readHostInotifyLimits(hostRoot);
    if (!hostInotifyLimitsSatisfied(updated)) {
      throw new Error(
        `inotify limits are still ${updated.maxUserWatches ?? "unknown"} watches / ${updated.maxUserInstances ?? "unknown"} instances after tuning`
      );
    }

    lastFailedAttemptAt = null;
    return { status: "applied", limits: updated, message: null };
  } catch (error) {
    lastFailedAttemptAt = now();
    return {
      status: "failed",
      limits,
      message: error instanceof Error ? error.message : "Unable to apply host kernel settings",
    };
  }
}
