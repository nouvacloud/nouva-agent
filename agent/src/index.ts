import { mkdir, readFile, readlink, rename, statfs, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import agentPackageJson from "../package.json" with { type: "json" };
import {
  buildAndDeployAppWithDependencies,
  type DeployAppImageInput,
} from "./app-build-runtime.js";
import { buildApp, hashProjectNetwork } from "./build.js";
import {
  DockerApiClient,
  type DockerContainerInspection,
  type DockerContainerSpec,
  type DockerLogEntry,
} from "./docker-api.js";
import { toDockerResourceSettings } from "./docker-resource-limits.js";
import { collectPostgresObservabilitySamples } from "./postgres-observability.js";
import {
  type AgentCapabilities,
  type AgentHeartbeatResponse,
  type AgentLeaseResponse,
  type AgentMetricsEnvelope,
  type AgentMetricsRequest,
  type AgentPostgresObservabilityRequest,
  type AgentPostgresObservabilityResponse,
  type AgentRegistrationResponse,
  type AgentRuntimeConfig,
  type AgentRuntimeLogBatch,
  type AgentRuntimeLogsRequest,
  type AgentRuntimeLogsResponse,
  type AgentWorkRecord,
  type AppDeployPayload,
  type AppRolloutConfig,
  type AppRolloutResult,
  type CreateVolumeBackupPayload,
  type DatabaseProvisionPayload,
  type DeleteVolumeBackupPayload,
  type DeleteVolumePayload,
  type DeployOnlyPayload,
  type ExpireVolumeBackupRepositoryPayload,
  getAgentRuntimeConfig,
  getDefaultAgentCapabilities,
  parseHostMetricsSnapshot,
  type RemoveServicePayload,
  type RestartServicePayload,
  type RestorePostgresPitrPayload,
  type RestoreVolumeBackupPayload,
  type RuntimeLogMessage,
  type RuntimeMetadata,
  resolveAppRolloutConfig,
  type ServerValidationReport,
  type ServiceResourceLimits,
  type SyncRoutingPayload,
} from "./protocol.js";
import { resolveDatabaseProvisionSpec } from "./service-runtime.js";
import {
  buildTraefikRuntimePaths,
  buildUnavailableTraefikChecks,
  collectTraefikValidationChecks,
  DEFAULT_TRAEFIK_IMAGE,
  deleteLocalTraefikRoute,
  ensureTraefikRuntime,
  type TraefikRuntimeInput,
  writeLocalTraefikRoute,
} from "./traefik-runtime.js";
import { resolveUpdateAgentImageRef, toUpdateAgentPayload } from "./update-agent.js";

const API_URL = process.env.NOUVA_API_URL;
const SERVER_ID = process.env.NOUVA_SERVER_ID;
const REGISTRATION_TOKEN = process.env.NOUVA_REGISTRATION_TOKEN;
const DATA_DIR = "/var/lib/nouva-agent";
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
const APP_DOMAIN = process.env.NOUVA_APP_DOMAIN || "nouva.cloud";
const DATA_VOLUME = process.env.NOUVA_AGENT_DATA_VOLUME || "nouva-agent-data";
const BUILDKIT_CONTAINER_NAME = process.env.NOUVA_AGENT_BUILDKIT_CONTAINER || "nouva-buildkitd";
const BUILDKIT_IMAGE = "moby/buildkit:v0.17.0";
const LOCAL_REGISTRY_CONTAINER_NAME =
  process.env.NOUVA_AGENT_REGISTRY_CONTAINER || "nouva-registry";
const TRAEFIK_CONTAINER_NAME = process.env.NOUVA_AGENT_TRAEFIK_CONTAINER || "nouva-traefik";
const TRAEFIK_IMAGE = process.env.NOUVA_AGENT_TRAEFIK_IMAGE || DEFAULT_TRAEFIK_IMAGE;
const TRAEFIK_PATHS = buildTraefikRuntimePaths(DATA_DIR);
const BUILDKIT_ADDRESS = process.env.NOUVA_AGENT_BUILDKIT_ADDR || "tcp://127.0.0.1:1234";
const DEFAULT_BUILDKIT_PORT = 1234;
const BACKUP_HELPER_IMAGE =
  process.env.NOUVA_BACKUP_HELPER_IMAGE || "ghcr.io/nouvacloud/backup-helper:latest";
const RUNTIME_LOG_SYNC_INTERVAL_MS = Number.parseInt(
  process.env.NOUVA_AGENT_RUNTIME_LOG_SYNC_INTERVAL_MS || "2000",
  10
);

export function resolveReportedAgentVersion(packageVersion: string): string {
  const trimmedPackageVersion = packageVersion.trim();
  if (!trimmedPackageVersion) {
    throw new Error("Agent package version is required");
  }

  return trimmedPackageVersion.startsWith("v")
    ? trimmedPackageVersion
    : `v${trimmedPackageVersion}`;
}

function getInheritedNouvaEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith("NOUVA_") && key !== "NOUVA_AGENT_VERSION")
    .sort();
}

export function buildUpdateAgentRuntimeEnv(
  env: Record<string, string | undefined>,
  imageRef: string
): {
  updaterEnv: string[];
  envInheritFlags: string;
} {
  const inheritedNouvaEnvKeys = getInheritedNouvaEnvKeys(env);
  const updaterEnv = [
    ...inheritedNouvaEnvKeys.map((key) => `${key}=${env[key] ?? ""}`),
    `NOUVA_AGENT_TARGET_IMAGE=${imageRef}`,
  ];
  const envInheritFlags = [...inheritedNouvaEnvKeys, "NOUVA_AGENT_TARGET_IMAGE"]
    .map((key) => `-e ${key}`)
    .join(" ");

  return {
    updaterEnv,
    envInheritFlags,
  };
}

const AGENT_VERSION = resolveReportedAgentVersion(agentPackageJson.version);

function assertAgentBootstrapEnv(): void {
  if (!API_URL || !SERVER_ID) {
    throw new Error("Missing NOUVA_API_URL or NOUVA_SERVER_ID");
  }
}

interface StoredCredentials {
  serverId: string;
  agentToken: string;
}

interface ValidationSnapshot {
  hostname: string;
  operatingSystem: string | null;
  architecture: string | null;
  dockerVersion: string | null;
  publicIp: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytesAvailable: number | null;
  latestValidationReport: ServerValidationReport;
  capabilities: AgentCapabilities;
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toRecord(value: unknown): Record<string, string> {
  const record = toObject(value);
  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      next[key] = entry;
    }
  }
  return next;
}

function resolveHydratedHelperSpec(payload: {
  imageUrl?: string;
  envVars?: Record<string, string> | undefined;
  containerArgs?: string[] | undefined;
  dataPath?: string;
}) {
  if (!payload.imageUrl || !payload.dataPath || !payload.envVars) {
    throw new Error("Backup helper payload is missing hydrated executor fields");
  }

  return {
    image: payload.imageUrl,
    envVars: toRecord(payload.envVars),
    containerArgs: Array.isArray(payload.containerArgs)
      ? payload.containerArgs.filter((value): value is string => typeof value === "string")
      : [],
    dataPath: payload.dataPath,
  };
}

function toRuntimeMetadata(value: unknown): RuntimeMetadata | null {
  const metadata = toObject(value);
  return Object.keys(metadata).length > 0 ? (metadata as RuntimeMetadata) : null;
}

async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as StoredCredentials;
  } catch {
    return null;
  }
}

async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(credentials, null, 2));
  await rename(tmp, CREDENTIALS_PATH);
}

function buildCheck(
  key: string,
  label: string,
  status: "pass" | "warn" | "fail",
  message: string,
  value: string | null = null
) {
  return { key, label, status, message, value };
}

async function checkTcpConnect(host: string, port: number, timeoutMs = 3000) {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveAppRuntimePort(
  runtimeMetadata: RuntimeMetadata | null | undefined,
  fallback: number
) {
  const port = runtimeMetadata?.internalPort;
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : fallback;
}

function resolveContainerIpAddress(inspection: DockerContainerInspection | null): string | null {
  const networks = inspection?.NetworkSettings?.Networks;
  if (!networks) {
    return null;
  }

  for (const network of Object.values(networks)) {
    if (typeof network?.IPAddress === "string" && network.IPAddress.length > 0) {
      return network.IPAddress;
    }
  }

  return null;
}

function buildAppRolloutResult(input: {
  outcome: AppRolloutResult["outcome"];
  currentPhase: AppRolloutResult["currentPhase"];
  liveRuntimePreserved: boolean;
  rollbackCompleted: boolean;
  activeContainerName?: string | null;
  candidateContainerName?: string | null;
}): AppRolloutResult {
  return {
    strategy: "candidate_ready_cutover",
    outcome: input.outcome,
    currentPhase: input.currentPhase,
    liveRuntimePreserved: input.liveRuntimePreserved,
    rollbackCompleted: input.rollbackCompleted,
    activeContainerName: input.activeContainerName ?? null,
    candidateContainerName: input.candidateContainerName ?? null,
  };
}

class AppRolloutError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, rollout: AppRolloutResult) {
    super(message);
    this.name = "AppRolloutError";
    this.result = {
      rollout,
    };
  }
}

interface DeployAppImageDependencies {
  ensureBaseRuntime: typeof ensureBaseRuntime;
  checkTcpConnect: typeof checkTcpConnect;
  fetchImpl: typeof fetch;
  writeLocalTraefikRoute: typeof writeLocalTraefikRoute;
  deleteLocalTraefikRoute: typeof deleteLocalTraefikRoute;
}

const defaultDeployAppImageDependencies: DeployAppImageDependencies = {
  ensureBaseRuntime,
  checkTcpConnect,
  fetchImpl: fetch,
  writeLocalTraefikRoute,
  deleteLocalTraefikRoute,
};

