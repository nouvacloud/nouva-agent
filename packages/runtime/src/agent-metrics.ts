/**
 * Docker recomputes local volume sizes by walking each volume directory on every /system/df call,
 * so the agent reports usage on this slow cadence rather than with the rest of its telemetry.
 *
 * The volumes router derives its stale threshold from this value as `interval * 2 + 60s`, and that
 * threshold must stay under `MANAGED_VOLUME_USAGE_FRESHNESS_MS` in `./server-capacity.js` (15
 * minutes) — otherwise the UI keeps reporting usage as current after reservation admission has
 * already started rejecting it as stale. That caps this interval at 7 minutes.
 */
export const AGENT_VOLUME_METRICS_INTERVAL_MS = 5 * 60 * 1000;

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

export interface AgentVolumeMetricPayload {
  volumeName: string;
  usedBytes: number;
  raw?: Record<string, unknown> | null;
  collectedAt: string;
}

/**
 * Every section is optional so the agent can report volume usage on its own cadence without
 * also pushing host and per-container samples, which Alloy owns when observability is enabled.
 */
export interface AgentMetricsEnvelope {
  server?: AgentServerMetricPayload | null;
  services?: AgentServiceMetricPayload[];
  volumes?: AgentVolumeMetricPayload[];
}

export interface AgentMetricsRequest extends AgentMetricsEnvelope {
  serverId: string;
}

export interface AgentMetricsResponse {
  ok: true;
}
