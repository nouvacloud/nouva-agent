import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readlink, rename, statfs, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import agentPackageJson from "../package.json" with { type: "json" };
import {
  type AlloyRuntimeInput,
  buildUnavailableAlloyChecks,
  collectAlloyValidationChecks,
  ensureAlloyRuntime,
  getAlloyRuntimePaths,
} from "./alloy-runtime.js";
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
  type RegistryAuth,
} from "./docker-api.js";
import { toDockerResourceSettings } from "./docker-resource-limits.js";
import { collectPostgresObservabilitySamples } from "./postgres-observability.js";
import {
  type AgentCapabilities,
  type AgentHeartbeatResponse,
  type AgentImageStoreMode,
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
  parseHostMetricsSnapshot,
  type RemoveServicePayload,
  type RestartServicePayload,
  type RestorePostgresPitrPayload,
  type RestoreVolumeBackupPayload,
  type RuntimeLogMessage,
  type RuntimeMetadata,
  type RuntimeRetainedImage,
  resolveAgentCapabilities,
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

const execFile = promisify(execFileCallback);

const API_URL = process.env.NOUVA_API_URL;
const SERVER_ID = process.env.NOUVA_SERVER_ID;
const REGISTRATION_TOKEN = process.env.NOUVA_REGISTRATION_TOKEN;
const DATA_DIR = "/var/lib/nouva-agent";
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");
const APP_DOMAIN = process.env.NOUVA_APP_DOMAIN || "nouva.cloud";
const DATA_VOLUME = process.env.NOUVA_AGENT_DATA_VOLUME || "nouva-agent-data";
const BUILDKIT_CONTAINER_NAME = process.env.NOUVA_AGENT_BUILDKIT_CONTAINER || "nouva-buildkitd";
const BUILDKIT_IMAGE = "moby/buildkit:v0.17.0";
const GIT_BIN = process.env.GIT_PATH || "git";
const RAILPACK_BIN = process.env.RAILPACK_PATH || "railpack";
const BUILDCTL_BIN = process.env.BUILDCTL_PATH || "buildctl";
const LOCAL_REGISTRY_CONTAINER_NAME =
  process.env.NOUVA_AGENT_REGISTRY_CONTAINER || "nouva-registry";
const TRAEFIK_CONTAINER_NAME = process.env.NOUVA_AGENT_TRAEFIK_CONTAINER || "nouva-traefik";
const TRAEFIK_IMAGE = process.env.NOUVA_AGENT_TRAEFIK_IMAGE || DEFAULT_TRAEFIK_IMAGE;
const TRAEFIK_PATHS = buildTraefikRuntimePaths(DATA_DIR);
const ALLOY_PATHS = getAlloyRuntimePaths(DATA_DIR);
const BUILDKIT_ADDRESS = process.env.NOUVA_AGENT_BUILDKIT_ADDR || "tcp://127.0.0.1:1234";
const DEFAULT_BUILDKIT_PORT = 1234;
const DEFAULT_AGENT_CONTAINER_NAME = "nouva-agent";
const DEFAULT_AGENT_IMAGE = "ghcr.io/nouvacloud/nouva-agent:latest";
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

export async function resolveAgentTaskImage(
  docker: Pick<DockerApiClient, "inspectContainer">,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const configuredImage = env.NOUVA_AGENT_IMAGE?.trim() || env.NOUVA_AGENT_TARGET_IMAGE?.trim();
  if (configuredImage?.length) {
    return configuredImage;
  }

  const candidates = [
    env.HOSTNAME?.trim(),
    env.NOUVA_AGENT_CONTAINER_NAME?.trim(),
    DEFAULT_AGENT_CONTAINER_NAME,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of new Set(candidates)) {
    const inspection = await docker.inspectContainer(candidate);
    const inspectedImage = inspection?.Config?.Image?.trim();
    if (inspectedImage) {
      return inspectedImage;
    }
  }

  return DEFAULT_AGENT_IMAGE;
}

function getInheritedNouvaEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter(
      (key) =>
        key.startsWith("NOUVA_") &&
        key !== "NOUVA_AGENT_VERSION" &&
        key !== "NOUVA_AGENT_IMAGE" &&
        key !== "NOUVA_AGENT_TARGET_IMAGE"
    )
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
    `NOUVA_AGENT_IMAGE=${imageRef}`,
    `NOUVA_AGENT_TARGET_IMAGE=${imageRef}`,
  ];
  const envInheritFlags = [...inheritedNouvaEnvKeys, "NOUVA_AGENT_IMAGE", "NOUVA_AGENT_TARGET_IMAGE"]
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
  mountPath?: string;
  dataPath?: string;
}) {
  if (!payload.imageUrl || !payload.mountPath || !payload.dataPath || !payload.envVars) {
    throw new Error("Backup helper payload is missing hydrated executor fields");
  }

  return {
    image: payload.imageUrl,
    envVars: toRecord(payload.envVars),
    containerArgs: Array.isArray(payload.containerArgs)
      ? payload.containerArgs.filter((value): value is string => typeof value === "string")
      : [],
    mountPath: payload.mountPath,
    dataPath: payload.dataPath,
  };
}