async function waitForAppCandidateReadiness(
  dependencies: Pick<DeployAppImageDependencies, "checkTcpConnect">,
  docker: Pick<DockerApiClient, "inspectContainer">,
  containerName: string,
  appPort: number,
  rollout: AppRolloutConfig
): Promise<void> {
  const deadline = Date.now() + rollout.readiness.timeoutMs;
  let lastError = "candidate container did not become ready";

  while (Date.now() <= deadline) {
    const inspection = await docker.inspectContainer(containerName);
    if (!inspection) {
      throw new Error(`Candidate container ${containerName} is missing`);
    }

    const state = inspection.State;
    const status = state?.Status?.toLowerCase();
    if (status === "exited" || status === "dead" || status === "removing") {
      throw new Error(`Candidate container ${containerName} is not running (${status})`);
    }

    const healthStatus = state?.Health?.Status?.toLowerCase();
    if (healthStatus === "healthy") {
      return;
    }

    if (healthStatus === "unhealthy") {
      throw new Error(`Candidate container ${containerName} became unhealthy`);
    }

    const ipAddress = resolveContainerIpAddress(inspection);
    if (ipAddress) {
      const reachable = await dependencies.checkTcpConnect(
        ipAddress,
        appPort,
        rollout.readiness.tcpConnectTimeoutMs
      );
      if (reachable) {
        return;
      }
      lastError = `Candidate container ${containerName} is not accepting TCP traffic on ${appPort}`;
    } else {
      lastError = `Candidate container ${containerName} has no routable IP address yet`;
    }

    await sleep(rollout.readiness.intervalMs);
  }

  throw new Error(lastError);
}

async function waitForLocalTraefikCutover(
  fetchImpl: typeof fetch,
  serviceId: string,
  expectedServiceUrl: string,
  rollout: AppRolloutConfig
): Promise<void> {
  const serviceName = `svc-${serviceId}@file`;
  const deadline = Date.now() + rollout.cutover.verificationTimeoutMs;
  let lastError = `Traefik did not point ${serviceName} at ${expectedServiceUrl}`;

  while (Date.now() <= deadline) {
    const response = await fetchImpl("http://127.0.0.1:8082/api/http/services");
    if (!response.ok) {
      lastError = `Traefik service inspection failed with status ${response.status}`;
      await sleep(rollout.cutover.verificationIntervalMs);
      continue;
    }

    const services = (await response.json()) as Array<{
      name?: string;
      loadBalancer?: {
        servers?: Array<{
          url?: string;
        }>;
      };
    }>;

    const service = services.find((entry) => entry.name === serviceName);
    const actualUrl = service?.loadBalancer?.servers?.[0]?.url;
    if (actualUrl === expectedServiceUrl) {
      return;
    }

    if (typeof actualUrl === "string" && actualUrl.length > 0) {
      lastError = `Traefik still points ${serviceName} at ${actualUrl}`;
    }

    await sleep(rollout.cutover.verificationIntervalMs);
  }

  throw new Error(lastError);
}

async function collectValidationSnapshot(
  docker: DockerApiClient,
  config: AgentRuntimeConfig
): Promise<ValidationSnapshot> {
  const checks: ValidationSnapshot["latestValidationReport"]["checks"] = [];
  const hostOsId = (process.env.NOUVA_HOST_OS_ID || "unknown").toLowerCase();
  const hostOsVersion = process.env.NOUVA_HOST_OS_VERSION_ID || "unknown";
  const hostArch = os.arch();

  const osSupported = hostOsId === "ubuntu";
  checks.push(
    buildCheck(
      "os",
      "Supported OS",
      osSupported ? "pass" : "fail",
      osSupported ? `Ubuntu ${hostOsVersion} detected` : "Nouva currently supports Ubuntu only",
      `${hostOsId} ${hostOsVersion}`
    )
  );

  const archSupported = hostArch === "x64" || hostArch === "amd64";
  checks.push(
    buildCheck(
      "arch",
      "Supported architecture",
      archSupported ? "pass" : "fail",
      archSupported ? "x86_64 detected" : "Nouva currently supports x86_64 only",
      hostArch
    )
  );

  let dockerVersion: string | null = null;
  try {
    const version = await docker.request<{ Version?: string }>("GET", "/version");
    dockerVersion = version.Version ?? null;
    checks.push(
      buildCheck(
        "docker",
        "Docker Engine",
        dockerVersion ? "pass" : "fail",
        dockerVersion ? "Docker Engine is available" : "Docker Engine is unavailable",
        dockerVersion
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "docker",
        "Docker Engine",
        "fail",
        error instanceof Error ? error.message : "Docker Engine is unavailable"
      )
    );
  }

  if (dockerVersion) {
    let traefikBootstrapError: Error | null = null;
    try {
      await ensureTraefikRuntime(docker, getTraefikRuntimeInput(config));
    } catch (error) {
      traefikBootstrapError =
        error instanceof Error ? error : new Error("Failed to reconcile Traefik");
    }

    checks.push(
      ...(await collectTraefikValidationChecks(
        docker,
        getTraefikRuntimeInput(config),
        undefined,
        traefikBootstrapError
      ))
    );
  } else {
    checks.push(...buildUnavailableTraefikChecks("Docker Engine is unavailable"));
  }

  let diskBytesAvailable: number | null = null;
  try {
    const stats = await statfs("/hostfs");
    diskBytesAvailable = Number(stats.bavail) * Number(stats.bsize);
    checks.push(
      buildCheck(
        "disk",
        "Disk headroom",
        diskBytesAvailable >= 20 * 1024 * 1024 * 1024 ? "pass" : "warn",
        diskBytesAvailable >= 20 * 1024 * 1024 * 1024
          ? "At least 20GB free"
          : "Less than 20GB free on the server",
        String(diskBytesAvailable)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "disk",
        "Disk headroom",
        "warn",
        error instanceof Error ? error.message : "Unable to inspect disk"
      )
    );
  }

  try {
    const response = await fetch(`${API_URL}/health`);
    checks.push(
      buildCheck(
        "outbound",
        "Outbound connectivity",
        response.ok ? "pass" : "fail",
        response.ok ? "Can reach Nouva API" : "Cannot reach Nouva API",
        String(response.status)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "outbound",
        "Outbound connectivity",
        "fail",
        error instanceof Error ? error.message : "Unable to reach Nouva API"
      )
    );
  }

  const totalMemoryBytes = os.totalmem();
  const twoGB = 2 * 1024 * 1024 * 1024;
  const oneGB = 1024 * 1024 * 1024;
  checks.push(
    buildCheck(
      "memory",
      "Memory headroom",
      totalMemoryBytes >= twoGB ? "pass" : totalMemoryBytes >= oneGB ? "warn" : "fail",
      totalMemoryBytes >= twoGB
        ? "At least 2 GB RAM available"
        : totalMemoryBytes >= oneGB
          ? "Less than 2 GB RAM — some workloads may be constrained"
          : "Less than 1 GB RAM — insufficient for most workloads",
      String(totalMemoryBytes)
    )
  );

  const buildkitMatch = BUILDKIT_ADDRESS.match(/^tcp:\/\/([^:]+):(\d+)/);
  if (buildkitMatch) {
    const [, bkHost, bkPort] = buildkitMatch;
    if (bkHost && bkPort) {
      const buildkitReachable = await checkTcpConnect(bkHost, Number(bkPort));
      checks.push(
        buildCheck(
          "buildkit",
          "BuildKit daemon",
          buildkitReachable ? "pass" : "warn",
          buildkitReachable
            ? "BuildKit daemon is reachable"
            : "BuildKit daemon is not yet reachable — image builds will fail until it starts",
          BUILDKIT_ADDRESS
        )
      );
    }
  }

  // IP forwarding — required for all Docker container networking and NAT
  try {
    const ipForward = (await readFile("/hostfs/proc/sys/net/ipv4/ip_forward", "utf8")).trim();
    checks.push(
      buildCheck(
        "ip-forward",
        "IP forwarding",
        ipForward === "1" ? "pass" : "fail",
        ipForward === "1"
          ? "IP forwarding is enabled"
          : "IP forwarding is disabled — container networking and NAT will not work",
        ipForward
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "ip-forward",
        "IP forwarding",
        "warn",
        error instanceof Error ? error.message : "Unable to read IP forwarding state"
      )
    );
  }

  // cgroup v2 — required for correct memory limits and OOM handling on containers
  try {
    await readFile("/hostfs/sys/fs/cgroup/cgroup.controllers", "utf8");
    checks.push(
      buildCheck("cgroup-version", "cgroup v2", "pass", "cgroup v2 unified hierarchy detected")
    );
  } catch {
    checks.push(
      buildCheck(
        "cgroup-version",
        "cgroup v2",
        "fail",
        "cgroup v1 detected — container memory limits and OOM protection will not be enforced correctly"
      )
    );
  }

  // Clock synchronisation — drift breaks TLS, ACME challenges, and pgBackRest PITR
  {
    let clockSynced = false;
    try {
      await readFile("/hostfs/run/chrony/chrony.sock");
      clockSynced = true;
    } catch {}
    if (!clockSynced) {
      try {
        await readFile("/hostfs/run/systemd/timesync/synchronized");
        clockSynced = true;
      } catch {}
    }
    checks.push(
      buildCheck(
        "clock-sync",
        "Clock synchronisation",
        clockSynced ? "pass" : "warn",
        clockSynced
          ? "Time synchronisation daemon is active"
          : "No active NTP/chrony sync detected — clock drift may break TLS certificates and PITR timestamps"
      )
    );
  }

  // DNS configuration — systemd-resolved stub listener causes silent DNS failures in containers
  try {
    let isStub = false;
    try {
      const symlinkTarget = await readlink("/hostfs/etc/resolv.conf");
      isStub = symlinkTarget.includes("stub-resolv.conf");
    } catch {
      const content = await readFile("/hostfs/etc/resolv.conf", "utf8");
      isStub =
        /^nameserver\s+127\.0\.0\.53$/m.test(content) && !content.includes("nameserver 127.0.0.1");
    }
    checks.push(
      buildCheck(
        "dns-stub",
        "DNS configuration",
        isStub ? "warn" : "pass",
        isStub
          ? "resolv.conf points to systemd-resolved stub (127.0.0.53) — container DNS resolution may fail"
          : "DNS configuration looks correct"
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "dns-stub",
        "DNS configuration",
        "warn",
        error instanceof Error ? error.message : "Unable to inspect DNS configuration"
      )
    );
  }

  // inotify watch limit — Traefik file watching silently stops when the host limit is exhausted
  try {
    const maxWatches = parseInt(
      (await readFile("/hostfs/proc/sys/fs/inotify/max_user_watches", "utf8")).trim(),
      10
    );
    checks.push(
      buildCheck(
        "inotify-limits",
        "inotify watch limit",
        maxWatches >= 65536 ? "pass" : "warn",
        maxWatches >= 65536
          ? `inotify watch limit is sufficient (${maxWatches.toLocaleString()})`
          : `inotify watch limit is low (${maxWatches.toLocaleString()}) — Traefik file watching may silently stop as more services are deployed`,
        String(maxWatches)
      )
    );
  } catch (error) {
    checks.push(
      buildCheck(
        "inotify-limits",
        "inotify watch limit",
        "warn",
        error instanceof Error ? error.message : "Unable to read inotify limits"
      )
    );
  }

  let publicIp: string | null = null;
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    if (response.ok) {
      const body = (await response.json()) as { ip?: string };
      publicIp = body.ip ?? null;
    }
  } catch {}

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 }
  );

  return {
    hostname: os.hostname(),
    operatingSystem: `${hostOsId} ${hostOsVersion}`,
    architecture: hostArch,
    dockerVersion,
    publicIp,
    cpuCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    diskBytesAvailable,
    latestValidationReport: {
      checkedAt: new Date().toISOString(),
      summary,
      checks,
    },
    capabilities: getDefaultAgentCapabilities(),
  };
}

