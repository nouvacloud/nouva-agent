export const SERVER_CHECK_STATUSES = ["pass", "warn", "fail"] as const;
export type ServerCheckStatus = (typeof SERVER_CHECK_STATUSES)[number];

export const AGENT_WORK_STATUSES = [
  "queued",
  "leased",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentWorkStatus = (typeof AGENT_WORK_STATUSES)[number];

export const AGENT_WORK_KINDS = [
  "deploy_app",
  "redeploy_app",
  "rollback_app",
  "restart_app",
  "remove_app",
  "provision_database",
  "apply_database_volume",
  "restart_database",
  "delete_service",
  "delete_volume",
  "wipe_volume",
  "create_volume_backup",
  "delete_volume_backup",
  "restore_volume_backup",
  "restore_postgres_pitr",
  "expire_volume_backup_repository",
  "sync_routing",
  "update_agent",
] as const;
export type AgentWorkKind = (typeof AGENT_WORK_KINDS)[number];

export type ServerValidationCheck = {
  key: string;
  label: string;
  status: ServerCheckStatus;
  message: string;
  value?: string | null;
};

export type ServerValidationReport = {
  checkedAt: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: ServerValidationCheck[];
};

export type RuntimeMetadata = {
  configVersion?: number;
  ingressHost?: string | null;
  ingressPort?: number | null;
  publishedPort?: number | null;
  image?: string | null;
  containerId?: string | null;
  containerName?: string | null;
  networkName?: string | null;
  runtimeInstanceId?: string | null;
  [key: string]: unknown;
};

export interface ServiceResourceLimits {
  cpuMillicores?: number;
  memoryBytes?: number;
}

export const APP_BUILD_TYPES = ["railpack", "dockerfile", "static"] as const;
export type AppBuildType = (typeof APP_BUILD_TYPES)[number];

export interface AppRailpackBuildConfig {
  buildRoot: string;
}

export interface AppDockerfileBuildConfig {
  buildRoot: string;
  dockerfilePath: string;
  dockerContextPath: string;
  dockerBuildStage?: string | null;
}

export interface AppStaticBuildConfig {
  buildRoot: string;
  publishDirectory: string;
  spaFallback: boolean;
}

export type AppBuildConfig =
  | AppRailpackBuildConfig
  | AppDockerfileBuildConfig
  | AppStaticBuildConfig;

export type AgentCapabilities = {
  dockerApi?: boolean;
  buildkit?: boolean;
  localRegistry?: boolean;
  localTraefik?: boolean;
  hostMetrics?: boolean;
  containerMetrics?: boolean;
  runtimeLogs?: boolean;
  [key: string]: boolean | undefined;
};

export const DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS = 30;
export const DEFAULT_AGENT_POLL_INTERVAL_SECONDS = 10;
export const DEFAULT_AGENT_LEASE_TTL_SECONDS = 120;
export const DEFAULT_AGENT_METRICS_INTERVAL_SECONDS = 30;

export type AgentIngressMode = "local_traefik";
export type AgentBuildkitMode = "docker-container";

export interface AgentRuntimeConfig {
  heartbeatIntervalSeconds: number;
  pollIntervalSeconds: number;
  leaseTtlSeconds: number;
  metricsIntervalSeconds: number;
  ingressMode: AgentIngressMode;
  buildkitMode: AgentBuildkitMode;
  capabilities: AgentCapabilities;
  localRegistryHost: string;
  localRegistryPort: number;
  localTraefikNetwork: string;
}

export interface AgentRegistrationSnapshot {
  serverId: string;
  hostname: string;
  operatingSystem: string | null;
  architecture: string | null;
  dockerVersion: string | null;
  agentVersion: string;
  publicIp: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytesAvailable: number | null;
  latestValidationReport: ServerValidationReport | null;
  capabilities?: AgentCapabilities | null;
}

export interface AgentWorkRecord {
  id: string;
  serverId: string;
  projectId: string | null;
  serviceId: string | null;
  deploymentId: string | null;
  kind: AgentWorkKind;
  status: AgentWorkStatus;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentServerMetricPayload {
  cpuUsageBasisPoints?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  diskUsedBytes?: number | null;
  diskAvailableBytes?: number | null;
  diskTotalBytes?: number | null;
  loadAvg1mMilli?: number | null;
  loadAvg5mMilli?: number | null;
  loadAvg15mMilli?: number | null;
  raw?: Record<string, unknown> | null;
  collectedAt: string;
}

export interface AgentServiceMetricPayload {
  serviceId: string;
  deploymentId?: string | null;
  runtimeInstanceId?: string | null;
  cpuUsageBasisPoints?: number | null;
  memoryUsageBytes?: number | null;
  memoryLimitBytes?: number | null;
  networkRxBytes?: number | null;
  networkTxBytes?: number | null;
  blockReadBytes?: number | null;
  blockWriteBytes?: number | null;
  pidsCurrent?: number | null;
  raw?: Record<string, unknown> | null;
  collectedAt: string;
}

export interface AgentMetricsEnvelope {
  server: AgentServerMetricPayload;
  services: AgentServiceMetricPayload[];
}

export interface RuntimeLogMessage {
  type: "stdout" | "stderr";
  line: string;
  offset: number;
  timestamp: number;
}

export interface AgentRuntimeLogBatch {
  serviceId: string;
  deploymentId?: string | null;
  runtimeInstanceId?: string | null;
  containerId?: string | null;
  containerName?: string | null;
  entries: RuntimeLogMessage[];
}

export interface AgentWorkLeaseResult {
  config: AgentRuntimeConfig;
  workItems: AgentWorkRecord[];
}

export interface UpdateAgentPayload {
  releaseId?: string;
  version?: string;
  imageRef?: string;
  imageTag?: string;
}

export interface AppDeployPayload {
  repoUrl: string;
  commitHash: string;
  commitMessage: string;
  branch: string;
  subdomain: string;
  serviceName: string;
  projectId: string;
  serviceId: string;
  deploymentId: string;
  envVars: Record<string, string>;
  appBuildType?: AppBuildType | null;
  appBuildConfig?: AppBuildConfig | null;
  volume?: AppVolumeIdentity | null;
  resourceLimits: ServiceResourceLimits | null;
  buildCommand?: string;
  startCommand?: string;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface DeployOnlyPayload {
  imageUrl: string;
  commitHash: string;
  commitMessage: string;
  subdomain: string;
  projectId: string;
  serviceId: string;
  deploymentId: string;
  envVars: Record<string, string>;
  volume?: AppVolumeIdentity | null;
  resourceLimits: ServiceResourceLimits | null;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface AppVolumeIdentity {
  volumeId: string;
  volumeName: string;
  mountPath: string;
}

export interface DatabaseProvisionPayload {
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: "postgres" | "redis";
  volumeId: string;
  volumeName: string;
  mountPath: string;
  imageUrl?: string;
  envVars?: Record<string, string>;
  containerArgs?: string[];
  dataPath?: string;
  internalPort: number;
  storageSizeGb: number;
  externalHost: string | null;
  externalPort: number | null;
  publicAccessEnabled: boolean;
  resourceLimits: ServiceResourceLimits | null;
  runtimeMetadata?: RuntimeMetadata | null;
  version?: string;
  credentials?: Record<string, string>;
}

export interface DeleteVolumePayload {
  [key: string]: unknown;
  projectId: string;
  volumeId: string;
  volumeName: string;
}

export interface PlatformBackupDestinationMetadata {
  [key: string]: unknown;
  id: string;
  type: "s3";
  bucket: string;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  verifyTls: boolean;
  pgbackrestRepoType: string;
  pgbackrestCipherType: string | null;
  pgbackrestRetentionFullType: string | null;
  pgbackrestRetentionFull: string | null;
  pgbackrestRetentionDiff: string | null;
  pgbackrestRetentionArchiveType: string | null;
  pgbackrestRetentionArchive: string | null;
  pgbackrestRetentionHistory: string | null;
  pgbackrestArchiveAsync: boolean | null;
  pgbackrestSpoolPath: string | null;
}

export interface PlatformBackupDestination extends PlatformBackupDestinationMetadata {
  accessKeyId: string;
  secretAccessKey: string;
  pgbackrestCipherPass: string | null;
}

interface QueuedVolumeBackupPayloadBase {
  [key: string]: unknown;
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: "postgres" | "redis";
  version: string;
  volumeId: string;
  volumeName: string;
  mountPath: string;
  destination: PlatformBackupDestinationMetadata;
}

export interface CreateVolumeBackupPayload extends QueuedVolumeBackupPayloadBase {
  backupId: string;
  kind: string;
  scheduleType?: string | null;
  engine: "pgbackrest" | "snapshot";
  pgbackrestType?: "full" | "incr" | null;
  runtimeMetadata?: RuntimeMetadata | null;
  destination: PlatformBackupDestination;
  imageUrl?: string;
  envVars?: Record<string, string>;
  containerArgs?: string[];
  dataPath?: string;
  credentials?: Record<string, string>;
}

export interface DeleteVolumeBackupPayload extends QueuedVolumeBackupPayloadBase {
  backupId: string;
  engine: "pgbackrest" | "snapshot";
  destination: PlatformBackupDestination;
}

export interface RestoreVolumeBackupPayload {
  [key: string]: unknown;
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: "postgres" | "redis";
  version: string;
  sourceVolumeId: string;
  sourceVolumeName: string;
  sourceMountPath: string;
  targetVolumeId: string;
  targetVolumeName: string;
  targetMountPath: string;
  backupId: string;
  engine: "pgbackrest" | "snapshot";
  backupCompletedAt?: string | null;
  pgbackrestSet?: string | null;
  destination: PlatformBackupDestination;
  imageUrl?: string;
  envVars?: Record<string, string>;
  containerArgs?: string[];
  dataPath?: string;
  credentials?: Record<string, string>;
}

export interface RestorePostgresPitrPayload extends DatabaseProvisionPayload {
  restoreTarget: string;
  destination: PlatformBackupDestination;
}

export interface ExpireVolumeBackupRepositoryPayload {
  [key: string]: unknown;
  projectId: string;
  volumeId: string;
  volumeName: string;
  destination: PlatformBackupDestination;
  imageUrl?: string;
  envVars?: Record<string, string>;
}

export interface RestartServicePayload {
  projectId: string;
  serviceId: string;
  deploymentId?: string | null;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface RemoveServicePayload {
  projectId: string;
  serviceId: string;
  deploymentId?: string | null;
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface SyncRoutingPayload {
  projectId: string;
  serviceId: string;
  serviceName: string;
  subdomain: string | null;
  ingressPort: number;
  verifiedDomains: Array<{
    domain: string;
    targetPort: number | null;
  }>;
  runtimeMetadata?: RuntimeMetadata | null;
}

export function getDefaultAgentCapabilities(): AgentCapabilities {
  return {
    dockerApi: true,
    buildkit: true,
    localRegistry: true,
    localTraefik: true,
    hostMetrics: true,
    containerMetrics: true,
    runtimeLogs: true,
  };
}

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  const registryPort = Number.parseInt(process.env.NOUVA_AGENT_LOCAL_REGISTRY_PORT ?? "5000", 10);

  return {
    heartbeatIntervalSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_HEARTBEAT_INTERVAL_SECONDS ??
        String(DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS),
      10
    ),
    pollIntervalSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_POLL_INTERVAL_SECONDS ?? String(DEFAULT_AGENT_POLL_INTERVAL_SECONDS),
      10
    ),
    leaseTtlSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_LEASE_TTL_SECONDS ?? String(DEFAULT_AGENT_LEASE_TTL_SECONDS),
      10
    ),
    metricsIntervalSeconds: Number.parseInt(
      process.env.NOUVA_AGENT_METRICS_INTERVAL_SECONDS ??
        String(DEFAULT_AGENT_METRICS_INTERVAL_SECONDS),
      10
    ),
    ingressMode: "local_traefik",
    buildkitMode: "docker-container",
    capabilities: getDefaultAgentCapabilities(),
    localRegistryHost: process.env.NOUVA_AGENT_LOCAL_REGISTRY_HOST ?? "127.0.0.1",
    localRegistryPort: Number.isFinite(registryPort) ? registryPort : 5000,
    localTraefikNetwork: process.env.NOUVA_AGENT_INGRESS_NETWORK ?? "nouva-ingress",
  };
}

export function isLeaseActive(leaseExpiresAt: Date | null, now = new Date()): boolean {
  return Boolean(leaseExpiresAt && leaseExpiresAt.getTime() > now.getTime());
}

export function canLeaseWorkItem(
  item: Pick<AgentWorkRecord, "status" | "leaseExpiresAt">
): boolean {
  if (item.status === "queued") {
    return true;
  }

  if (item.status !== "leased") {
    return false;
  }

  return !isLeaseActive(item.leaseExpiresAt);
}

export interface AgentRegistrationRequest extends AgentRegistrationSnapshot {
  registrationToken: string;
}

export interface AgentRegistrationResponse {
  serverId: string;
  agentToken: string;
  config: AgentRuntimeConfig;
}

export type AgentHeartbeatRequest = AgentRegistrationSnapshot;

export interface AgentHeartbeatResponse {
  ok: true;
  config: AgentRuntimeConfig;
}

export interface AgentLeaseRequest {
  serverId: string;
  limit?: number;
}

export type AgentLeaseResponse = AgentWorkLeaseResult;

export interface AgentWorkMutationRequest {
  serverId: string;
  leaseId: string;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

export interface AgentWorkMutationResponse {
  ok: true;
}

export interface AgentMetricsRequest extends AgentMetricsEnvelope {
  serverId: string;
}

export interface AgentMetricsResponse {
  ok: true;
}

export interface AgentRuntimeLogsRequest {
  serverId: string;
  logs: AgentRuntimeLogBatch[];
}

export interface AgentRuntimeLogsResponse {
  ok: true;
  accepted: number;
}

export interface AgentErrorResponse {
  message: string;
}

export interface DockerVersionPayload {
  ApiVersion?: string;
  Version?: string;
}

export interface ParsedDockerStats {
  cpuUsageBasisPoints: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pidsCurrent: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function extractBlkioBytes(stats: Record<string, unknown>, operation: string): number | null {
  const blkioStats = toObject(stats.blkio_stats);
  const entries = Array.isArray(blkioStats.io_service_bytes_recursive)
    ? blkioStats.io_service_bytes_recursive
    : [];

  let total = 0;
  let found = false;
  for (const entry of entries) {
    const record = toObject(entry);
    if (String(record.op ?? "").toLowerCase() !== operation) {
      continue;
    }

    const value = toFiniteNumber(record.value);
    if (value === null) {
      continue;
    }

    total += value;
    found = true;
  }

  return found ? total : null;
}

export function negotiateDockerApiVersion(payload: DockerVersionPayload): string {
  const version = payload.ApiVersion?.trim();
  if (!version) {
    return "v1.41";
  }

  return version.startsWith("v") ? version : `v${version}`;
}

export function parseDockerStatsSnapshot(input: unknown): ParsedDockerStats {
  const stats = toObject(input);
  const cpuStats = toObject(stats.cpu_stats);
  const precpuStats = toObject(stats.precpu_stats);
  const cpuUsage = toObject(cpuStats.cpu_usage);
  const precpuUsage = toObject(precpuStats.cpu_usage);

  const totalUsage = toFiniteNumber(cpuUsage.total_usage);
  const previousTotalUsage = toFiniteNumber(precpuUsage.total_usage);
  const systemUsage = toFiniteNumber(cpuStats.system_cpu_usage);
  const previousSystemUsage = toFiniteNumber(precpuStats.system_cpu_usage);
  const onlineCpus =
    toFiniteNumber(cpuStats.online_cpus) ??
    (Array.isArray(cpuUsage.percpu_usage) ? cpuUsage.percpu_usage.length : null);

  let cpuUsageBasisPoints: number | null = null;
  if (
    totalUsage !== null &&
    previousTotalUsage !== null &&
    systemUsage !== null &&
    previousSystemUsage !== null &&
    onlineCpus !== null &&
    systemUsage > previousSystemUsage
  ) {
    const cpuDelta = totalUsage - previousTotalUsage;
    const systemDelta = systemUsage - previousSystemUsage;
    const cpuPercent = (cpuDelta / systemDelta) * Number(onlineCpus) * 100;
    cpuUsageBasisPoints = Math.max(0, Math.round(cpuPercent * 100));
  }

  const memoryStats = toObject(stats.memory_stats);
  const memoryUsageBytes = toFiniteNumber(memoryStats.usage);
  const memoryLimitBytes = toFiniteNumber(memoryStats.limit);

  const networks = toObject(stats.networks);
  let networkRxBytes = 0;
  let networkTxBytes = 0;
  let sawNetwork = false;
  for (const value of Object.values(networks)) {
    const network = toObject(value);
    const rx = toFiniteNumber(network.rx_bytes);
    const tx = toFiniteNumber(network.tx_bytes);
    if (rx !== null) {
      networkRxBytes += rx;
      sawNetwork = true;
    }
    if (tx !== null) {
      networkTxBytes += tx;
      sawNetwork = true;
    }
  }

  const pidsStats = toObject(stats.pids_stats);

  return {
    cpuUsageBasisPoints,
    memoryUsageBytes,
    memoryLimitBytes,
    networkRxBytes: sawNetwork ? networkRxBytes : null,
    networkTxBytes: sawNetwork ? networkTxBytes : null,
    blockReadBytes: extractBlkioBytes(stats, "read"),
    blockWriteBytes: extractBlkioBytes(stats, "write"),
    pidsCurrent: toFiniteNumber(pidsStats.current),
  };
}

export interface HostMetricsSnapshotInput {
  currentCpuStat: string;
  previousCpuStat?: string | null;
  meminfo: string;
  loadavg?: string | null;
  diskAvailableBytes?: number | null;
  diskTotalBytes?: number | null;
}

function parseProcStatLine(content: string): number[] | null {
  const cpuLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("cpu "));

  if (!cpuLine) {
    return null;
  }

  const values = cpuLine
    .split(/\s+/)
    .slice(1)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));

  return values.length > 0 ? values : null;
}

function parseMeminfoValue(content: string, key: string): number | null {
  const line = content
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}:`));

  if (!line) {
    return null;
  }

  const value = Number.parseInt(line.replace(`${key}:`, "").trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(value)) {
    return null;
  }

  return value * 1024;
}

function parseLoadavgMilli(content?: string | null): {
  loadAvg1mMilli: number | null;
  loadAvg5mMilli: number | null;
  loadAvg15mMilli: number | null;
} {
  if (!content) {
    return {
      loadAvg1mMilli: null,
      loadAvg5mMilli: null,
      loadAvg15mMilli: null,
    };
  }

  const [load1, load5, load15] = content.trim().split(/\s+/);

  const parseOne = (value: string | undefined) => {
    if (!value) {
      return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 1000) : null;
  };

  return {
    loadAvg1mMilli: parseOne(load1),
    loadAvg5mMilli: parseOne(load5),
    loadAvg15mMilli: parseOne(load15),
  };
}

export function parseHostMetricsSnapshot(
  input: HostMetricsSnapshotInput
): AgentServerMetricPayload {
  const currentCpu = parseProcStatLine(input.currentCpuStat);
  const previousCpu = parseProcStatLine(input.previousCpuStat ?? "");

  let cpuUsageBasisPoints: number | null = null;
  if (currentCpu && previousCpu && currentCpu.length >= 4 && previousCpu.length >= 4) {
    const currentIdle = (currentCpu[3] ?? 0) + (currentCpu[4] ?? 0);
    const previousIdle = (previousCpu[3] ?? 0) + (previousCpu[4] ?? 0);
    const currentTotal = currentCpu.reduce((sum, value) => sum + value, 0);
    const previousTotal = previousCpu.reduce((sum, value) => sum + value, 0);
    const totalDelta = currentTotal - previousTotal;
    const idleDelta = currentIdle - previousIdle;

    if (totalDelta > 0) {
      const usagePercent = (1 - idleDelta / totalDelta) * 100;
      cpuUsageBasisPoints = Math.max(0, Math.round(usagePercent * 100));
    }
  }

  const memoryTotalBytes = parseMeminfoValue(input.meminfo, "MemTotal");
  const memoryAvailableBytes = parseMeminfoValue(input.meminfo, "MemAvailable");
  const memoryUsedBytes =
    memoryTotalBytes !== null && memoryAvailableBytes !== null
      ? Math.max(0, memoryTotalBytes - memoryAvailableBytes)
      : null;

  const diskTotalBytes = input.diskTotalBytes ?? null;
  const diskAvailableBytes = input.diskAvailableBytes ?? null;
  const diskUsedBytes =
    diskTotalBytes !== null && diskAvailableBytes !== null
      ? Math.max(0, diskTotalBytes - diskAvailableBytes)
      : null;

  return {
    cpuUsageBasisPoints,
    memoryUsedBytes,
    memoryTotalBytes,
    diskUsedBytes,
    diskAvailableBytes,
    diskTotalBytes,
    ...parseLoadavgMilli(input.loadavg),
    raw: null,
    collectedAt: new Date().toISOString(),
  };
}

export interface LocalHttpRoute {
  fileKey: string;
  hostnames: string[];
  serviceUrl: string;
}

function quoteHostnames(hostnames: string[]): string {
  return hostnames.map((hostname) => `Host(\`${hostname}\`)`).join(" || ");
}

function serializeYaml(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export function buildLocalHttpRouteConfig(route: LocalHttpRoute): string {
  const routerName = `http-${route.fileKey}`;
  const serviceName = `svc-${route.fileKey}`;

  return serializeYaml([
    "http:",
    "  routers:",
    `    ${routerName}:`,
    `      rule: "${quoteHostnames(route.hostnames)}"`,
    "      entryPoints:",
    "        - web",
    `      service: ${serviceName}`,
    "  services:",
    `    ${serviceName}:`,
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: ${route.serviceUrl}`,
  ]);
}
