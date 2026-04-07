export interface DockerResourceSettings {
  NanoCpus?: number;
  Memory?: number;
}

function toPositiveIntegerField(
  value: unknown,
  fieldName: "cpuMillicores" | "memoryBytes"
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    const unit = fieldName === "cpuMillicores" ? "millicores" : "bytes";
    throw new Error(
      `Invalid resourceLimits.${fieldName}: expected a positive integer number of ${unit}`
    );
  }

  return value;
}

export function toDockerResourceSettings(resourceLimits: unknown): DockerResourceSettings {
  if (resourceLimits === null || typeof resourceLimits === "undefined") {
    return {};
  }

  if (
    typeof resourceLimits !== "object" ||
    resourceLimits === null ||
    Array.isArray(resourceLimits)
  ) {
    throw new Error(
      "Invalid resourceLimits payload: expected an object with cpuMillicores and/or memoryBytes, or null for unlimited"
    );
  }

  const record = resourceLimits as Record<string, unknown>;
  const hasCpuMillicores = Object.hasOwn(record, "cpuMillicores");
  const hasMemoryBytes = Object.hasOwn(record, "memoryBytes");

  if (!hasCpuMillicores && !hasMemoryBytes) {
    throw new Error(
      "Invalid resourceLimits payload: provide cpuMillicores and/or memoryBytes, or null for unlimited"
    );
  }

  const settings: DockerResourceSettings = {};

  if (hasCpuMillicores) {
    settings.NanoCpus = toPositiveIntegerField(record.cpuMillicores, "cpuMillicores") * 1_000_000;
  }

  if (hasMemoryBytes) {
    settings.Memory = toPositiveIntegerField(record.memoryBytes, "memoryBytes");
  }

  return settings;
}