export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly pathName: string;

  constructor(input: {
    method: string;
    pathName: string;
    status: number;
    message: string;
  }) {
    super(`${input.method} ${input.pathName} failed (${input.status}): ${input.message}`);
    this.name = "ApiRequestError";
    this.status = input.status;
    this.method = input.method;
    this.pathName = input.pathName;
  }
}

export function shouldStopRetryingAgentWorkMutation(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 409);
}

async function apiRequest<T>(
  pathName: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
  } = {}
): Promise<T> {
  const response = await fetch(`${API_URL}${pathName}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new ApiRequestError({
      method: options.method ?? "GET",
      pathName,
      status: response.status,
      message,
    });
  }

  return (await response.json()) as T;
}

let registrationUsed = false;

async function registerAgent(
  docker: DockerApiClient,
  config: AgentRuntimeConfig
): Promise<{
  credentials: StoredCredentials;
  config: AgentRuntimeConfig;
}> {
  const snapshot = await collectValidationSnapshot(docker, config);
  const payload = await apiRequest<AgentRegistrationResponse>("/api/agent/register", {
    method: "POST",
    body: {
      serverId: SERVER_ID!,
      registrationToken: REGISTRATION_TOKEN,
      agentVersion: AGENT_VERSION,
      ...snapshot,
    },
  });

  const credentials = {
    serverId: SERVER_ID!,
    agentToken: payload.agentToken,
  };
  await writeCredentials(credentials);
  registrationUsed = true;

  return { credentials, config: payload.config };
}

async function sendHeartbeat(
  docker: DockerApiClient,
  credentials: StoredCredentials,
  config: AgentRuntimeConfig
): Promise<AgentRuntimeConfig> {
  const snapshot = await collectValidationSnapshot(docker, config);

  const response = await fetch(`${API_URL}/api/agent/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      serverId: SERVER_ID!,
      agentVersion: AGENT_VERSION,
      ...snapshot,
    }),
  });

  if (response.status === 401) {
    if (!REGISTRATION_TOKEN || registrationUsed) {
      throw new Error("Agent credentials were rejected. Reinstall the agent.");
    }

    const next = await registerAgent(docker, config);
    return next.config;
  }

  if (!response.ok) {
    throw new Error(`Heartbeat failed with status ${response.status}`);
  }

  const body = (await response.json()) as AgentHeartbeatResponse;
  return body.config;
}

function buildProjectNetwork(projectId: string): string {
  return `nouva-project-${hashProjectNetwork(projectId)}`;
}

function buildLabels(input: {
  kind: string;
  projectId?: string | null;
  serviceId?: string | null;
  deploymentId?: string | null;
  serviceVariant?: string | null;
}): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.server.id": SERVER_ID!,
    "nouva.kind": input.kind,
    ...(input.projectId ? { "nouva.project.id": input.projectId } : {}),
    ...(input.serviceId ? { "nouva.service.id": input.serviceId } : {}),
    ...(input.deploymentId ? { "nouva.deployment.id": input.deploymentId } : {}),
    ...(input.serviceVariant ? { "nouva.service.variant": input.serviceVariant } : {}),
  };
}

function getTraefikRuntimeInput(config: AgentRuntimeConfig): TraefikRuntimeInput {
  return {
    dataDir: DATA_DIR,
    dataVolume: DATA_VOLUME,
    containerName: TRAEFIK_CONTAINER_NAME,
    networkName: config.localTraefikNetwork,
    serverId: SERVER_ID!,
    image: TRAEFIK_IMAGE,
    acmeEmail: process.env.NOUVA_AGENT_TRAEFIK_ACME_EMAIL ?? null,
  };
}

function resolveBuildkitPort(address: string): number {
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== "tcp:") {
      throw new Error("unsupported protocol");
    }

    const port = Number.parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("invalid port");
    }

    return port;
  } catch {
    return DEFAULT_BUILDKIT_PORT;
  }
}

function buildScopedBuildkitContainerName(deploymentId: string): string {
  const sanitized = deploymentId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  const suffix = sanitized.slice(0, 24) || "build";
  return `nouva-buildkitd-${suffix}`;
}

function createBuildkitAddress(port: number): string {
  return `tcp://127.0.0.1:${port}`;
}

