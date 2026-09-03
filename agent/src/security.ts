import {
  collectConfiguredSecretValues,
  collectEnvironmentMapSecretValues,
  redactLogText,
  sanitizeLogValue,
} from "@repo/runtime/logging";

export type EnvironmentVariableMap = Readonly<Record<string, string | undefined>>;

/**
 * `operationalValues` are the exact plaintext paths the leased payload itself declares
 * (`dataPath`, `mountPath`); see `collectAgentWorkPayloadOperationalValues` in
 * `@repo/runtime/logging`. They are exempt from redaction even when an environment value such as
 * `PGDATA` is identical, because the control plane already holds them unencrypted.
 */
export function redactSensitiveText(
  value: string,
  environmentVariables?: EnvironmentVariableMap,
  operationalValues: readonly string[] = []
): string {
  return redactLogText(value, {
    ...(environmentVariables ? { environmentVariables } : {}),
    operationalValues,
  });
}

export function sanitizeSensitiveValue(
  value: unknown,
  environmentVariables?: EnvironmentVariableMap,
  operationalValues: readonly string[] = []
): unknown {
  return sanitizeLogValue(value, {
    ...(environmentVariables ? { environmentVariables } : {}),
    operationalValues,
  });
}

export function sanitizeSensitiveProtocolValue(
  value: unknown,
  environmentVariables: EnvironmentVariableMap,
  operationalValues: readonly string[] = []
): unknown {
  return sanitizeLogValue(value, {
    environmentVariables,
    operationalValues,
    secretValues: [
      ...collectConfiguredSecretValues(),
      ...collectEnvironmentMapSecretValues(environmentVariables),
    ],
  });
}
