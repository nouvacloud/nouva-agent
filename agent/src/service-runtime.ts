import type { DatabaseProvisionPayload } from "./protocol.js";

interface ResolvedDatabaseProvisionSpec {
  image: string;
  envVars: Record<string, string>;
  containerArgs: string[];
  dataPath: string;
  internalPort: number;
}

function toRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      next[key] = entry;
    }
  }
  return next;
}

function hasExecutorFields(
  payload: DatabaseProvisionPayload
): payload is DatabaseProvisionPayload & {
  imageUrl: string;
  envVars: Record<string, unknown>;
  containerArgs: unknown[];
  dataPath: string;
} {
  return (
    typeof payload.imageUrl === "string" &&
    payload.imageUrl.length > 0 &&
    typeof payload.dataPath === "string" &&
    payload.dataPath.length > 0 &&
    typeof payload.envVars === "object" &&
    payload.envVars !== null &&
    Array.isArray(payload.containerArgs)
  );
}

export function resolveDatabaseProvisionSpec(
  payload: DatabaseProvisionPayload
): ResolvedDatabaseProvisionSpec {
  if (!hasExecutorFields(payload)) {
    throw new Error(
      "Database payload is missing hydrated executor fields (imageUrl, envVars, containerArgs, dataPath). " +
        "The control plane must hydrate these via buildDatabaseProvisionExecutorConfig before dispatching work."
    );
  }

  return {
    image: payload.imageUrl,
    envVars: toRecord(payload.envVars),
    containerArgs: payload.containerArgs.filter(
      (value): value is string => typeof value === "string"
    ),
    dataPath: payload.dataPath,
    internalPort: payload.internalPort,
  };
}