async function allocateAvailableLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("Failed to allocate a local TCP port for BuildKit"));
        return;
      }

      server.close((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function waitForBuildkitAvailability(address: string, timeoutMs = 15_000): Promise<void> {
  const port = resolveBuildkitPort(address);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkTcpConnect("127.0.0.1", port, 500)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`BuildKit did not become ready at ${address} within ${timeoutMs}ms`);
}

function buildBuildkitContainerSpec(options: {
  name: string;
  port: number;
  resourceLimits: ServiceResourceLimits | null;
  restartPolicyName: "no" | "unless-stopped";
  deploymentId?: string | null;
}): DockerContainerSpec {
  return {
    name: options.name,
    image: BUILDKIT_IMAGE,
    cmd: ["--addr", `tcp://0.0.0.0:${options.port}`],
    labels: buildLabels({
      kind: "buildkit",
      deploymentId: options.deploymentId ?? null,
    }),
    hostConfig: {
      Privileged: true,
      NetworkMode: "host",
      RestartPolicy: {
        Name: options.restartPolicyName,
      },
      ...toDockerResourceSettings(options.resourceLimits),
    },
  };
}

export interface PreparedAppBuildkitRuntime {
  address: string;
  cleanup: () => Promise<void>;
}

export async function prepareAppBuildkitRuntime(
  docker: Pick<DockerApiClient, "ensureContainer" | "removeContainer">,
  payload: Pick<AppDeployPayload, "deploymentId" | "resourceLimits">,
  options: {
    sharedAddress?: string;
    allocatePort?: () => Promise<number>;
    waitUntilReady?: (address: string) => Promise<void>;
  } = {}
): Promise<PreparedAppBuildkitRuntime> {
  const sharedAddress = options.sharedAddress ?? BUILDKIT_ADDRESS;
  if (!payload.resourceLimits) {
    return {
      address: sharedAddress,
      cleanup: async () => {},
    };
  }

  const port = await (options.allocatePort ?? allocateAvailableLocalPort)();
  const containerName = buildScopedBuildkitContainerName(payload.deploymentId);
  const address = createBuildkitAddress(port);

  try {
    await docker.ensureContainer(
      buildBuildkitContainerSpec({
        name: containerName,
        port,
        resourceLimits: payload.resourceLimits,
        restartPolicyName: "no",
        deploymentId: payload.deploymentId,
      }),
      true
    );
    await (options.waitUntilReady ?? waitForBuildkitAvailability)(address);
  } catch (error) {
    await docker.removeContainer(containerName, true);
    throw error;
  }

  return {
    address,
    cleanup: async () => {
      await docker.removeContainer(containerName, true);
    },
  };
}

type ManagedContainerRecord = Awaited<ReturnType<DockerApiClient["listManagedContainers"]>>[number];

export interface RuntimeLogCursor {
  lastTimestampMs: number;
  recentSignatures: string[];
  nextOffset: number;
}

interface ManagedRuntimeContainer {
  id: string;
  serviceId: string;
  deploymentId: string | null;
  containerName: string | null;
}

function createRuntimeLogCursor(): RuntimeLogCursor {
  return {
    lastTimestampMs: 0,
    recentSignatures: [],
    nextOffset: 0,
  };
}

function toManagedRuntimeContainer(
  container: ManagedContainerRecord
): ManagedRuntimeContainer | null {
  const labels = container.Labels ?? {};
  const kind = labels["nouva.kind"];
  if (kind !== "app" && kind !== "database") {
    return null;
  }

  const serviceId = labels["nouva.service.id"];
  if (!serviceId) {
    return null;
  }

  return {
    id: container.Id,
    serviceId,
    deploymentId: labels["nouva.deployment.id"] ?? null,
    containerName: container.Names?.[0]?.replace(/^\//, "") ?? null,
  };
}

export function normalizeRuntimeLogEntries(
  entries: DockerLogEntry[],
  cursor: RuntimeLogCursor | null
): { entries: RuntimeLogMessage[]; cursor: RuntimeLogCursor } {
  const nextCursor = cursor ?? createRuntimeLogCursor();
  const recentSignatures = [...nextCursor.recentSignatures];
  const recentSignatureSet = new Set(recentSignatures);
  let lastTimestampMs = nextCursor.lastTimestampMs;
  let nextOffset = nextCursor.nextOffset;
  const normalized: RuntimeLogMessage[] = [];

  for (const entry of entries) {
    const parsedTimestamp = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    const timestamp = Number.isFinite(parsedTimestamp)
      ? parsedTimestamp
      : lastTimestampMs || Date.now();
    const signature = `${timestamp}:${entry.type}:${entry.line}`;

    if (timestamp < lastTimestampMs) {
      continue;
    }

    if (timestamp > lastTimestampMs) {
      lastTimestampMs = timestamp;
      recentSignatures.length = 0;
      recentSignatureSet.clear();
    }

    if (recentSignatureSet.has(signature)) {
      continue;
    }

    recentSignatures.push(signature);
    recentSignatureSet.add(signature);
    if (recentSignatures.length > 200) {
      const removed = recentSignatures.shift();
      if (removed) {
        recentSignatureSet.delete(removed);
      }
    }

    normalized.push({
      type: entry.type,
      line: entry.line,
      timestamp,
      offset: nextOffset,
    });
    nextOffset += 1;
  }

  return {
    entries: normalized,
    cursor: {
      lastTimestampMs,
      recentSignatures,
      nextOffset,
    },
  };
}

type PgBackrestInfoBackup = {
  label: string;
  type: "full" | "diff" | "incr";
  stopAt: string | null;
  annotationBackupId: string | null;
};

function parsePgBackrestInfo(raw: string): PgBackrestInfoBackup[] {
  const decoded = JSON.parse(raw) as unknown;
  if (!Array.isArray(decoded) || decoded.length === 0) {
    return [];
  }

  const stanza = decoded[0];
  const backups =
    stanza && typeof stanza === "object" && "backup" in stanza && Array.isArray(stanza.backup)
      ? stanza.backup
      : [];

  return backups
    .map((entry: unknown): PgBackrestInfoBackup | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const label = "label" in entry && typeof entry.label === "string" ? entry.label : null;
      const type = "type" in entry && typeof entry.type === "string" ? entry.type : null;
      if (!label || (type !== "full" && type !== "diff" && type !== "incr")) {
        return null;
      }

      const stopTimestamp =
        "timestamp" in entry &&
        entry.timestamp &&
        typeof entry.timestamp === "object" &&
        "stop" in entry.timestamp &&
        typeof entry.timestamp.stop === "number"
          ? entry.timestamp.stop
          : null;
      const annotationBackupId =
        "annotation" in entry &&
        entry.annotation &&
        typeof entry.annotation === "object" &&
        "nouva-backup-id" in entry.annotation &&
        typeof entry.annotation["nouva-backup-id"] === "string"
          ? entry.annotation["nouva-backup-id"]
          : null;

      return {
        label,
        type,
        stopAt: stopTimestamp ? new Date(stopTimestamp * 1000).toISOString() : null,
        annotationBackupId,
      };
    })
    .filter((entry: PgBackrestInfoBackup | null): entry is PgBackrestInfoBackup => entry !== null);
}

function selectCurrentPgBackrestEntry(
  entries: PgBackrestInfoBackup[],
  backupId: string,
  backupType: "full" | "incr"
): PgBackrestInfoBackup | null {
  const byAnnotation = entries.find((entry) => entry.annotationBackupId === backupId);
  if (byAnnotation) {
    return byAnnotation;
  }

  const byType = entries.find((entry) => entry.type === backupType);
  if (byType) {
    return byType;
  }

  return entries[0] ?? null;
}

function extractPrefixedLogLine(logs: string, prefix: string): string | null {
  const lines = logs.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }

  return null;
}

async function runTaskContainer(
  docker: DockerApiClient,
  options: {
    name: string;
    image: string;
    env?: string[];
    cmd: string[];
    mounts?: Array<{ source: string; target: string }>;
    timeoutMs?: number;
  }
): Promise<{ logs: string }> {
  await docker.pullImage(options.image);
  await docker.removeContainer(options.name, true);

  const id = await docker.createContainer({
    name: options.name,
    image: options.image,
    env: options.env,
    cmd: options.cmd,
    tty: true,
    labels: buildLabels({ kind: "task" }),
    hostConfig: {
      AutoRemove: false,
      Mounts: options.mounts?.map((mount) => ({
        Type: "volume",
        Source: mount.source,
        Target: mount.target,
      })),
    },
  });

  try {
    await docker.startContainer(id);
    const statusCode = await docker.waitContainer(id, options.timeoutMs);
    const logs = await docker.containerLogs(id).catch(() => "");
    if (statusCode !== 0) {
      throw new Error(logs.trim() || `Task container ${options.name} failed (${statusCode})`);
    }

    return { logs };
  } finally {
    await docker.removeContainer(id, true);
  }
}

function buildArchiveRemoteExpression(verifyTls: boolean): string {
  return [
    ":s3",
    "provider=Other",
    "env_auth=false",
    `access_key_id=\${BACKUP_ACCESS_KEY_ID}`,
    `secret_access_key=\${BACKUP_SECRET_ACCESS_KEY}`,
    `endpoint=\${BACKUP_ENDPOINT}`,
    `region=\${BACKUP_REGION}`,
    `force_path_style=\${BACKUP_FORCE_PATH_STYLE}`,
    `insecure_skip_verify=${verifyTls ? "false" : "true"}`,
    `no_check_bucket=true:\${BACKUP_BUCKET}/\${BACKUP_OBJECT_KEY}`,
  ].join(",");
}

async function ensureBaseRuntime(
  docker: DockerApiClient,
  config: AgentRuntimeConfig
): Promise<void> {
  await ensureTraefikRuntime(docker, getTraefikRuntimeInput(config));

  await docker.ensureContainer({
    name: LOCAL_REGISTRY_CONTAINER_NAME,
    image: "registry:2",
    labels: buildLabels({ kind: "registry" }),
    exposedPorts: {
      "5000/tcp": {},
    },
    hostConfig: {
      PortBindings: {
        "5000/tcp": [
          {
            HostIp: "127.0.0.1",
            HostPort: String(config.localRegistryPort),
          },
        ],
      },
      RestartPolicy: {
        Name: "unless-stopped",
      },
    },
  });

  const existingBuildkit = await docker.inspectContainer(BUILDKIT_CONTAINER_NAME);
  if (existingBuildkit?.HostConfig?.NetworkMode !== "host") {
    await docker.removeContainer(BUILDKIT_CONTAINER_NAME, true);
  }

  await docker.ensureContainer({
    ...buildBuildkitContainerSpec({
      name: BUILDKIT_CONTAINER_NAME,
      port: resolveBuildkitPort(BUILDKIT_ADDRESS),
      resourceLimits: null,
      restartPolicyName: "unless-stopped",
    }),
  });
}

function resolveAppPort(
  payloadEnvVars: Record<string, string>,
  metadataPort: number | null
): number {
  const envPort = Number(payloadEnvVars.PORT);
  if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) {
    return envPort;
  }

  if (
    metadataPort &&
    Number.isInteger(metadataPort) &&
    metadataPort >= 1 &&
    metadataPort <= 65535
  ) {
    return metadataPort;
  }

  return 3000;
}

export function buildAppContainerSpec(
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput
): {
  containerName: string;
  appPort: number;
  spec: DockerContainerSpec;
} {
  const containerName = `nouva-app-${payload.serviceId.slice(0, 8)}-${payload.deploymentId.slice(0, 8)}`;
  const appPort = resolveAppPort(payload.envVars, payload.internalPort ?? null);

  return {
    containerName,
    appPort,
    spec: {
      name: containerName,
      image: payload.imageUrl,
      env: Object.entries(payload.envVars).map(([key, value]) => `${key}=${value}`),
      labels: buildLabels({
        kind: "app",
        projectId: payload.projectId,
        serviceId: payload.serviceId,
        deploymentId: payload.deploymentId,
      }),
      hostConfig: {
        ...(payload.volume
          ? {
              Mounts: [
                {
                  Type: "volume",
                  Source: payload.volume.volumeName,
                  Target: payload.volume.mountPath,
                },
              ],
            }
          : {}),
        RestartPolicy: {
          Name: "unless-stopped",
        },
        ...toDockerResourceSettings(payload.resourceLimits),
      },
      networkingConfig: {
        EndpointsConfig: {
          [config.localTraefikNetwork]: {},
        },
      },
    },
  };
}