function toRuntimeMetadata(value: unknown): RuntimeMetadata | null {
  const metadata = toObject(value);
  return Object.keys(metadata).length > 0 ? (metadata as RuntimeMetadata) : null;
}

function normalizeRetainedRuntimeImage(value: unknown): RuntimeRetainedImage | null {
  const image = toObject(value);
  const reference = typeof image.reference === "string" ? image.reference.trim() : "";
  if (!reference) {
    return null;
  }

  return {
    reference,
    imageId: typeof image.imageId === "string" ? image.imageId : null,
    deploymentId: typeof image.deploymentId === "string" ? image.deploymentId : null,
    commitHash: typeof image.commitHash === "string" ? image.commitHash : null,
  };
}

function resolveCurrentRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  const currentImage = normalizeRetainedRuntimeImage(runtimeMetadata?.currentImage);
  if (currentImage) {
    return currentImage;
  }

  const reference = typeof runtimeMetadata?.image === "string" ? runtimeMetadata.image.trim() : "";
  return reference
    ? {
        reference,
        imageId: null,
        deploymentId: null,
        commitHash: null,
      }
    : null;
}

function resolvePreviousRuntimeImage(
  runtimeMetadata: RuntimeMetadata | null | undefined
): RuntimeRetainedImage | null {
  return normalizeRetainedRuntimeImage(runtimeMetadata?.previousImage);
}

function sameRetainedRuntimeImage(
  left: RuntimeRetainedImage | null | undefined,
  right: RuntimeRetainedImage | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }

  if (left.imageId && right.imageId) {
    return left.imageId === right.imageId;
  }

  return left.reference === right.reference;
}

function isDockerLocalImageStore(mode: AgentImageStoreMode): boolean {
  return mode === "docker-local";
}

function buildRetainedRuntimeImage(input: {
  reference: string;
  imageId: string | null;
  deploymentId: string;
  commitHash: string;
}): RuntimeRetainedImage {
  return {
    reference: input.reference,
    imageId: input.imageId,
    deploymentId: input.deploymentId,
    commitHash: input.commitHash,
  };
}

async function removeRetainedRuntimeImage(
  docker: Pick<DockerApiClient, "removeImage">,
  image: RuntimeRetainedImage | null
): Promise<void> {
  if (!image) {
    return;
  }

  if (image.reference) {
    await docker.removeImage(image.reference, true);
    return;
  }

  if (image.imageId) {
    await docker.removeImage(image.imageId, true);
  }
}

async function removeRetainedRuntimeImages(
  docker: Pick<DockerApiClient, "removeImage">,
  runtimeMetadata: RuntimeMetadata | null | undefined
): Promise<void> {
  const images = [
    resolveCurrentRuntimeImage(runtimeMetadata),
    resolvePreviousRuntimeImage(runtimeMetadata),
  ];

  const removed = new Set<string>();
  for (const image of images) {
    const key = image?.imageId ?? image?.reference ?? null;
    if (!key || removed.has(key)) {
      continue;
    }
    removed.add(key);
    await removeRetainedRuntimeImage(docker, image);
  }
}

