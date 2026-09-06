import {
  collectConfiguredSecretValues,
  collectEnvironmentMapValues,
  redactLogText,
  sanitizeLogValue,
} from "@repo/runtime/logging";

export type EnvironmentVariableMap = Readonly<Record<string, string | undefined>>;

/**
 * `operationalValues` are the exact plaintext strings the leased payload itself declares — the
 * paths (`dataPath`, `mountPath`) and the service identity the control plane generated (provided
 * hostname, custom domains, container and network names, image reference); see
 * `collectAgentWorkPayloadOperationalValues` in `@repo/runtime/logging`. They are exempt from
 * redaction even when an environment value such as `PGDATA` or `PHX_HOST` is identical, because
 * the control plane already holds them unencrypted.
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

/**
 * Sanitizes a protocol field whose redacted copy is compared against the original to detect a leak.
 * Unlike `sanitizeSensitiveValue` this protects variable *values* only: protocol fields carry
 * platform-generated strings, so a variable *name* matching one is not a leak, and treating names
 * as protected material turned healthy deployments into permanent failures (#187).
 */
export function sanitizeSensitiveProtocolValue(
  value: unknown,
  environmentVariables: EnvironmentVariableMap,
  operationalValues: readonly string[] = []
): unknown {
  return sanitizeLogValue(value, {
    operationalValues,
    secretValues: [
      ...collectConfiguredSecretValues(),
      ...collectEnvironmentMapValues(environmentVariables),
    ],
  });
}