export async function deployAppImageWithDependencies(
  dependencies: DeployAppImageDependencies,
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput
) {
  await dependencies.ensureBaseRuntime(docker, config);

  const projectNetwork = buildProjectNetwork(payload.projectId);
  await docker.ensureNetwork(projectNetwork);

  const previousContainer =
    payload.runtimeMetadata?.containerName ?? payload.runtimeMetadata?.containerId ?? null;
  const { containerName, appPort, spec } = buildAppContainerSpec(config, payload);
  const previousServiceUrl = previousContainer
    ? `http://${previousContainer}:${resolveAppRuntimePort(payload.runtimeMetadata, appPort)}`
    : null;
  const rollout = resolveAppRolloutConfig(payload.rollout);

  if (payload.volume && rollout.blockSharedVolumes) {
    throw new AppRolloutError(
      "Safe app rollouts are blocked for services with attached volumes until single-writer support exists",
      buildAppRolloutResult({
        outcome: "aborted_before_cutover",
        currentPhase: "candidate",
        liveRuntimePreserved: Boolean(previousContainer),
        rollbackCompleted: false,
        activeContainerName: previousContainer,
        candidateContainerName: containerName,
      })
    );
  }

  if (payload.volume) {
    await docker.createVolume(payload.volume.volumeName);
  }

  const containerId = await docker.ensureContainer(spec, true);
  await docker.connectNetwork(projectNetwork, containerId).catch((err: Error) => {
    console.error(
      `[nouva-agent] connectNetwork failed for service ${payload.serviceId}: ${err.message}`
    );
  });

  try {
    await waitForAppCandidateReadiness(dependencies, docker, containerName, appPort, rollout);
  } catch (error) {
    await docker.removeContainer(containerName, true);
    throw new AppRolloutError(
      error instanceof Error ? error.message : "Candidate container failed readiness checks",
      buildAppRolloutResult({
        outcome: "aborted_before_cutover",
        currentPhase: "ready",
        liveRuntimePreserved: Boolean(previousContainer),
        rollbackCompleted: false,
        activeContainerName: previousContainer,
        candidateContainerName: containerName,
      })
    );
  }

  const hostnames = [`${payload.subdomain}.${APP_DOMAIN}`];
  const candidateServiceUrl = `http://${containerName}:${appPort}`;
  try {
    await dependencies.writeLocalTraefikRoute(
      TRAEFIK_PATHS,
      payload.serviceId,
      hostnames,
      candidateServiceUrl
    );
    await waitForLocalTraefikCutover(
      dependencies.fetchImpl,
      payload.serviceId,
      candidateServiceUrl,
      rollout
    );
  } catch (error) {
    if (previousServiceUrl) {
      await dependencies.writeLocalTraefikRoute(
        TRAEFIK_PATHS,
        payload.serviceId,
        hostnames,
        previousServiceUrl
      );
      try {
        await waitForLocalTraefikCutover(
          dependencies.fetchImpl,
          payload.serviceId,
          previousServiceUrl,
          rollout
        );
      } catch {}
    } else {
      await dependencies.deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
    }

    await docker.removeContainer(containerName, true);

    throw new AppRolloutError(
      error instanceof Error ? error.message : "Traefik cutover failed",
      buildAppRolloutResult({
        outcome: "rolled_back",
        currentPhase: "rollback",
        liveRuntimePreserved: Boolean(previousContainer),
        rollbackCompleted: true,
        activeContainerName: previousContainer,
        candidateContainerName: containerName,
      })
    );
  }

  if (previousContainer) {
    await docker.removeContainer(previousContainer, true);
  }

  return {
    imageUrl: payload.imageUrl,
    buildDuration: payload.buildDuration ?? null,
    detectedLanguage: payload.detectedLanguage ?? null,
    detectedFramework: payload.detectedFramework ?? null,
    languageVersion: payload.languageVersion ?? null,
    internalHost: containerName,
    internalPort: appPort,
    externalHost: `${payload.subdomain}.${APP_DOMAIN}`,
    runtimeMetadata: {
      containerId,
      containerName,
      image: payload.imageUrl,
      ingressHost: `${payload.subdomain}.${APP_DOMAIN}`,
      ingressPort: 80,
      internalPort: appPort,
    },
    rollout: buildAppRolloutResult({
      outcome: "committed",
      currentPhase: "retire",
      liveRuntimePreserved: false,
      rollbackCompleted: false,
      activeContainerName: containerName,
      candidateContainerName: containerName,
    }),
    runtimeInstance: {
      kind: "app",
      status: "running",
      name: containerName,
      image: payload.imageUrl,
      containerId,
      containerName,
      networkName: projectNetwork,
      internalHost: containerName,
      internalPort: appPort,
      externalHost: `${payload.subdomain}.${APP_DOMAIN}`,
      externalPort: 80,
    },
  };
}

export async function deployAppImage(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployAppImageInput
) {
  return await deployAppImageWithDependencies(
    defaultDeployAppImageDependencies,
    docker,
    config,
    payload
  );
}

async function handleBuildAndDeployApp(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: AppDeployPayload
) {
  const dependencies = {
    ensureBaseRuntime,
    buildApp,
    deployAppImage,
  };

  const buildkitRuntime = await prepareAppBuildkitRuntime(docker, payload);

  try {
    return await buildAndDeployAppWithDependencies(
      dependencies,
      docker,
      config,
      payload,
      buildkitRuntime.address
    );
  } finally {
    await buildkitRuntime.cleanup();
  }
}

async function handleDeployOnlyApp(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: DeployOnlyPayload
) {
  return await deployAppImage(docker, config, {
    ...payload,
    serviceName: payload.serviceId,
  });
}

function getManagedVolumeName(payload: DatabaseProvisionPayload | DeleteVolumePayload): string {
  return payload.volumeName;
}

function getDatabaseContainerName(payload: DatabaseProvisionPayload): string {
  return `nouva-${payload.variant}-${payload.serviceId.slice(0, 12)}`;
}

export function buildDatabaseContainerSpec(payload: DatabaseProvisionPayload): {
  projectNetwork: string;
  resolved: ReturnType<typeof resolveDatabaseProvisionSpec>;
  volumeName: string;
  containerName: string;
  spec: DockerContainerSpec;
} {
  const projectNetwork = buildProjectNetwork(payload.projectId);
  const resolved = resolveDatabaseProvisionSpec(payload);
  const volumeName = getManagedVolumeName(payload);
  const containerName = getDatabaseContainerName(payload);

  const hostConfig: Record<string, unknown> = {
    Mounts: [
      {
        Type: "volume",
        Source: volumeName,
        Target: resolved.dataPath,
      },
    ],
    RestartPolicy: {
      Name: "unless-stopped",
    },
    ...toDockerResourceSettings(payload.resourceLimits),
  };

  if (payload.publicAccessEnabled && payload.externalPort) {
    hostConfig.PortBindings = {
      [`${resolved.internalPort}/tcp`]: [
        {
          HostIp: "0.0.0.0",
          HostPort: String(payload.externalPort),
        },
      ],
    };
  }

  return {
    projectNetwork,
    resolved,
    volumeName,
    containerName,
    spec: {
      name: containerName,
      image: resolved.image,
      env: Object.entries(resolved.envVars).map(([key, value]) => `${key}=${value}`),
      cmd: resolved.containerArgs.length > 0 ? resolved.containerArgs : undefined,
      labels: buildLabels({
        kind: "database",
        projectId: payload.projectId,
        serviceId: payload.serviceId,
        serviceVariant: payload.variant,
      }),
      exposedPorts: {
        [`${resolved.internalPort}/tcp`]: {},
      },
      hostConfig,
      networkingConfig: {
        EndpointsConfig: {
          [projectNetwork]: {},
        },
      },
    },
  };
}

function isAttachedDatabaseVolumePayload(
  payload:
    | DeleteVolumePayload
    | (DatabaseProvisionPayload & { runtimeMetadata?: RuntimeMetadata | null })
): payload is DatabaseProvisionPayload & {
  runtimeMetadata?: RuntimeMetadata | null;
} {
  return typeof (payload as DatabaseProvisionPayload).serviceId === "string";
}

async function deployDatabaseContainer(docker: DockerApiClient, payload: DatabaseProvisionPayload) {
  const { projectNetwork, resolved, volumeName, containerName, spec } =
    buildDatabaseContainerSpec(payload);
  await docker.ensureNetwork(projectNetwork);
  await docker.createVolume(volumeName);
  const containerId = await docker.ensureContainer(spec, true);

  return {
    projectNetwork,
    resolved,
    volumeName,
    containerName,
    containerId,
  };
}

export async function handleDatabaseProvision(
  docker: DockerApiClient,
  payload: DatabaseProvisionPayload
) {
  const { projectNetwork, resolved, volumeName, containerName, containerId } =
    await deployDatabaseContainer(docker, payload);

  return {
    internalHost: containerName,
    internalPort: resolved.internalPort,
    externalHost: payload.publicAccessEnabled ? payload.externalHost : null,
    externalPort: payload.publicAccessEnabled ? payload.externalPort : null,
    runtimeMetadata: {
      containerId,
      containerName,
      image: resolved.image,
      publishedPort: payload.publicAccessEnabled ? payload.externalPort : null,
      volumeName,
      mountPath: resolved.dataPath,
    },
    runtimeInstance: {
      kind: "database",
      status: "running",
      name: containerName,
      image: resolved.image,
      containerId,
      containerName,
      networkName: projectNetwork,
      internalHost: containerName,
      internalPort: resolved.internalPort,
      externalHost: payload.publicAccessEnabled ? payload.externalHost : null,
      externalPort: payload.publicAccessEnabled ? payload.externalPort : null,
    },
  };
}

export async function handleApplyDatabaseVolume(
  docker: DockerApiClient,
  payload: DatabaseProvisionPayload & {
    runtimeMetadata?: RuntimeMetadata | null;
  }
) {
  const identifier = payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName;
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }

  return await handleDatabaseProvision(docker, payload);
}