function shouldRetainImageReference(
  runtimeMetadata: RuntimeMetadata | null | undefined,
  imageReference: string
): boolean {
  const retainedImages = [
    resolveCurrentRuntimeImage(runtimeMetadata),
    resolvePreviousRuntimeImage(runtimeMetadata),
  ];

  return retainedImages.some((image) => image?.reference === imageReference);
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

async function checkCommandAvailability(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("sh", ["-lc", `command -v ${JSON.stringify(command)}`]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : command;
  } catch {
    return null;
  }
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
  config: AgentRuntimeConfig,
  credentials?: StoredCredentials | null
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

  const [gitPath, railpackPath, buildctlPath] = await Promise.all([
    checkCommandAvailability(GIT_BIN),
    checkCommandAvailability(RAILPACK_BIN),
    checkCommandAvailability(BUILDCTL_BIN),
  ]);

  checks.push(
    buildCheck(
      "git",
      "Git CLI",
      gitPath ? "pass" : "fail",
      gitPath ? "Git is available for repository clones" : "Git is missing from the agent runtime",
      gitPath
    ),
    buildCheck(
      "railpack",
      "Railpack CLI",
      railpackPath ? "pass" : "fail",
      railpackPath
        ? "Railpack is available for build detection and build planning"
        : "Railpack is missing from the agent runtime",
      railpackPath
    ),
    buildCheck(
      "buildctl",
      "Buildctl CLI",
      buildctlPath ? "pass" : "fail",
      buildctlPath
        ? "Buildctl is available for image builds"
        : "Buildctl is missing from the agent runtime",
      buildctlPath
    )
  );

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

    try {
      await ensureSharedBuildkitRuntime(docker);
      checks.push(
        buildCheck(
          "buildkit",
          "BuildKit daemon",
          "pass",
          "BuildKit daemon is reachable and ready for builds",
          BUILDKIT_ADDRESS
        )
      );
    } catch (error) {
      checks.push(
        buildCheck(
          "buildkit",
          "BuildKit daemon",
          "fail",
          error instanceof Error ? error.message : "BuildKit daemon is unavailable",
          BUILDKIT_ADDRESS
        )
      );
    }

    if (config.imageStoreMode === "local-registry") {
      try {
        await ensureLocalRegistryRuntime(docker, config);
        checks.push(
          buildCheck(
            "registry",
            "Local image registry",
            "pass",
            "Local image registry is reachable and ready for pushes",
            `127.0.0.1:${config.localRegistryPort}`
          )
        );
      } catch (error) {
        checks.push(
          buildCheck(
            "registry",
            "Local image registry",
            "fail",
            error instanceof Error ? error.message : "Local image registry is unavailable",
            `127.0.0.1:${config.localRegistryPort}`
          )
        );
      }
    }

    if (config.observability.enabled) {
      if (!credentials?.agentToken || !config.observability.organizationId) {
        checks.push(
          ...buildUnavailableAlloyChecks(
            "Observability is enabled but Alloy is waiting for server-scoped credentials"
          )
        );
      } else {
        let alloyBootstrapError: Error | null = null;
        try {
          await ensureAlloyRuntime(docker, getAlloyRuntimeInput(credentials, config), {
            paths: ALLOY_PATHS,
          });
        } catch (error) {
          alloyBootstrapError =
            error instanceof Error ? error : new Error("Failed to reconcile Alloy");
        }

        checks.push(
          ...(await collectAlloyValidationChecks(
            docker,
            getAlloyRuntimeInput(credentials, config),
            {
              paths: ALLOY_PATHS,
            },
            alloyBootstrapError
          ))
        );
      }
    }
  } else {
    checks.push(...buildUnavailableTraefikChecks("Docker Engine is unavailable"));
    checks.push(
      buildCheck(
        "buildkit",
        "BuildKit daemon",
        "fail",
        "Docker Engine is unavailable, so BuildKit cannot be reconciled",
        BUILDKIT_ADDRESS
      )
    );
    if (config.imageStoreMode === "local-registry") {
      checks.push(
        buildCheck(
          "registry",
          "Local image registry",
          "fail",
          "Docker Engine is unavailable, so the local image registry cannot be reconciled",
          `127.0.0.1:${config.localRegistryPort}`
        )
      );
    }

    if (config.observability.enabled) {
      checks.push(...buildUnavailableAlloyChecks("Docker Engine is unavailable"));
    }
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
    capabilities: resolveAgentCapabilities(config),
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
  const snapshot = await collectValidationSnapshot(docker, config, credentials);

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
  environmentId?: string | null;
}): Record<string, string> {
  return {
    "nouva.managed": "true",
    "nouva.server.id": SERVER_ID!,
    "nouva.kind": input.kind,
    ...(input.projectId ? { "nouva.project.id": input.projectId } : {}),
    ...(input.serviceId ? { "nouva.service.id": input.serviceId } : {}),
    ...(input.deploymentId ? { "nouva.deployment.id": input.deploymentId } : {}),
    ...(input.serviceVariant ? { "nouva.service.variant": input.serviceVariant } : {}),
    ...(input.environmentId ? { "nouva.environment.id": input.environmentId } : {}),
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

function getAlloyRuntimeInput(
  credentials: StoredCredentials,
  config: AgentRuntimeConfig
): AlloyRuntimeInput {
  return {
    dataDir: DATA_DIR,
    dataVolume: DATA_VOLUME,
    serverId: SERVER_ID!,
    apiUrl: API_URL!,
    agentToken: credentials.agentToken,
    config,
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

async function waitForLocalRegistryAvailability(
  config: Pick<AgentRuntimeConfig, "localRegistryPort">,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.localRegistryPort}/v2/`);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Local registry did not become ready on 127.0.0.1:${config.localRegistryPort} within ${timeoutMs}ms`
  );
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

async function ensureSharedBuildkitRuntime(
  docker: Pick<DockerApiClient, "ensureContainer" | "inspectContainer" | "removeContainer">
): Promise<void> {
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
  await waitForBuildkitAvailability(BUILDKIT_ADDRESS);
}

async function ensureLocalRegistryRuntime(
  docker: Pick<DockerApiClient, "ensureContainer">,
  config: Pick<AgentRuntimeConfig, "localRegistryPort">
): Promise<void> {
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
  await waitForLocalRegistryAvailability(config);
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

function buildPgBackrestRestoreAndPromoteScript() {
  return [
    "set -eu",
    'mkdir -p "$NOUVA_DATA_PATH" "' +
      "$" +
      "{POSTGRES_SOCKET_DIR:-/var/lib/postgresql/.sockets}" +
      '" /var/run/postgresql',
    'chown -R 999:999 "$NOUVA_DATA_PATH" || true',
    "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
    `if [ -n "\${RESTORE_SET:-}" ]; then`,
    '  pgbackrest --stanza="$PGBACKREST_STANZA" --set="$RESTORE_SET" --delta --type=time --target="$RESTORE_TARGET" --target-action=promote --log-level-console=info restore',
    "else",
    '  pgbackrest --stanza="$PGBACKREST_STANZA" --delta --type=time --target="$RESTORE_TARGET" --target-action=promote --log-level-console=info restore',
    "fi",
    'export PGHOST="' + "$" + "{POSTGRES_SOCKET_DIR:-/var/lib/postgresql/.sockets}" + '"',
    'export PGPORT="' + "$" + "{POSTGRES_PORT:-5433}" + '"',
    'export NOUVA_PROMOTE_DB="' + "$" + "{POSTGRES_DB:-postgres}" + '"',
    'export NOUVA_PROMOTE_USER="' + "$" + "{POSTGRES_USER:-postgres}" + '"',
    'if [ -n "' +
      "$" +
      "{POSTGRES_PASSWORD:-}" +
      '" ]; then export PGPASSWORD="' +
      "$" +
      "{POSTGRES_PASSWORD}" +
      '"; fi',
    "/nouva/entrypoint.sh &",
    'entrypoint_pid="$!"',
    "cleanup() {",
    '  if kill -0 "$entrypoint_pid" 2>/dev/null; then',
    '    kill -TERM "$entrypoint_pid" || true',
    '    wait "$entrypoint_pid" || true',
    "  fi",
    "}",
    "trap cleanup EXIT INT TERM",
    "for i in $(seq 1 180); do",
    '  recovery_state=$(psql -h "$PGHOST" -p "$PGPORT" -U "$NOUVA_PROMOTE_USER" -d "$NOUVA_PROMOTE_DB" -Atqc "select case when pg_is_in_recovery() then \'t\' else \'f\' end" 2>/dev/null || true)',
    '  if [ "$recovery_state" = "f" ]; then',
    '    psql -h "$PGHOST" -p "$PGPORT" -U "$NOUVA_PROMOTE_USER" -d "$NOUVA_PROMOTE_DB" -c "checkpoint" >/dev/null 2>&1 || true',
    "    exit 0",
    "  fi",
    '  if ! kill -0 "$entrypoint_pid" 2>/dev/null; then',
    '    wait "$entrypoint_pid"',
    "  fi",
    "  sleep 1",
    '  if [ "$i" -eq 180 ]; then',
    '    echo "Restored Postgres did not promote within 180 seconds" >&2',
    "    exit 1",
    "  fi",
    "done",
  ].join("\n");
}

async function runTaskContainer(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  options: {
    name: string;
    image: string;
    env?: string[];
    entrypoint?: string[];
    cmd: string[];
    mounts?: Array<{ source: string; target: string }>;
    timeoutMs?: number;
  }
): Promise<{ logs: string }> {
  await docker.pullImage(options.image, resolveRegistryAuthForImage(config, options.image));
  await docker.removeContainer(options.name, true);

  const id = await docker.createContainer({
    name: options.name,
    image: options.image,
    env: options.env,
    entrypoint: options.entrypoint,
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
  await ensureSharedBuildkitRuntime(docker);
  if (config.imageStoreMode === "local-registry") {
    await ensureLocalRegistryRuntime(docker, config);
  }
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
        environmentId: payload.environmentId ?? null,
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

  const currentRuntimeImage = resolveCurrentRuntimeImage(payload.runtimeMetadata);
  const retainedPreviousImage = resolvePreviousRuntimeImage(payload.runtimeMetadata);
  const previousContainer =
    payload.runtimeMetadata?.containerName ?? payload.runtimeMetadata?.containerId ?? null;
  const { containerName, appPort, spec } = buildAppContainerSpec(config, payload);
  const previousServiceUrl = previousContainer
    ? `http://${previousContainer}:${resolveAppRuntimePort(payload.runtimeMetadata, appPort)}`
    : null;
  const rollout = resolveAppRolloutConfig(payload.rollout);
  const dockerLocalImages = isDockerLocalImageStore(config.imageStoreMode);
  let resolvedImageId = payload.imageId ?? null;

  if (dockerLocalImages && !resolvedImageId) {
    resolvedImageId = (await docker.inspectImage(payload.imageUrl))?.Id ?? null;
  }

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

  const containerId = await docker.ensureContainer(spec, true, {
    pull: !dockerLocalImages,
  });
  await docker.connectNetwork(projectNetwork, containerId).catch((err: Error) => {
    console.error(
      `[nouva-agent] connectNetwork failed for service ${payload.serviceId}: ${err.message}`
    );
  });

  try {
    await waitForAppCandidateReadiness(dependencies, docker, containerName, appPort, rollout);
  } catch (error) {
    await docker.removeContainer(containerName, true);
    if (
      dockerLocalImages &&
      !shouldRetainImageReference(payload.runtimeMetadata, payload.imageUrl)
    ) {
      await docker.removeImage(payload.imageUrl, true);
    }
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

  const candidateServiceUrl = `http://${containerName}:${appPort}`;
  try {
    await dependencies.writeLocalTraefikRoute(
      TRAEFIK_PATHS,
      payload.serviceId,
      {
        providedHostname: `${payload.subdomain}.${APP_DOMAIN}`,
        customHostnames: [],
      },
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
        {
          providedHostname: `${payload.subdomain}.${APP_DOMAIN}`,
          customHostnames: [],
        },
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
    if (
      dockerLocalImages &&
      !shouldRetainImageReference(payload.runtimeMetadata, payload.imageUrl)
    ) {
      await docker.removeImage(payload.imageUrl, true);
    }

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

  const nextCurrentImage = buildRetainedRuntimeImage({
    reference: payload.imageUrl,
    imageId: resolvedImageId,
    deploymentId: payload.deploymentId,
    commitHash: payload.commitHash,
  });
  const nextPreviousImage = currentRuntimeImage ? { ...currentRuntimeImage } : null;

  if (
    dockerLocalImages &&
    retainedPreviousImage &&
    !sameRetainedRuntimeImage(retainedPreviousImage, nextPreviousImage) &&
    !sameRetainedRuntimeImage(retainedPreviousImage, nextCurrentImage)
  ) {
    await removeRetainedRuntimeImage(docker, retainedPreviousImage);
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
      imageStoreMode: config.imageStoreMode,
      currentImage: nextCurrentImage,
      previousImage: nextPreviousImage,
      ingressHost: `${payload.subdomain}.${APP_DOMAIN}`,
      ingressPort: 80,
      internalPort: appPort,
      networkName: projectNetwork,
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

function getImageRegistryHost(imageReference: string): string | null {
  const trimmed = imageReference.trim();
  if (!trimmed) {
    return null;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  const firstSegment = trimmed.slice(0, slashIndex);
  if (!firstSegment) {
    return null;
  }

  return firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost"
    ? firstSegment
    : null;
}

function resolveRegistryAuthForImage(
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  imageReference: string
): RegistryAuth | undefined {
  if (!config.privateRegistry) {
    return undefined;
  }

  return getImageRegistryHost(imageReference) === config.privateRegistry.host
    ? config.privateRegistry
    : undefined;
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
        Target: resolved.mountPath,
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
        environmentId: payload.environmentId ?? null,
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

async function deployDatabaseContainer(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DatabaseProvisionPayload
) {
  const { projectNetwork, resolved, volumeName, containerName, spec } =
    buildDatabaseContainerSpec(payload);
  await docker.ensureNetwork(projectNetwork);
  await docker.createVolume(volumeName);
  const containerId = await docker.ensureContainer(spec, true, {
    auth: resolveRegistryAuthForImage(config, resolved.image),
  });

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
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DatabaseProvisionPayload
) {
  const { projectNetwork, resolved, volumeName, containerName, containerId } =
    await deployDatabaseContainer(docker, config, payload);

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
      mountPath: resolved.mountPath,
      dataPath: resolved.dataPath,
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
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DatabaseProvisionPayload & {
    runtimeMetadata?: RuntimeMetadata | null;
  }
) {
  const identifier = payload.runtimeMetadata?.containerId ?? payload.runtimeMetadata?.containerName;
  if (identifier) {
    await docker.removeContainer(identifier, true);
  }

  return await handleDatabaseProvision(docker, config, payload);
}

async function handleDeleteVolume(docker: DockerApiClient, payload: DeleteVolumePayload) {
  await docker.removeVolume(getManagedVolumeName(payload), true);
  return {
    volumeName: payload.volumeName,
  };
}

async function handleWipeVolume(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
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

  return await handleDatabaseProvision(docker, config, payload);
}

async function handleCreateArchiveBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  const remoteExpression = buildArchiveRemoteExpression(payload.destination.verifyTls);
  const agentTaskImage = await resolveAgentTaskImage(docker);
  const { logs } = await runTaskContainer(docker, config, {
    name: `nouva-backup-${payload.backupId.slice(0, 12)}`,
    image: agentTaskImage,
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
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DeleteVolumeBackupPayload
) {
  const remoteExpression = buildArchiveRemoteExpression(payload.destination.verifyTls);
  const agentTaskImage = await resolveAgentTaskImage(docker);
  await runTaskContainer(docker, config, {
    name: `nouva-delete-backup-${payload.backupId.slice(0, 12)}`,
    image: agentTaskImage,
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
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestoreVolumeBackupPayload
) {
  const remoteExpression = buildArchiveRemoteExpression(payload.destination.verifyTls);
  const agentTaskImage = await resolveAgentTaskImage(docker);
  await docker.createVolume(payload.targetVolumeName);
  await runTaskContainer(docker, config, {
    name: `nouva-restore-backup-${payload.backupId.slice(0, 12)}`,
    image: agentTaskImage,
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
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  const spec = resolveHydratedHelperSpec({
    imageUrl: payload.imageUrl,
    envVars: payload.envVars,
    containerArgs: payload.containerArgs,
    mountPath: payload.mountPath,
    dataPath: payload.dataPath,
  });
  const script = [
    "set -eu",
    'printf "%s\\n" "*:*:*:$POSTGRES_USER:$POSTGRES_PASSWORD" > /tmp/.pgpass',
    "chmod 0600 /tmp/.pgpass",
    "export PGPASSFILE=/tmp/.pgpass",
    'metadata_dir="$NOUVA_DATA_PATH/.nouva/pgbackrest"',
    'mkdir -p "$metadata_dir"',
    "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
    'stanza_info_log="/tmp/pgbackrest-stanza-info.log"',
    'if ! pgbackrest --stanza="$PGBACKREST_STANZA" info >"$stanza_info_log" 2>&1; then',
    '  if grep -Eq "missing stanza path|backup\\.info cannot be opened" "$stanza_info_log"; then',
    '    pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info stanza-create',
    "  else",
    '    cat "$stanza_info_log" >&2',
    "    exit 1",
    "  fi",
    "fi",
    'pgbackrest --stanza="$PGBACKREST_STANZA" --type="$NOUVA_PGBACKREST_BACKUP_TYPE" --annotation="nouva-backup-id=$NOUVA_BACKUP_ID" --log-level-console=info backup',
    'if info_output=$(pgbackrest --stanza="$PGBACKREST_STANZA" --output=json info 2>/dev/null); then',
    `  printf 'NOUVA_PGBACKREST_INFO:%s\\n' "$(printf '%s' "$info_output" | tr -d '\\n')"`,
    "fi",
  ].join("\n");
  const { logs } = await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-backup-${payload.backupId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `NOUVA_BACKUP_ID=${payload.backupId}`,
      `NOUVA_PGBACKREST_BACKUP_TYPE=${payload.pgbackrestType ?? "full"}`,
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    entrypoint: ["sh", "-c"],
    cmd: [script],
    mounts: [{ source: payload.volumeName, target: spec.mountPath }],
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
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestoreVolumeBackupPayload
) {
  if (!payload.backupCompletedAt) {
    throw new Error("Backup restore is missing backupCompletedAt");
  }

  const spec = resolveHydratedHelperSpec({
    imageUrl: payload.imageUrl,
    envVars: payload.envVars,
    containerArgs: payload.containerArgs,
    mountPath: payload.targetMountPath,
    dataPath: payload.dataPath,
  });
  const script = buildPgBackrestRestoreAndPromoteScript();

  await docker.createVolume(payload.targetVolumeName);
  await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-restore-${payload.targetVolumeId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `RESTORE_TARGET=${payload.backupCompletedAt}`,
      `RESTORE_SET=${payload.pgbackrestSet ?? ""}`,
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    entrypoint: ["sh", "-c"],
    cmd: [script],
    mounts: [{ source: payload.targetVolumeName, target: spec.mountPath }],
    timeoutMs: 30 * 60_000,
  });

  return {
    volumeName: payload.targetVolumeName,
  };
}

async function handleExpireVolumeBackupRepository(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: ExpireVolumeBackupRepositoryPayload
) {
  const script = [
    "set -eu",
    "if [ -x /nouva/generate_config.sh ]; then /nouva/generate_config.sh; fi",
    'pgbackrest --stanza="$PGBACKREST_STANZA" --log-level-console=info expire',
    'if info_output=$(pgbackrest --stanza="$PGBACKREST_STANZA" --output=json info 2>/dev/null); then',
    `  printf 'NOUVA_PGBACKREST_INFO:%s\\n' "$(printf '%s' "$info_output" | tr -d '\\n')"`,
    "fi",
  ].join("\n");
  const { logs } = await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-expire-${payload.volumeId.slice(0, 12)}`,
    image: payload.imageUrl ?? "postgres:17",
    env: Object.entries(toRecord(payload.envVars)).map(([key, value]) => `${key}=${value}`),
    entrypoint: ["sh", "-c"],
    cmd: [script],
    timeoutMs: 30 * 60_000,
  });

  const rawInfo = extractPrefixedLogLine(logs, "NOUVA_PGBACKREST_INFO:");
  const entries = rawInfo ? parsePgBackrestInfo(rawInfo) : [];
  return {
    activePgbackrestSets: entries.map((entry) => entry.label),
  };
}

export async function handleCreateVolumeBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: CreateVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return await handleCreatePgBackrestBackup(docker, config, payload);
  }

  return await handleCreateArchiveBackup(docker, config, payload);
}

async function handleDeleteVolumeBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: DeleteVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return {};
  }

  return await handleDeleteArchiveBackup(docker, config, payload);
}

async function handleRestoreVolumeBackup(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestoreVolumeBackupPayload
) {
  if (payload.engine === "pgbackrest") {
    return await handleRestorePgBackrestBackup(docker, config, payload);
  }

  return await handleRestoreArchiveBackup(docker, config, payload);
}

export async function handleRestorePostgresPitr(
  docker: DockerApiClient,
  config: Pick<AgentRuntimeConfig, "privateRegistry">,
  payload: RestorePostgresPitrPayload
) {
  const spec = resolveDatabaseProvisionSpec(payload);
  const script = buildPgBackrestRestoreAndPromoteScript();
  await runTaskContainer(docker, config, {
    name: `nouva-pgbackrest-pitr-${payload.serviceId.slice(0, 12)}`,
    image: spec.image,
    env: [
      ...Object.entries(spec.envVars).map(([key, value]) => `${key}=${value}`),
      `RESTORE_TARGET=${payload.restoreTarget}`,
      "RESTORE_SET=",
      `NOUVA_DATA_PATH=${spec.dataPath}`,
    ],
    entrypoint: ["sh", "-c"],
    cmd: [script],
    mounts: [{ source: payload.volumeName, target: spec.mountPath }],
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
  if (runtimeMetadata?.imageStoreMode === "docker-local") {
    await removeRetainedRuntimeImages(docker, runtimeMetadata);
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

  if (payload.serviceType === "app" && payload.runtimeMetadata?.imageStoreMode === "docker-local") {
    await removeRetainedRuntimeImages(docker, payload.runtimeMetadata);
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

  const internalPort =
    typeof runtimeMetadata.internalPort === "number"
      ? runtimeMetadata.internalPort
      : (payload.ingressPort ?? 3000);

  if (!payload.providedHostname && payload.customHostnames.length === 0) {
    await deleteLocalTraefikRoute(TRAEFIK_PATHS, payload.serviceId);
  } else {
    await writeLocalTraefikRoute(
      TRAEFIK_PATHS,
      payload.serviceId,
      {
        providedHostname: payload.providedHostname,
        customHostnames: payload.customHostnames,
      },
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
        // App deploy payloads are hydrated at lease time with the live service runtime metadata.
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
          config,
          payload as unknown as DatabaseProvisionPayload
        );
        break;
      case "apply_database_volume":
        result = await handleApplyDatabaseVolume(docker, config, {
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
          config,
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
          config,
          payload as unknown as CreateVolumeBackupPayload
        );
        break;
      case "delete_volume_backup":
        result = await handleDeleteVolumeBackup(
          docker,
          config,
          payload as unknown as DeleteVolumeBackupPayload
        );
        break;
      case "restore_volume_backup":
        result = await handleRestoreVolumeBackup(
          docker,
          config,
          payload as unknown as RestoreVolumeBackupPayload
        );
        break;
      case "restore_postgres_pitr":
        result = await handleRestorePostgresPitr(
          docker,
          config,
          payload as unknown as RestorePostgresPitrPayload
        );
        break;
      case "expire_volume_backup_repository":
        result = await handleExpireVolumeBackupRepository(
          docker,
          config,
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
    if (config.observability.enabled || isShuttingDown) {
      return;
    }

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
      if (config.observability.enabled || runtimeLogLoopActive || isShuttingDown) {
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
