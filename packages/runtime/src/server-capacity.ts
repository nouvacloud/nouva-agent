export const GIBIBYTE = 1024 * 1024 * 1024;
/** Docker storage totals ride the heartbeat, which defaults to every 30 seconds. */
export const MANAGED_VOLUME_TELEMETRY_FRESHNESS_MS = 90 * 1000;
/** Per-volume usage is sampled on a much slower loop because it costs a directory walk per volume. */
export const MANAGED_VOLUME_USAGE_FRESHNESS_MS = 15 * 60 * 1000;
export const MIN_DISK_SAFETY_RESERVE_BYTES = 5 * GIBIBYTE;

const RESOURCE_LIMIT_STEP_BYTES = GIBIBYTE / 4;
const SAFE_STORAGE_FREE_DISK_RATIO = 0.95;

export interface ServerCapacitySnapshot {
  cpuCores?: number | null;
  memoryBytes?: number | null;
  diskBytesAvailable?: number | null;
  diskTotalBytes?: number | null;
}

export interface ServerCapacityLimits {
  maxCpuMillicores: number | null;
  maxMemoryBytes: number | null;
  safeStorageSizeGb: number | null;
}

export type StorageTelemetryStatus = "fresh" | "stale" | "missing";

export interface ManagedVolumeReservationSnapshot {
  id: string;
  sizeGb: number;
  usedBytes?: number | null;
  usageRefreshedAt?: Date | string | null;
}

export interface StorageReservationCapacity {
  semantics: "reservation";
  quotaEnforced: false;
  telemetryStatus: StorageTelemetryStatus;
  diskTotalBytes: number | null;
  diskAvailableBytes: number | null;
  safetyReserveBytes: number | null;
  committedReservationBytes: number;
  creditedUsageBytes: number;
  reservableBytes: number | null;
  availableReservationBytes: number | null;
  overcommitBytes: number;
}

export interface StorageReservationCapacityInput {
  diskTotalBytes?: number | null;
  diskAvailableBytes?: number | null;
  telemetryRefreshedAt?: Date | string | null;
  volumes: ManagedVolumeReservationSnapshot[];
  now?: Date;
}

export interface CapacityQuantity {
  cpuMillicores: number;
  memoryBytes: number;
}

export interface ServerCapacityBudget {
  total: CapacityQuantity;
  platformReserve: CapacityQuantity;
  buildReserve: CapacityQuantity;
  allocatable: CapacityQuantity;
}

const CPU_STEP_MILLICORES = 250;
const MEMORY_STEP_BYTES = 128 * 1024 * 1024;
const MEBIBYTE = 1024 * 1024;

/**
 * Capacity a server keeps back from workloads.
 *
 * A nominal "2 GB" VPS reports roughly 1.9 GiB, and Nouva treats that as the smallest supported
 * server. The reserves therefore scale with the host instead of using fixed floors that would
 * consume the whole machine: on a 2 GB host they leave ~1.25 GiB allocatable (one app plus one
 * managed database), while larger hosts converge on 10% + 15% of their capacity.
 */
export const PLATFORM_RESERVE_POLICY = {
  cpuRatio: 0.1,
  minCpuMillicores: 250,
  memoryRatio: 0.1,
  minMemoryBytes: 256 * MEBIBYTE,
} as const;

/**
 * Capacity kept back for the scoped BuildKit daemon a deploy starts.
 *
 * This is the single source of truth for both sides: the control plane subtracts it from
 * `allocatable`, and the agent caps the builder container with `calculateBuildReserve()` from the
 * same numbers. They used to be written twice with different floors — 256 MiB reserved against
 * 1 GiB granted — so on a 2 GB host the control plane published memory a builder was already
 * entitled to take (#182).
 *
 * The floor is a trade: it is what a builder gets on the smallest supported server, and every byte
 * of it comes straight out of what the user can allocate. 512 MiB keeps a nominal 2 GB host at
 * 1 GiB allocatable, which is still one app plus one managed database.
 */
export const BUILD_RESERVE_POLICY = {
  cpuRatio: 0.15,
  minCpuMillicores: 500,
  maxCpuMillicores: 2000,
  memoryRatio: 0.15,
  minMemoryBytes: 512 * MEBIBYTE,
  maxMemoryBytes: 2 * GIBIBYTE,
} as const;

/**
 * Resources a build is entitled to on a host of this size.
 *
 * The agent applies exactly this to the BuildKit container, so whatever the control plane withholds
 * is what a builder can actually take.
 */
export function calculateBuildReserve(total: CapacityQuantity): CapacityQuantity {
  return {
    cpuMillicores: Math.min(
      BUILD_RESERVE_POLICY.maxCpuMillicores,
      Math.max(
        BUILD_RESERVE_POLICY.minCpuMillicores,
        Math.ceil(total.cpuMillicores * BUILD_RESERVE_POLICY.cpuRatio)
      )
    ),
    memoryBytes: Math.min(
      BUILD_RESERVE_POLICY.maxMemoryBytes,
      Math.max(
        BUILD_RESERVE_POLICY.minMemoryBytes,
        Math.ceil(total.memoryBytes * BUILD_RESERVE_POLICY.memoryRatio)
      )
    ),
  };
}

function roundDown(value: number, step: number): number {
  return Math.max(0, Math.floor(value / step) * step);
}