async function handleDeleteVolume(docker: DockerApiClient, payload: DeleteVolumePayload) {
  await docker.removeVolume(getManagedVolumeName(payload), true);
  return {
    volumeName: payload.volumeName,
  };
}

async function handleWipeVolume(
  docker: DockerApiClient,
  payload:
    | DeleteVolumePayload
    | (DatabaseProvisionPayload & { runtimeMetadata?: RuntimeMetadata | null })
) {
  if (!isAttachedDatabaseVolumePayload(payload)) {
    await docker.removeVolume(getManagedVolumeName(payload), true);
    await docker.createVolume(payload.volumeName);
    return {
      volumeName: payload.volumeName,
    };
  }

  const identifier = payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName;
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }

  await docker.removeVolume(getManagedVolumeName(payload), true);

  return await handleDatabaseProvision(docker, payload);
}

async function handleCreateArchiveBackup(
  docker: DockerApiClient,
  payload: CreateVolumeBackupPayload
) {
  const remoteExpression = buildArchiveRemoteExpression(payload.destination.verifyTls);
  const { logs } = await runTaskContainer(docker, {
    name: `nouva-backup-${payload.backupId.slice(0, 12)}`,
    image: BACKUP_HELPER_IMAGE,
    env: [
      `BACKUP_ACCESS_KEY_ID=${payload.destination.accessKeyId}`,
      `BACKUP_SECRET_ACCESS_KEY=${payload.destination.secretAccessKey}`,
      `BACKUP_ENDPOINT=${payload.destination.endpoint}`,
      `BACKUP_REGION=${payload.destination.region}`,
      `BACKUP_BUCKET=${payload.destination.bucket}`,
      `BACKUP_OBJECT_KEY=archives/v1/projects/${payload.projectId}/volumes/${payload.volumeId}/backups/${payload.backupId}.tar.gz`,
      `BACKUP_FORCE_PATH_STYLE=${payload.destination.pathStyle ? "true" : "false"}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        `remote="${remoteExpression}"`,
        'archive="/tmp/nouva-volume-backup.tar.gz"',
        'tar -C /source -czf "$archive" .',
        'size_bytes=$(wc -c < "$archive" | tr -d " ")',
        'rclone copyto "$archive" "$remote"',
        'printf "NOUVA_SIZE_BYTES:%s\\n" "$size_bytes"',
      ].join("\n"),
    ],
    mounts: [{ source: payload.volumeName, target: "/source" }],
    timeoutMs: 30 * 60_000,
  });

  const sizeBytes = Number.parseInt(extractPrefixedLogLine(logs, "NOUVA_SIZE_BYTES:") ?? "", 10);
  return {
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
  };
}

async function handleDeleteArchiveBackup(
  docker: DockerApiClient,
  payload: DeleteVolumeBackupPayload
) {
  const remoteExpression = buildArchiveRemoteExpression(payload.destination.verifyTls);
  await runTaskContainer(docker, {
    name: `nouva-delete-backup-${payload.backupId.slice(0, 12)}`,
    image: BACKUP_HELPER_IMAGE,
    env: [
      `BACKUP_ACCESS_KEY_ID=${payload.destination.accessKeyId}`,
      `BACKUP_SECRET_ACCESS_KEY=${payload.destination.secretAccessKey}`,
      `BACKUP_ENDPOINT=${payload.destination.endpoint}`,
      `BACKUP_REGION=${payload.destination.region}`,
      `BACKUP_BUCKET=${payload.destination.bucket}`,
      `BACKUP_OBJECT_KEY=archives/v1/projects/${payload.projectId}/volumes/${payload.volumeId}/backups/${payload.backupId}.tar.gz`,
      `BACKUP_FORCE_PATH_STYLE=${payload.destination.pathStyle ? "true" : "false"}`,
    ],
    cmd: [
      "sh",
      "-c",
      ["set -eu", `remote="${remoteExpression}"`, 'rclone deletefile "$remote" || true'].join("\n"),
    ],
    timeoutMs: 10 * 60_000,
  });

  return {};
}

async function handleRestoreArchiveBackup(
  docker: DockerApiClient,
  payload: RestoreVolumeBackupPayload
) {
  const remoteExpression = buildArchiveRemoteExpression(payload.destination.verifyTls);
  await docker.createVolume(payload.targetVolumeName);
  await runTaskContainer(docker, {
    name: `nouva-restore-backup-${payload.backupId.slice(0, 12)}`,
    image: BACKUP_HELPER_IMAGE,
    env: [
      `BACKUP_ACCESS_KEY_ID=${payload.destination.accessKeyId}`,
      `BACKUP_SECRET_ACCESS_KEY=${payload.destination.secretAccessKey}`,
      `BACKUP_ENDPOINT=${payload.destination.endpoint}`,
      `BACKUP_REGION=${payload.destination.region}`,
      `BACKUP_BUCKET=${payload.destination.bucket}`,
      `BACKUP_OBJECT_KEY=archives/v1/projects/${payload.projectId}/volumes/${payload.sourceVolumeId}/backups/${payload.backupId}.tar.gz`,
      `BACKUP_FORCE_PATH_STYLE=${payload.destination.pathStyle ? "true" : "false"}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        `remote="${remoteExpression}"`,
        'archive="/tmp/nouva-volume-backup.tar.gz"',
        "mkdir -p /target",
        'rclone copyto "$remote" "$archive"',
        'tar -C /target -xzf "$archive"',
      ].join("\n"),
    ],
    mounts: [{ source: payload.targetVolumeName, target: "/target" }],
    timeoutMs: 30 * 60_000,
  });

  return {
    volumeName: payload.targetVolumeName,
  };
}

async function handleCreatePgBackrestBackup(
  docker: DockerApiClient,
  payload: CreateVolumeBackupPayload
) {
  const spec = resolveHydratedHelperSpec(payload);
  const { logs } = await runTaskContainer(docker, {
    name: `nouva-pgbackrest-backup-${payload.backupId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `NOUVA_BACKUP_ID=${payload.backupId}`,
      `NOUVA_PGBACKREST_BACKUP_TYPE=${payload.pgbackrestType ?? "full"}`,
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        'printf "%s\\n" "*:*:*:$POSTGRES_USER:$POSTGRES_PASSWORD" > /tmp/.pgpass',
        "chmod 0600 /tmp/.pgpass",
        "export PGPASSFILE=/tmp/.pgpass",
        'metadata_dir="$NOUVA_DATA_PATH/.nouva/pgbackrest"',
        'mkdir -p "$metadata_dir"',
        "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
        'pgbackrest --stanza="$PGBACKREST_STANZA" --type="$NOUVA_PGBACKREST_BACKUP_TYPE" --annotation="nouva-backup-id=$NOUVA_BACKUP_ID" --log-level-console=info backup',
        'if info_output=$(pgbackrest --stanza="$PGBACKREST_STANZA" --output=json info 2>/dev/null); then',
        `  printf 'NOUVA_PGBACKREST_INFO:%s\\n' "$(printf '%s' "$info_output" | tr -d '\\n')"`,
        "fi",
      ].join("\n"),
    ],
    mounts: [{ source: payload.volumeName, target: spec.dataPath }],
    timeoutMs: 30 * 60_000,
  });

  const rawInfo = extractPrefixedLogLine(logs, "NOUVA_PGBACKREST_INFO:");
  const entries = rawInfo ? parsePgBackrestInfo(rawInfo) : [];
  const selected = selectCurrentPgBackrestEntry(
    entries,
    payload.backupId,
    payload.pgbackrestType ?? "full"
  );

  return {
    completedAt: selected?.stopAt ?? null,
    pgbackrestType:
      selected?.type === "full" || selected?.type === "incr"
        ? selected.type
        : (payload.pgbackrestType ?? null),
    pgbackrestSet: selected?.label ?? null,
    activePgbackrestSets: entries.map((entry) => entry.label),
  };
}

async function handleRestorePgBackrestBackup(
  docker: DockerApiClient,
  payload: RestoreVolumeBackupPayload
) {
  if (!payload.backupCompletedAt) {
    throw new Error("Backup restore is missing backupCompletedAt");
  }

  const spec = resolveHydratedHelperSpec(payload);

  await docker.createVolume(payload.targetVolumeName);
  await runTaskContainer(docker, {
    name: `nouva-pgbackrest-restore-${payload.targetVolumeId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `RESTORE_TARGET=${payload.backupCompletedAt}`,
      `RESTORE_SET=${payload.pgbackrestSet ?? ""}`,
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        'mkdir -p "$NOUVA_DATA_PATH"',
        'chown -R 999:999 "$NOUVA_DATA_PATH" || true',
        "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
        `if [ -n "\${RESTORE_SET:-}" ]; then`,
        '  exec pgbackrest --stanza="$PGBACKREST_STANZA" --set="$RESTORE_SET" --delta --type=time --target="$RESTORE_TARGET" --target-action=promote --log-level-console=info restore',
        "fi",
        'exec pgbackrest --stanza="$PGBACKREST_STANZA" --delta --type=time --target="$RESTORE_TARGET" --target-action=promote --log-level-console=info restore',
      ].join("\n"),
    ],
    mounts: [{ source: payload.targetVolumeName, target: spec.dataPath }],
    timeoutMs: 30 * 60_000,
  });

  return {
    volumeName: payload.targetVolumeName,
  };
}

