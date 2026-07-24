export interface DockerResourceSettings {
  NanoCpus: number;
  Memory: number;
  MemorySwap: number;
  PidsLimit: number;
}

function toPositiveIntegerField(
  value: unknown,
  fieldName: "cpuMillicores" | "memoryBytes" | "pidsLimit"
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    const unit =
      fieldName === "cpuMillicores" ? "millicores" : fieldName === "memoryBytes" ? "bytes" : "PIDs";
    throw new Error(
      `Invalid resourceLimits.${fieldName}: expected a positive integer number of ${unit}`
    );
  }

  return value;
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
    MemorySwap: memoryBytes,
    PidsLimit: pidsLimit,
  };
}
