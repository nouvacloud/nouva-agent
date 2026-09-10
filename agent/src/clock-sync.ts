import { stat } from "node:fs/promises";
import path from "node:path";
import type { DockerApiClient } from "./docker-api.js";

/**
 * Host clock synchronisation detection.
 *
 * Drift breaks TLS handshakes, ACME challenges and pgBackRest PITR timestamps, so the agent
 * reports on it. The question is whether the *clock* is synchronised, not whether a particular
 * daemon left a file behind: chrony, systemd-timesyncd, ntpd and openntpd all synchronise the
 * clock, and installing chrony on Debian/Ubuntu disables systemd-timesyncd, so probing for one
 * daemon's files mislabels a correctly synchronised host (issue #268).
 *
 * `timedatectl show` answers the question for every daemon at once because `NTPSynchronized`
 * reflects the kernel's own synchronisation flag rather than any daemon's state. It has to run in
 * the host namespaces, which the unprivileged agent container reaches the same way
 * `ensureHostKernelSettings` does: a short-lived privileged helper running the agent image that
 * enters PID 1's namespaces with `nsenter`.
 */

export const CLOCK_PROBE_CONTAINER_NAME = "nouva-clock-probe";
const CLOCK_PROBE_TIMEOUT_MS = 30 * 1000;
/**
 * The validation snapshot is rebuilt on every heartbeat, and the probe costs a container launch,
 * so a reading is reused for a while. Drift that matters accumulates over hours, not seconds.
 */
export const CLOCK_PROBE_INTERVAL_MS = 10 * 60 * 1000;
/** A host that cannot run the helper at all should not be asked again on every heartbeat. */
export const CLOCK_PROBE_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** systemd-timesyncd creates this regular file only after a synchronisation has succeeded. */
const TIMESYNCD_SYNCHRONIZED_PATH = "run/systemd/timesync/synchronized";
/**
 * chronyd's command socket (Debian and Ubuntu ship `bindcmdaddress /var/run/chrony/chronyd.sock`).
 * Its presence proves chronyd is running and says nothing about whether the clock is synchronised,
 * so it is only ever read as "a daemon is there". It is a socket inode: probe it with `stat`, never
 * with an operation that opens it — `open(2)` on a unix socket always fails with ENXIO.
 */
const CHRONYD_SOCKET_PATH = "run/chrony/chronyd.sock";

const DRIFT_CONSEQUENCE = "clock drift may break TLS certificates and PITR timestamps";

export interface TimedatectlClockState {
  /** `NTP=` — whether a network time synchronisation service is enabled. */
  ntpEnabled: boolean | null;
  /** `NTPSynchronized=` — whether the kernel considers the clock synchronised. */
  synchronized: boolean;
}

/**
 * What the agent actually established about the host clock. Everything other than `timedatectl`
 * is a degraded reading taken from the read-only host mount because the helper could not run;
 * `reason` says why, and is reported so a warning never claims more than was tested.
 */
export type ClockSyncEvidence =
  | { kind: "timedatectl"; state: TimedatectlClockState }
  | { kind: "timesyncd-synchronized"; reason: string }
  | { kind: "chronyd-running"; reason: string }
  | { kind: "unknown"; reason: string };

export interface ClockSyncAssessment {
  status: "pass" | "warn";
  message: string;
  value: string;
}

export type ClockProbeDocker = Pick<
  DockerApiClient,
  "createContainer" | "startContainer" | "waitContainer" | "containerLogs" | "removeContainer"
>;

/**
 * What it takes to run the probe, or why it cannot run. A caller that has no Docker client or no
 * agent image reference always knows why, and the reason travels with the absence so the degraded
 * message can name it instead of saying something generic.
 */
export type ClockProbeHelper =
  | { kind: "available"; docker: ClockProbeDocker; image: string }
  | { kind: "unavailable"; reason: string };

function parseSystemdBoolean(value: string | undefined): boolean | null {
  switch (value?.trim().toLowerCase()) {
    case "yes":
    case "true":
    case "1":
      return true;
    case "no":
    case "false":
    case "0":
      return false;
    default:
      return null;
  }
}

/**
 * Reads `timedatectl show -p NTP -p NTPSynchronized` output. Returns null when the synchronisation
 * state is absent or unrecognised, because a missing answer is not a negative one.
 */
export function parseTimedatectlClockState(output: string): TimedatectlClockState | null {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      properties.set(line.slice(0, separator).trim(), line.slice(separator + 1));
    }
  }

  const synchronized = parseSystemdBoolean(properties.get("NTPSynchronized"));
  if (synchronized === null) {
    return null;
  }

  return { ntpEnabled: parseSystemdBoolean(properties.get("NTP")), synchronized };
}

function formatClockStateValue(state: TimedatectlClockState): string {
  const ntp = state.ntpEnabled === null ? "unknown" : state.ntpEnabled ? "yes" : "no";
  return `NTP=${ntp},NTPSynchronized=${state.synchronized ? "yes" : "no"}`;
}