async function handleExpireVolumeBackupRepository(
  docker: DockerApiClient,
  payload: ExpireVolumeBackupRepositoryPayload
) {
  const { logs } = await runTaskContainer(docker, {
    name: `nouva-pgbackrest-expire-${payload.volumeId.slice(0, 12)}`,
    image: payload.imageUrl ?? "postgres:17",
    env: Object.entries(toRecord(payload.envVars)).map(([key, value]) => `${key}=${value}`),
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
        'pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info expire',
        'if info_output=$(pgbackrest --stanza="$PGBACKREST_STANZA" --output=json info 2>/dev/null); then',
        `  printf 'NOUVA_PGBACKREST_INFO:%s\\n' "$(printf '%s' "$info_output" | tr -d '\\n')"`,
        "fi",
      ].join("\n"),
    ],
    timeoutMs: 30 * 60_000,
  });

  const rawInfo = extractPrefixedLogLine(logs, "NOUVA_PGBACKREST_INFO:");
  const entries = rawInfo ? parsePgBackrestInfo(rawInfo) : [];
  return {
    activePgbackrestSets: entries.map((entry) => entry.label),
  };
}

async function handleCreateVolumeBackup(
  docker: DockerApiClient,
  payload: CreateVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return await handleCreatePgBackrestBackup(docker, payload);
  }

  return await handleCreateArchiveBackup(docker, payload);
}

async function handleDeleteVolumeBackup(
  docker: DockerApiClient,
  payload: DeleteVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return {};
  }

  return await handleDeleteArchiveBackup(docker, payload);
}

async function handleRestoreVolumeBackup(
  docker: DockerApiClient,
  payload: RestoreVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return await handleRestorePgBackrestBackup(docker, payload);
  }

  return await handleRestoreArchiveBackup(docker, payload);
}

export async function handleRestorePostgresPitr(
  docker: DockerApiClient,
  payload: RestorePostgresPitrPayload
) {
  const spec = resolveDatabaseProvisionSpec(payload);
  await runTaskContainer(docker, {
    name: `nouva-pgbackrest-pitr-${payload.serviceId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `RESTORE_TARGET=${payload.restoreTarget}`,
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
        'pgbackrest --stanza="$PGBACKREST_STANZA" --delta --type=time --target="$RESTORE_TARGET" --target-action=promote --log-level-console=info restore',
      ].join("\n"),
    ],
    mounts: [{ source: payload.volumeName, target: spec.dataPath }],
    timeoutMs: 30 * 60_000,
  });

  return {
    statusMessage: "PITR restore ready to apply",
  };
}

async function handleRestart(docker: DockerApiClient, payload: RestartServicePayload) {
  const identifier = resolveServiceContainerIdentifier(payload);
  if (!identifier) {
    throw new Error("Missing container identifier for restart");
  }

  await docker.restartContainer(identifier);
  return {
    runtimeMetadata: {
      ...(payload.runtimeMetadata ?? {}),
      containerName: payload.containerName ?? payload.runtimeMetadata?.containerName ?? null,
    },
  };
}

export function resolveServiceContainerIdentifier(input: {
  containerName?: string | null;
  runtimeMetadata?: RuntimeMetadata | null;
}): string | null {
  return (
    input.containerName ??
    input.runtimeMetadata?.containerId ??
    input.runtimeMetadata?.containerName ??
    null
  );
}

async function handleRemove(
  docker: DockerApiClient,
  serviceId: string,
  runtimeMetadata: RuntimeMetadata | null
) {
  const identifier = runtimeMetadata?.containerId ?? runtimeMetadata?.containerName;
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }
  await deleteLocalTraefikRoute(TRAEFIK_PATHS, serviceId);
  return {
    runtimeInstance: {
      kind: "app",
      status: "removed",
      containerId: runtimeMetadata?.containerId ?? null,
      containerName: runtimeMetadata?.containerName ?? null,
    },
  };
}

async function handleDeleteService(docker: DockerApiClient, payload: RemoveServicePayload) {
  const identifier = resolveServiceContainerIdentifier(payload);
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }

  await deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
  return {
    runtimeInstance: {
      kind: payload.serviceType === "app" ? "app" : "database",
      status: "removed",
      containerId: payload.runtimeMetadata?.containerId ?? null,
      containerName: identifier,
    },
  };
}

async function handleSyncRouting(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  payload: SyncRoutingPayload & { runtimeMetadata?: RuntimeMetadata | null }
) {
  const runtimeMetadata = payload.runtimeMetadata ?? null;
  const containerName = runtimeMetadata?.containerName;
  if (!containerName) {
    throw new Error("Missing runtime metadata for routing sync");
  }

  await ensureTraefikRuntime(docker, getTraefikRuntimeInput(config));

  const hostnames = [
    ...(payload.providedHostname ? [payload.providedHostname] : []),
    ...payload.customHostnames,
  ];
  const internalPort =
    typeof runtimeMetadata.internalPort === "number"
      ? runtimeMetadata.internalPort
      : (payload.ingressPort ?? 3000);

  if (hostnames.length === 0) {
    await deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
  } else {
    await writeLocalTraefikRoute(
      TRAEFIK_PATHS,
      payload.serviceId,
      hostnames,
      `http://${containerName}:${internalPort}`
    );
  }
  return {
    runtimeMetadata: {
      ...runtimeMetadata,
      configVersion:
        typeof runtimeMetadata.configVersion === "number" ? runtimeMetadata.configVersion + 1 : 1,
    },
  };
}

async function handleUpdateAgent(
  docker: DockerApiClient,
  payload: ReturnType<typeof toUpdateAgentPayload>
): Promise<Record<string, unknown>> {
  const imageRef = resolveUpdateAgentImageRef(payload);

  // Pull the new image before anything else
  await docker.pullImage(imageRef);

  const { updaterEnv, envInheritFlags } = buildUpdateAgentRuntimeEnv(process.env, imageRef);

  // Build the shell command that runs AFTER we report success
  const updateCmd = [
    "sleep 5",
    "docker stop nouva-agent || true",
    "docker rm nouva-agent || true",
    `docker run -d --name nouva-agent --restart unless-stopped --network host` +
      ` -v /var/run/docker.sock:/var/run/docker.sock -v /:/hostfs:ro` +
      ` -v "$NOUVA_AGENT_DATA_VOLUME:/var/lib/nouva-agent"` +
      ` ${envInheritFlags} "$NOUVA_AGENT_TARGET_IMAGE"`,
  ].join(" && ");

  // Spawn ephemeral updater (auto-removed), fires after we return
  await docker.ensureContainer(
    {
      name: "nouva-agent-updater",
      image: "docker:cli",
      cmd: ["sh", "-c", updateCmd],
      env: updaterEnv,
      hostConfig: {
        AutoRemove: true,
        NetworkMode: "host",
        Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      },
    },
    true // replace any previous updater
  );

  return {
    scheduled: true,
    imageRef,
    ...(payload.releaseId ? { releaseId: payload.releaseId } : {}),
    ...(payload.version ? { version: payload.version } : {}),
    scheduledAt: new Date().toISOString(),
  };
}

async function processWorkItem(
  docker: DockerApiClient,
  config: AgentRuntimeConfig,
  credentials: StoredCredentials,
  workItem: AgentWorkRecord
) {
  console.log(`[nouva-agent] processing work ${workItem.id} (${workItem.kind})`);
  const payload = toObject(workItem.payload);

  let result: Record<string, unknown> | undefined;
  let failureResult: Record<string, unknown> | undefined;
  let workError: Error | null = null;

  try {
    switch (workItem.kind) {
      case "deploy_app":
      case "redeploy_app":
        result = await handleBuildAndDeployApp(
          docker,
          config,
          payload as unknown as AppDeployPayload
        );
        break;
      case "rollback_app":
        result = await handleDeployOnlyApp(docker, config, payload as unknown as DeployOnlyPayload);
        break;
      case "restart_app":
      case "restart_database":
        result = await handleRestart(docker, {
          ...(payload as unknown as RestartServicePayload),
          runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
        });
        break;
      case "remove_app":
        result = await handleRemove(
          docker,
          String(payload.serviceId),
          toRuntimeMetadata(payload.runtimeMetadata)
        );
        break;
      case "provision_database":
        result = await handleDatabaseProvision(
          docker,
          payload as unknown as DatabaseProvisionPayload
        );
        break;
      case "apply_database_volume":
        result = await handleApplyDatabaseVolume(docker, {
          ...(payload as unknown as DatabaseProvisionPayload),
          runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
        });
        break;
      case "delete_service":
        result = await handleDeleteService(docker, {
          ...(payload as unknown as RemoveServicePayload),
          runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
        });
        break;
      case "delete_volume":
        result = await handleDeleteVolume(docker, payload as unknown as DeleteVolumePayload);
        break;
      case "wipe_volume":
        result = await handleWipeVolume(
          docker,
          "serviceId" in payload
            ? {
                ...(payload as unknown as DatabaseProvisionPayload),
                runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
              }
            : (payload as unknown as DeleteVolumePayload)
        );
        break;
      case "create_volume_backup":
        result = await handleCreateVolumeBackup(
          docker,
          payload as unknown as CreateVolumeBackupPayload
        );
        break;
      case "delete_volume_backup":
        result = await handleDeleteVolumeBackup(
          docker,
          payload as unknown as DeleteVolumeBackupPayload
        );
        break;
      case "restore_volume_backup":
        result = await handleRestoreVolumeBackup(
          docker,
          payload as unknown as RestoreVolumeBackupPayload
        );
        break;
      case "restore_postgres_pitr":
        result = await handleRestorePostgresPitr(
          docker,
          payload as unknown as RestorePostgresPitrPayload
        );
        break;
      case "expire_volume_backup_repository":
        result = await handleExpireVolumeBackupRepository(
          docker,
          payload as unknown as ExpireVolumeBackupRepositoryPayload
        );
        break;
      case "sync_routing":
        result = await handleSyncRouting(docker, config, {
          ...(payload as unknown as SyncRoutingPayload),
          runtimeMetadata: toRuntimeMetadata(payload.runtimeMetadata),
        });
        break;
      case "update_agent":
        result = await handleUpdateAgent(docker, toUpdateAgentPayload(payload));
        break;
      default:
        throw new Error(`Unsupported work kind: ${workItem.kind}`);
    }
  } catch (err) {
    if (err instanceof AppRolloutError) {
      failureResult = err.result;
    }
    workError = err instanceof Error ? err : new Error("Unknown agent work failure");
  }

  if (workError) {
    try {
      await apiRequest(`/api/agent/work/${workItem.id}/fail`, {
        method: "POST",
        token: credentials.agentToken,
        body: {
          serverId: SERVER_ID!,
          leaseId: workItem.leaseId,
          result: failureResult ?? null,
          errorMessage: workError.message,
        },
      });
    } catch (reportErr) {
      if (shouldStopRetryingAgentWorkMutation(reportErr)) {
        console.warn(
          `[nouva-agent] failure report for work ${workItem.id} was already superseded:`,
          reportErr
        );
        return;
      }
      console.error(`[nouva-agent] failed to report failure for work ${workItem.id}:`, reportErr);
    }
    return;
  }

  try {
    await apiRequest(`/api/agent/work/${workItem.id}/complete`, {
      method: "POST",
      token: credentials.agentToken,
      body: {
        serverId: SERVER_ID!,
        leaseId: workItem.leaseId,
        result: result!,
      },
    });
    console.log(`[nouva-agent] work ${workItem.id} (${workItem.kind}) completed`);
  } catch (reportErr) {
    if (shouldStopRetryingAgentWorkMutation(reportErr)) {
      console.warn(
        `[nouva-agent] completion report for work ${workItem.id} was already superseded:`,
        reportErr
      );
      return;
    }
    // Work succeeded locally. Don't call /fail — let lease expire so the item can be retried.
    console.error(`[nouva-agent] work ${workItem.id} succeeded but /complete failed:`, reportErr);
  }
}