export function calculateServerCapacityBudget(
  input: Pick<ServerCapacitySnapshot, "cpuCores" | "memoryBytes">
): ServerCapacityBudget | null {
  const cpuCores = toFinitePositiveInteger(input.cpuCores);
  const memoryBytes = toFinitePositiveInteger(input.memoryBytes);
  if (cpuCores === null || memoryBytes === null) {
    return null;
  }

  const total = {
    cpuMillicores: cpuCores * 1000,
    memoryBytes,
  };
  const platformReserve = {
    cpuMillicores: Math.max(
      PLATFORM_RESERVE_POLICY.minCpuMillicores,
      Math.ceil(total.cpuMillicores * PLATFORM_RESERVE_POLICY.cpuRatio)
    ),
    memoryBytes: Math.max(
      PLATFORM_RESERVE_POLICY.minMemoryBytes,
      Math.ceil(total.memoryBytes * PLATFORM_RESERVE_POLICY.memoryRatio)
    ),
  };
  const buildReserve = calculateBuildReserve(total);

  return {
    total,
    platformReserve,
    buildReserve,
    allocatable: {
      cpuMillicores: roundDown(
        total.cpuMillicores - platformReserve.cpuMillicores - buildReserve.cpuMillicores,
        CPU_STEP_MILLICORES
      ),
      memoryBytes: roundDown(
        total.memoryBytes - platformReserve.memoryBytes - buildReserve.memoryBytes,
        MEMORY_STEP_BYTES
      ),
    },
  };
}

function toFinitePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.trunc(value);
}

function toFiniteNonNegativeInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.trunc(value);
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isFresh(
  value: Date | string | null | undefined,
  now: Date,
  freshnessMs = MANAGED_VOLUME_TELEMETRY_FRESHNESS_MS
): boolean {
  const timestamp = toTimestamp(value);
  return (
    timestamp !== null && timestamp <= now.getTime() && now.getTime() - timestamp <= freshnessMs
  );
}

export function calculateDiskSafetyReserveBytes(diskTotalBytes: number): number {
  return Math.max(MIN_DISK_SAFETY_RESERVE_BYTES, Math.ceil(diskTotalBytes * 0.05));
}

export function calculateStorageReservationCapacity(
  input: StorageReservationCapacityInput
): StorageReservationCapacity {
  const now = input.now ?? new Date();
  const diskTotalBytes = toFinitePositiveInteger(input.diskTotalBytes);
  const diskAvailableBytes = toFiniteNonNegativeInteger(input.diskAvailableBytes);
  const telemetryTimestamp = toTimestamp(input.telemetryRefreshedAt);
  const telemetryStatus: StorageTelemetryStatus =
    diskTotalBytes === null || diskAvailableBytes === null || telemetryTimestamp === null
      ? "missing"
      : isFresh(input.telemetryRefreshedAt, now)
        ? "fresh"
        : "stale";
  const committedReservationBytes = input.volumes.reduce(
    (total, volume) => total + Math.max(0, Math.trunc(volume.sizeGb)) * GIBIBYTE,
    0
  );
  const creditedUsageBytes = input.volumes.reduce((total, volume) => {
    if (!isFresh(volume.usageRefreshedAt, now, MANAGED_VOLUME_USAGE_FRESHNESS_MS)) {
      return total;
    }
    const usedBytes = toFiniteNonNegativeInteger(volume.usedBytes);
    if (usedBytes === null) {
      return total;
    }
    const reservedBytes = Math.max(0, Math.trunc(volume.sizeGb)) * GIBIBYTE;
    return total + Math.min(usedBytes, reservedBytes);
  }, 0);

  if (telemetryStatus !== "fresh" || diskTotalBytes === null || diskAvailableBytes === null) {
    return {
      semantics: "reservation",
      quotaEnforced: false,
      telemetryStatus,
      diskTotalBytes,
      diskAvailableBytes,
      safetyReserveBytes:
        diskTotalBytes === null ? null : calculateDiskSafetyReserveBytes(diskTotalBytes),
      committedReservationBytes,
      creditedUsageBytes,
      reservableBytes: null,
      availableReservationBytes: null,
      overcommitBytes: 0,
    };
  }

  const safetyReserveBytes = calculateDiskSafetyReserveBytes(diskTotalBytes);
  const reservableBytes = Math.max(0, diskAvailableBytes + creditedUsageBytes - safetyReserveBytes);

  return {
    semantics: "reservation",
    quotaEnforced: false,
    telemetryStatus,
    diskTotalBytes,
    diskAvailableBytes,
    safetyReserveBytes,
    committedReservationBytes,
    creditedUsageBytes,
    reservableBytes,
    availableReservationBytes: Math.max(0, reservableBytes - committedReservationBytes),
    overcommitBytes: Math.max(0, committedReservationBytes - reservableBytes),
  };
}

export function getServerCapacityLimits(
  input: ServerCapacitySnapshot | null | undefined
): ServerCapacityLimits {
  const cpuCores = toFinitePositiveInteger(input?.cpuCores ?? null);
  const memoryBytes = toFinitePositiveInteger(input?.memoryBytes ?? null);
  const diskBytesAvailable = toFiniteNonNegativeInteger(input?.diskBytesAvailable ?? null);

  return {
    maxCpuMillicores: cpuCores === null ? null : cpuCores * 1000,
    maxMemoryBytes:
      memoryBytes === null
        ? null
        : Math.max(
            0,
            Math.floor(memoryBytes / RESOURCE_LIMIT_STEP_BYTES) * RESOURCE_LIMIT_STEP_BYTES
          ),
    safeStorageSizeGb:
      diskBytesAvailable === null
        ? null
        : Math.max(0, Math.floor((diskBytesAvailable / GIBIBYTE) * SAFE_STORAGE_FREE_DISK_RATIO)),
  };
}