export function evaluateClockSync(evidence: ClockSyncEvidence): ClockSyncAssessment {
  switch (evidence.kind) {
    case "timedatectl": {
      const { ntpEnabled, synchronized } = evidence.state;
      const value = formatClockStateValue(evidence.state);
      if (synchronized) {
        return {
          status: "pass",
          message:
            ntpEnabled === false
              ? "System clock is synchronised, but no time synchronisation service is enabled — it will drift once the current offset ages"
              : "System clock is synchronised",
          value,
        };
      }
      return {
        status: "warn",
        message:
          ntpEnabled === true
            ? `A time synchronisation service is enabled but the clock is not synchronised yet — ${DRIFT_CONSEQUENCE}`
            : ntpEnabled === false
              ? `No time synchronisation service is enabled and the clock is not synchronised — ${DRIFT_CONSEQUENCE}`
              : `The system clock is not synchronised — ${DRIFT_CONSEQUENCE}`,
        value,
      };
    }
    case "timesyncd-synchronized":
      return {
        status: "pass",
        message: `systemd-timesyncd has completed a synchronisation since boot (${evidence.reason})`,
        value: "timesyncd-synchronized",
      };
    case "chronyd-running":
      return {
        status: "warn",
        message: `chronyd is running but its synchronisation state could not be verified (${evidence.reason}) — ${DRIFT_CONSEQUENCE}`,
        value: "chronyd-running",
      };
    case "unknown":
      return {
        status: "warn",
        message: `Clock synchronisation could not be verified (${evidence.reason}) — ${DRIFT_CONSEQUENCE}`,
        value: "unverified",
      };
  }
}

/** POSIX shell run in the host namespaces. It reads state and changes nothing. */
export function buildClockProbeScript(): string {
  return ["set -eu", "timedatectl show -p NTP -p NTPSynchronized"].join("\n");
}

type ClockProbeOutcome = { ok: true; state: TimedatectlClockState } | { ok: false; reason: string };

let cachedProbe: { observedAt: number; outcome: ClockProbeOutcome } | null = null;

export function resetClockProbeCacheForTests(): void {
  cachedProbe = null;
}

async function runClockProbe(
  docker: ClockProbeDocker,
  options: { image: string; labels?: Record<string, string> }
): Promise<ClockProbeOutcome> {
  await docker.removeContainer(CLOCK_PROBE_CONTAINER_NAME, true);
  const id = await docker.createContainer({
    name: CLOCK_PROBE_CONTAINER_NAME,
    image: options.image,
    entrypoint: ["nsenter"],
    cmd: ["-t", "1", "-m", "-u", "-i", "-n", "--", "sh", "-c", buildClockProbeScript()],
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
    statusCode = await docker.waitContainer(id, CLOCK_PROBE_TIMEOUT_MS);
    logs = await docker.containerLogs(id).catch(() => "");
  } finally {
    await docker.removeContainer(CLOCK_PROBE_CONTAINER_NAME, true).catch(() => undefined);
  }

  if (statusCode !== 0) {
    return {
      ok: false,
      reason: `the host clock probe exited with status ${statusCode}: ${logs.trim()}`,
    };
  }

  const state = parseTimedatectlClockState(logs);
  return state === null
    ? { ok: false, reason: "timedatectl reported no NTPSynchronized state" }
    : { ok: true, state };
}

async function probeHostClock(
  helper: ClockProbeHelper,
  options: { labels?: Record<string, string>; now: () => number }
): Promise<ClockProbeOutcome> {
  if (helper.kind === "unavailable") {
    return { ok: false, reason: helper.reason };
  }

  const cached = cachedProbe;
  const ttl = cached?.outcome.ok ? CLOCK_PROBE_INTERVAL_MS : CLOCK_PROBE_RETRY_INTERVAL_MS;
  if (cached !== null && options.now() - cached.observedAt < ttl) {
    return cached.outcome;
  }

  let outcome: ClockProbeOutcome;
  try {
    outcome = await runClockProbe(helper.docker, { image: helper.image, labels: options.labels });
  } catch (error) {
    outcome = {
      ok: false,
      reason: error instanceof Error ? error.message : "the host clock probe failed",
    };
  }
  cachedProbe = { observedAt: options.now(), outcome };
  return outcome;
}

async function statHostPath(hostPath: string) {
  try {
    return await stat(hostPath);
  } catch {
    return null;
  }
}

/**
 * Read-only evidence available without the helper. Only the systemd-timesyncd sentinel proves a
 * synchronisation actually happened; chronyd's socket proves nothing beyond the daemon running.
 */
async function readHostClockFallback(hostRoot: string, reason: string): Promise<ClockSyncEvidence> {
  if ((await statHostPath(path.join(hostRoot, TIMESYNCD_SYNCHRONIZED_PATH)))?.isFile()) {
    return { kind: "timesyncd-synchronized", reason };
  }
  if ((await statHostPath(path.join(hostRoot, CHRONYD_SOCKET_PATH)))?.isSocket()) {
    return { kind: "chronyd-running", reason };
  }
  return { kind: "unknown", reason };
}

/**
 * Establishes what is known about the host clock, preferring the authoritative daemon-agnostic
 * answer and degrading to host filesystem evidence when the privileged helper cannot run.
 */
export async function detectHostClockSync(
  helper: ClockProbeHelper,
  options: {
    hostRoot?: string;
    labels?: Record<string, string>;
    now?: () => number;
  } = {}
): Promise<ClockSyncEvidence> {
  const outcome = await probeHostClock(helper, {
    labels: options.labels,
    now: options.now ?? Date.now,
  });

  return outcome.ok
    ? { kind: "timedatectl", state: outcome.state }
    : await readHostClockFallback(options.hostRoot ?? "/hostfs", outcome.reason);
}
