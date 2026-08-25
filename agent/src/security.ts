import {
  collectConfiguredSecretValues,
  collectEnvironmentMapSecretValues,
  redactLogText,
  sanitizeLogValue,
} from "@repo/runtime/logging";

export type EnvironmentVariableMap = Readonly<Record<string, string | undefined>>;

export function redactSensitiveText(
  value: string,
  environmentVariables?: EnvironmentVariableMap
): string {
  return redactLogText(value, environmentVariables ? { environmentVariables } : {});
}

export function sanitizeSensitiveValue(
  value: unknown,
  environmentVariables?: EnvironmentVariableMap
): unknown {
  return sanitizeLogValue(value, environmentVariables ? { environmentVariables } : {});
}

export function sanitizeSensitiveProtocolValue(
  value: unknown,
  environmentVariables: EnvironmentVariableMap
): unknown {
  return sanitizeLogValue(value, {
    environmentVariables,
    secretValues: [
      ...collectConfiguredSecretValues(),
      ...collectEnvironmentMapSecretValues(environmentVariables),
    ],
  });
}
