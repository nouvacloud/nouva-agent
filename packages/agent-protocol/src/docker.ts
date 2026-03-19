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