async function collectMetrics(docker: DockerApiClient): Promise<AgentMetricsEnvelope> {
  const [currentCpuStat, previousCpuStat, meminfo, loadavg] = await Promise.all([
    readFile("/hostfs/proc/stat", "utf8"),
    readFile(path.join(DATA_DIR, "last-cpu-stat"), "utf8").catch(() => ""),
    readFile("/hostfs/proc/meminfo", "utf8"),
    readFile("/hostfs/proc/loadavg", "utf8").catch(() => ""),
  ]);

  const stats = await statfs("/hostfs");
  const serverMetrics = parseHostMetricsSnapshot({
    currentCpuStat,
    previousCpuStat,
    meminfo,
    loadavg,
    diskAvailableBytes: Number(stats.bavail) * Number(stats.bsize),
    diskTotalBytes: Number(stats.blocks) * Number(stats.bsize),
  });
  await writeFile(path.join(DATA_DIR, "last-cpu-stat"), currentCpuStat);

  const containers = await docker.listManagedContainers();
  const services = [];
  for (const container of containers) {
    if (container.State !== "running") {
      continue;
    }

    const labels = container.Labels ?? {};
    const serviceId = labels["nouva.service.id"];
    if (!serviceId) {
      continue;
    }

    const parsed = await docker.containerStats(container.Id);
    services.push({
      serviceId,
      deploymentId: labels["nouva.deployment.id"] ?? null,
      runtimeInstanceId: null,
      ...parsed,
      raw: null,
      collectedAt: new Date().toISOString(),
    });
  }

  return {
    server: serverMetrics,
    services,
  };
}

async function syncRuntimeLogs(
  docker: DockerApiClient,
  credentials: StoredCredentials,
  cursors: Map<string, RuntimeLogCursor>
): Promise<number> {
  const containers = (await docker.listManagedContainers())
    .map((container) => toManagedRuntimeContainer(container))
    .filter((container): container is ManagedRuntimeContainer => container !== null);

  const activeContainerIds = new Set(containers.map((container) => container.id));
  for (const containerId of cursors.keys()) {
    if (!activeContainerIds.has(containerId)) {
      cursors.delete(containerId);
    }
  }

  const batches: AgentRuntimeLogBatch[] = [];

  for (const container of containers) {
    try {
      const cursor = cursors.get(container.id) ?? createRuntimeLogCursor();
      const entries = await docker.containerLogEntries(container.id, {
        stdout: true,
        stderr: true,
        timestamps: true,
        tail: cursor.nextOffset === 0 ? 200 : 500,
        since:
          cursor.lastTimestampMs > 0 ? new Date(Math.max(0, cursor.lastTimestampMs - 1000)) : null,
      });

      const normalized = normalizeRuntimeLogEntries(entries, cursor);
      cursors.set(container.id, normalized.cursor);

      if (normalized.entries.length === 0) {
        continue;
      }

      batches.push({
        serviceId: container.serviceId,
        deploymentId: container.deploymentId,
        containerId: container.id,
        containerName: container.containerName,
        entries: normalized.entries,
      });
    } catch (error) {
      console.error(
        `[nouva-agent] runtime log sync failed for ${container.id} (${container.serviceId})`,
        error
      );
    }
  }

  if (batches.length === 0) {
    return 0;
  }

  const response = await apiRequest<AgentRuntimeLogsResponse>("/api/agent/logs/runtime", {
    method: "POST",
    token: credentials.agentToken,
    body: {
      serverId: SERVER_ID!,
      logs: batches,
    } satisfies AgentRuntimeLogsRequest,
  });

  return response.accepted;
}

async function syncPostgresObservability(
  docker: DockerApiClient,
  credentials: StoredCredentials
): Promise<number> {
  const samples = await collectPostgresObservabilitySamples(docker);
  if (samples.length === 0) {
    return 0;
  }

  const response = await apiRequest<AgentPostgresObservabilityResponse>(
    "/api/agent/observability/postgres",
    {
      method: "POST",
      token: credentials.agentToken,
      body: {
        serverId: SERVER_ID!,
        samples,
      } satisfies AgentPostgresObservabilityRequest,
    }
  );

  return response.accepted;
}

async function main() {
  assertAgentBootstrapEnv();
  await mkdir(DATA_DIR, { recursive: true });
  const docker = await DockerApiClient.create();
  let credentials = await readCredentials();
  let config = getAgentRuntimeConfig();

  if (!credentials?.agentToken) {
    const registered = await registerAgent(docker, config);
    credentials = registered.credentials;
    config = registered.config;
  }

  config = await sendHeartbeat(docker, credentials, config);
  let workLoopActive = false;
  let runtimeLogLoopActive = false;
  let postgresObservabilityLoopActive = false;
  let isShuttingDown = false;
  const runtimeLogCursors = new Map<string, RuntimeLogCursor>();

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[nouva-agent] shutting down, draining work and log loops...");
    const deadline = Date.now() + 9_000;
    while (
      (workLoopActive || runtimeLogLoopActive || postgresObservabilityLoopActive) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  let heartbeatFailures = 0;
  const MAX_HEARTBEAT_FAILURES = 5;

  setInterval(() => {
    sendHeartbeat(docker, credentials!, config)
      .then((nextConfig) => {
        config = nextConfig;
        heartbeatFailures = 0;
      })
      .catch((error) => {
        heartbeatFailures++;
        console.error(
          `[nouva-agent] heartbeat failed (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES})`,
          error
        );
        if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
          console.error("[nouva-agent] too many heartbeat failures, exiting");
          process.exit(1);
        }
      });
  }, config.heartbeatIntervalSeconds * 1000);

  setInterval(() => {
    collectMetrics(docker)
      .then((metrics) =>
        apiRequest("/api/agent/metrics", {
          method: "POST",
          token: credentials!.agentToken,
          body: {
            serverId: SERVER_ID!,
            ...metrics,
          } satisfies AgentMetricsRequest,
        })
      )
      .catch((error) => {
        console.error("[nouva-agent] metrics failed", error);
      });
  }, config.metricsIntervalSeconds * 1000);

  if (config.postgresObservabilityIntervalSeconds > 0) {
    setInterval(() => {
      if (postgresObservabilityLoopActive || isShuttingDown) {
        return;
      }

      postgresObservabilityLoopActive = true;
      syncPostgresObservability(docker, credentials!)
        .catch((error) => {
          console.error("[nouva-agent] postgres observability sync failed", error);
        })
        .finally(() => {
          postgresObservabilityLoopActive = false;
        });
    }, config.postgresObservabilityIntervalSeconds * 1000);
  }

  if (RUNTIME_LOG_SYNC_INTERVAL_MS > 0) {
    setInterval(() => {
      if (runtimeLogLoopActive || isShuttingDown) {
        return;
      }

      runtimeLogLoopActive = true;
      syncRuntimeLogs(docker, credentials!, runtimeLogCursors)
        .catch((error) => {
          console.error("[nouva-agent] runtime log sync failed", error);
        })
        .finally(() => {
          runtimeLogLoopActive = false;
        });
    }, RUNTIME_LOG_SYNC_INTERVAL_MS);
  }

  setInterval(async () => {
    if (workLoopActive || isShuttingDown) {
      return;
    }

    workLoopActive = true;
    try {
      const leased = await apiRequest<AgentLeaseResponse>("/api/agent/work/lease", {
        method: "POST",
        token: credentials!.agentToken,
        body: {
          serverId: SERVER_ID!,
          limit: 5,
        },
      });

      config = leased.config;
      for (const workItem of leased.workItems) {
        await processWorkItem(docker, config, credentials!, workItem);
      }
    } catch (error) {
      console.error("[nouva-agent] work loop failed", error);
    } finally {
      workLoopActive = false;
    }
  }, config.pollIntervalSeconds * 1000);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[nouva-agent] fatal", error);
    process.exit(1);
  });
}
