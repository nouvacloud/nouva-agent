import type { AgentServerMetricPayload } from "./agent.js";

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
