export interface DockerResourceSettings {
  NanoCpus: number;
  Memory: number;
  MemorySwap: number;
  PidsLimit: number;
}

function toPositiveIntegerField(
  value: unknown,
  fieldName: "cpuMillicores" | "memoryBytes" | "memoryAndSwapBytes" | "pidsLimit"
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    const unit =
      fieldName === "cpuMillicores" ? "millicores" : fieldName === "pidsLimit" ? "PIDs" : "bytes";
    throw new Error(
      `Invalid resourceLimits.${fieldName}: expected a positive integer number of ${unit}`
    );
  }

  return value;
}

/**
 * Docker's `MemorySwap` is the combined RAM-and-swap ceiling, and setting it equal to `Memory` is
 * how Docker documents "no swap allowance" — which is what a payload without the field must keep
 * meaning, both for services that never asked for swap and for control planes older than #231.
 *
 * A ceiling below the RAM limit is refused by the daemon ("Minimum memoryswap limit should be
 * larger than memory limit"), so it is refused here instead, where the failure names the field.
 * Unlimited swap (`-1`) is deliberately not reachable: the point of the setting is a bounded
 * allowance on a customer-owned host.
 */
function resolveMemoryAndSwapBytes(value: unknown, memoryBytes: number): number {
  if (typeof value === "undefined") {
    return memoryBytes;
  }

  const memoryAndSwapBytes = toPositiveIntegerField(value, "memoryAndSwapBytes");

  if (memoryAndSwapBytes < memoryBytes) {
    throw new Error(
      `Invalid resourceLimits.memoryAndSwapBytes: ${memoryAndSwapBytes} is below the ` +
        `${memoryBytes} byte memory limit it must include`
    );
  }

  return memoryAndSwapBytes;
}

export function toDockerResourceSettings(resourceLimits: unknown): DockerResourceSettings {
  if (
    typeof resourceLimits !== "object" ||
    resourceLimits === null ||
    Array.isArray(resourceLimits)
  ) {
    throw new Error(
      "Invalid resourceLimits payload: expected complete effective CPU, memory, and PID limits"
    );
  }

  const record = resourceLimits as Record<string, unknown>;
  const hasCpuMillicores = Object.hasOwn(record, "cpuMillicores");
  const hasMemoryBytes = Object.hasOwn(record, "memoryBytes");
  const hasPidsLimit = Object.hasOwn(record, "pidsLimit");

  if (!hasCpuMillicores || !hasMemoryBytes || !hasPidsLimit) {
    throw new Error(
      "Invalid resourceLimits payload: expected complete effective CPU, memory, and PID limits"
    );
  }

  const memoryBytes = toPositiveIntegerField(record.memoryBytes, "memoryBytes");
  const pidsLimit = toPositiveIntegerField(record.pidsLimit, "pidsLimit");

  return {
    NanoCpus: toPositiveIntegerField(record.cpuMillicores, "cpuMillicores") * 1_000_000,
    Memory: memoryBytes,
    MemorySwap: resolveMemoryAndSwapBytes(record.memoryAndSwapBytes, memoryBytes),
    PidsLimit: pidsLimit,
  };
}

/**
 * Docker accepts a `docker update` and reports success even when the daemon keeps a field it could
 * not apply, so the reconciliation path reads the container back and compares. Without this an
 * allowance that never reached the cgroup would still be reported as applied, which is the failure
 * mode #231 is about: the stored policy and the running container silently disagree.
 */
export function assertAppliedDockerResourceSettings(input: {
  containerId: string;
  requested: DockerResourceSettings;
  applied: Partial<DockerResourceSettings> | undefined;
}): void {
  const mismatches = (Object.keys(input.requested) as Array<keyof DockerResourceSettings>)
    .filter((field) => input.applied?.[field] !== input.requested[field])
    .map(
      (field) =>
        `${field} ${input.applied?.[field] ?? "unset"} (expected ${input.requested[field]})`
    );

  if (mismatches.length > 0) {
    throw new Error(
      `Container ${input.containerId} did not apply the requested resource limits: ${mismatches.join(", ")}`
    );
  }
}
