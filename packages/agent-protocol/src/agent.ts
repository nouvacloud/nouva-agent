import type {
  AgentCapabilities,
  AgentWorkKind,
  AgentWorkStatus,
  RuntimeMetadata,
  ServerValidationReport,
} from "./types.js";

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

export interface AgentWorkLeaseResult {
  config: AgentRuntimeConfig;
  workItems: AgentWorkRecord[];
}

export interface UpdateAgentPayload {
  imageTag: string;
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
  runtimeMetadata?: RuntimeMetadata | null;
}

export interface DatabaseProvisionPayload {
  projectId: string;
  serviceId: string;
  serviceName: string;
  variant: "postgres" | "redis";
  version: string;
  credentials: Record<string, string>;
  internalPort: number;
  storageSizeGb: number;
  externalHost: string | null;
  externalPort: number | null;
  publicAccessEnabled: boolean;
  runtimeMetadata?: RuntimeMetadata | null;
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
