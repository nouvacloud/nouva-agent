export const REDACTED_LOG_VALUE = "[REDACTED]";
export const HIDDEN_ENVIRONMENT_COMMIT_MESSAGE = "[commit message hidden]";

const SENSITIVE_LOG_KEY_NAMES = new Set([
  "authorization",
  "body",
  "cookie",
  "credential",
  "formdata",
  "idempotencykey",
  "password",
  "payload",
  "proxyauthorization",
  "rawbody",
  "requestbody",
  "responsebody",
  "secret",
  "setcookie",
  "token",
]);

const SENSITIVE_ENVIRONMENT_NAMES = new Set([
  "connectionstring",
  "databaseurl",
  "environmentmapencryptionkeys",
  "redisurl",
]);

const SENSITIVE_TEXT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:authorization|cookie|idempotency[-_ ]?key|token|secret|password|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|signature|body|payload|formdata)[A-Za-z0-9_-]*)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\[[^\s,}\]]+\]|[^\s,}\]]+)/gi;
const SENSITIVE_HEADER_PATTERN =
  /\b(authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|idempotency[-_ ]?key)\b["']?\s*[:=]\s*[^\r\n]*/gi;
const SENSITIVE_QUERY_VALUE_PATTERN =
  /([?&][A-Za-z0-9_-]*(?:authorization|cookie|idempotency[-_ ]?key|token|secret|password|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|signature)[A-Za-z0-9_-]*=)([^&#\s]+)/gi;
const URI_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;
const BEARER_OR_BASIC_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const NOUVA_TOKEN_PATTERN = /\bnouva_v1_[A-Za-z0-9_-]+\b/g;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;

export type SafeLogLevel = "debug" | "info" | "warn" | "error";

export interface SafeLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface LogRedactionOptions {
  environmentVariables?: Readonly<Record<string, string | undefined>>;
  exactStructuredValues?: readonly string[];
  secretValues?: readonly string[];
}

export interface SafeLoggerOptions extends LogRedactionOptions {
  bindings?: Record<string, unknown>;
  write?: (line: string, level: SafeLogLevel) => void;
}

export interface SafeRequestLogInput {
  hostname?: string;
  method?: string;
  remoteAddress?: string;
  remotePort?: number;
  url?: string;
}

export interface SafeRequestLogSerializerOptions extends LogRedactionOptions {
  sanitizeUrl?: (value: string | undefined) => string;
}

export interface SafeSerializedError {
  [key: string]: unknown;
  message: string;
  stack: string;
  type: string;
}

function normalizeLogKey(value: string): string {
  return value.toLowerCase().replaceAll(/[-_.\s]/g, "");
}

function isSensitiveEnvironmentName(value: string): boolean {
  const normalized = normalizeLogKey(value);
  return (
    isSensitiveLogKey(value) ||
    SENSITIVE_ENVIRONMENT_NAMES.has(normalized) ||
    normalized.endsWith("dsn") ||
    normalized.endsWith("key") ||
    normalized.includes("privatekey")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) ? value : {};
}

function safeObjectEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    return [];
  }
}

function uniqueSortedSecretValues(secretValues: readonly string[]): string[] {
  return [...new Set(secretValues.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length
  );
}

function normalizedConfiguredSecretValues(secretValues: readonly string[]): string[] {
  return uniqueSortedSecretValues(
    secretValues.filter(
      (value) => value.length > 0 && value !== REDACTED_LOG_VALUE && value !== "undefined"
    )
  );
}

export function collectEnvironmentMapSecretValues(
  environmentVariables: Readonly<Record<string, string | undefined>>
): string[] {
  const secretValues: string[] = [];

  for (const [key, value] of Object.entries(environmentVariables)) {
    if (key.length > 0) {
      secretValues.push(key);
    }
    if (typeof value === "string" && value.length > 0) {
      secretValues.push(value);
    }
  }

  return uniqueSortedSecretValues(secretValues);
}

export function sanitizeEnvironmentCommitMessage(
  commitMessage: string,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): string;
export function sanitizeEnvironmentCommitMessage(
  commitMessage: null,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): null;
export function sanitizeEnvironmentCommitMessage(
  commitMessage: string | null,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): string | null;
export function sanitizeEnvironmentCommitMessage(
  commitMessage: string | null,
  environmentMaps: readonly Readonly<Record<string, string | undefined>>[]
): string | null {
  if (commitMessage === null) {
    return null;
  }
  const protectedMaterial = new Set(
    environmentMaps.flatMap((environmentMap) => collectEnvironmentMapSecretValues(environmentMap))
  );
  return [...protectedMaterial].some((token) => commitMessage.includes(token))
    ? HIDDEN_ENVIRONMENT_COMMIT_MESSAGE
    : commitMessage;
}

function resolveSecretValues(options: LogRedactionOptions): string[] {
  const configuredOrExplicitValues =
    options.secretValues === undefined
      ? collectConfiguredSecretValues()
      : uniqueSortedSecretValues(options.secretValues);
  const environmentValues = options.environmentVariables
    ? collectEnvironmentMapSecretValues(options.environmentVariables)
    : [];

  return uniqueSortedSecretValues([...configuredOrExplicitValues, ...environmentValues]);
}

function resolveExactStructuredValues(options: LogRedactionOptions): string[] {
  const environmentValues = options.environmentVariables
    ? collectEnvironmentMapSecretValues(options.environmentVariables)
    : [];
  return uniqueSortedSecretValues([
    ...(options.exactStructuredValues ?? []),
    ...resolveSecretValues(options),
    ...environmentValues,
  ]);
}

type LiteralSecretMatcherNode = {
  failure: number;
  maxOutputLength: number;
  transitions: Map<string, number>;
};

type LiteralSecretMatcher = readonly LiteralSecretMatcherNode[];

type CompiledLogRedaction = {
  exactStructuredValues: ReadonlySet<string>;
  longTextMatcher: LiteralSecretMatcher;
  shortTextValues: readonly string[];
};

export interface CompiledLogValueRedactor {
  hasExactStructuredValue(value: string): boolean;
  redactText(value: string): string;
  sanitize(value: unknown): unknown;
}

function createLiteralSecretMatcher(secretValues: readonly string[]): LiteralSecretMatcher {
  const nodes: LiteralSecretMatcherNode[] = [
    { failure: 0, maxOutputLength: 0, transitions: new Map() },
  ];
  for (const secretValue of secretValues) {
    let state = 0;
    for (let index = secretValue.length - 1; index >= 0; index -= 1) {
      const character = secretValue[index] ?? "";
      let nextState = nodes[state]?.transitions.get(character);
      if (nextState === undefined) {
        nextState = nodes.length;
        nodes[state]?.transitions.set(character, nextState);
        nodes.push({ failure: 0, maxOutputLength: 0, transitions: new Map() });
      }
      state = nextState;
    }
    const terminal = nodes[state];
    if (terminal) {
      terminal.maxOutputLength = Math.max(terminal.maxOutputLength, secretValue.length);
    }
  }

  const queue: number[] = [];
  for (const child of nodes[0]?.transitions.values() ?? []) {
    queue.push(child);
  }
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const state = queue[queueIndex];
    const node = state === undefined ? undefined : nodes[state];
    if (!node) {
      continue;
    }
    node.maxOutputLength = Math.max(
      node.maxOutputLength,
      nodes[node.failure]?.maxOutputLength ?? 0
    );
    for (const [character, child] of node.transitions) {
      let failure = node.failure;
      while (failure !== 0 && !nodes[failure]?.transitions.has(character)) {
        failure = nodes[failure]?.failure ?? 0;
      }
      const failureTransition = nodes[failure]?.transitions.get(character);
      nodes[child]!.failure = failureTransition ?? 0;
      queue.push(child);
    }
  }
  return nodes;
}

function compileLogRedaction(options: LogRedactionOptions): CompiledLogRedaction {
  const textValues = resolveSecretValues(options);
  const exactStructuredValues = resolveExactStructuredValues(options);
  return {
    exactStructuredValues: new Set(exactStructuredValues),
    longTextMatcher: createLiteralSecretMatcher(textValues.filter((value) => value.length >= 3)),
    shortTextValues: textValues.filter((value) => value.length <= 2),
  };
}

function isLexicalCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function isLexicalBoundaryMatch(value: string, start: number, length: number): boolean {
  return !isLexicalCharacter(value[start - 1]) && !isLexicalCharacter(value[start + length]);
}

function addShortLexicalMatches(
  value: string,
  shortTextValues: readonly string[],
  longestMatchAt: Uint32Array
): boolean {
  let hasMatch = false;
  for (const secretValue of shortTextValues) {
    let offset = value.indexOf(secretValue);
    while (offset !== -1) {
      if (
        isLexicalBoundaryMatch(value, offset, secretValue.length) &&
        secretValue.length > (longestMatchAt[offset] ?? 0)
      ) {
        longestMatchAt[offset] = secretValue.length;
        hasMatch = true;
      }
      offset = value.indexOf(secretValue, offset + 1);
    }
  }
  return hasMatch;
}

function redactLiteralSecretsWithMatcher(
  value: string,
  matcher: LiteralSecretMatcher,
  shortTextValues: readonly string[] = []
): string {
  if ((matcher.length <= 1 && shortTextValues.length === 0) || value.length === 0) {
    return value;
  }

  const longestMatchAt = new Uint32Array(value.length);
  let hasMatch = false;
  let state = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const character = value[index] ?? "";
    while (state !== 0 && !matcher[state]?.transitions.has(character)) {
      state = matcher[state]?.failure ?? 0;
    }
    state = matcher[state]?.transitions.get(character) ?? 0;
    const matchLength = matcher[state]?.maxOutputLength ?? 0;
    if (matchLength > 0) {
      longestMatchAt[index] = matchLength;
      hasMatch = true;
    }
  }
  hasMatch = addShortLexicalMatches(value, shortTextValues, longestMatchAt) || hasMatch;
  if (!hasMatch) {
    return value;
  }

  const redacted: string[] = [];
  let segmentStart = 0;
  let index = 0;
  while (index < value.length) {
    const matchLength = longestMatchAt[index] ?? 0;
    if (matchLength === 0) {
      index += 1;
      continue;
    }
    redacted.push(value.slice(segmentStart, index), REDACTED_LOG_VALUE);
    index += matchLength;
    segmentStart = index;
  }
  redacted.push(value.slice(segmentStart));
  return redacted.join("");
}

function redactTextWithSecretMatcher(
  value: string,
  matcher: LiteralSecretMatcher,
  shortTextValues: readonly string[] = []
): string {
  const redacted = redactLiteralSecretsWithMatcher(value, matcher, shortTextValues);

  return redacted
    .replace(SENSITIVE_HEADER_PATTERN, `$1=${REDACTED_LOG_VALUE}`)
    .replace(URI_USERINFO_PATTERN, `$1${REDACTED_LOG_VALUE}@`)
    .replace(SENSITIVE_QUERY_VALUE_PATTERN, `$1${REDACTED_LOG_VALUE}`)
    .replace(SENSITIVE_TEXT_PATTERN, `$1=${REDACTED_LOG_VALUE}`)
    .replace(BEARER_OR_BASIC_PATTERN, `$1 ${REDACTED_LOG_VALUE}`)
    .replace(NOUVA_TOKEN_PATTERN, REDACTED_LOG_VALUE)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED_LOG_VALUE);
}

function redactTextWithSecrets(value: string, secretValues: readonly string[]): string {
  const normalized = uniqueSortedSecretValues(secretValues);
  return redactTextWithSecretMatcher(
    value,
    createLiteralSecretMatcher(normalized.filter((entry) => entry.length >= 3)),
    normalized.filter((entry) => entry.length <= 2)
  );
}

function sanitizeStructuredText(value: string, redaction: CompiledLogRedaction): string {
  if (redaction.exactStructuredValues.has(value)) {
    return REDACTED_LOG_VALUE;
  }
  return redactTextWithSecretMatcher(value, redaction.longTextMatcher, redaction.shortTextValues);
}

function sanitizeValue(
  value: unknown,
  redaction: CompiledLogRedaction,
  seen: WeakSet<object>
): unknown {
  if (typeof value === "string") {
    if (redaction.exactStructuredValues.has(value)) {
      return REDACTED_LOG_VALUE;
    }
    return redactTextWithSecretMatcher(value, redaction.longTextMatcher, redaction.shortTextValues);
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol") {
    return "[Symbol]";
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  try {
    return sanitizeObjectValue(value, redaction, seen);
  } finally {
    seen.delete(value);
  }
}

function sanitizeObjectValue(
  value: object,
  redaction: CompiledLogRedaction,
  seen: WeakSet<object>
): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }

  if (value instanceof URL) {
    return redactTextWithSecretMatcher(
      value.toString(),
      redaction.longTextMatcher,
      redaction.shortTextValues
    );
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[Buffer ${value.byteLength} bytes]`;
  }

  if (value instanceof Uint8Array) {
    return `[Binary ${value.byteLength} bytes]`;
  }

  if (value instanceof URLSearchParams) {
    const result: Record<string, string[]> = {};
    for (const [key, entry] of value.entries()) {
      const safeKey = sanitizeStructuredText(key, redaction);
      const values = result[safeKey] ?? [];
      values.push(
        isSensitiveLogKey(key)
          ? REDACTED_LOG_VALUE
          : (sanitizeValue(entry, redaction, seen) as string)
      );
      result[safeKey] = values;
    }
    return result;
  }

  if (typeof Headers !== "undefined" && value instanceof Headers) {
    const result: Record<string, string> = {};
    for (const [key, entry] of value.entries()) {
      const safeKey = sanitizeStructuredText(key, redaction);
      result[safeKey] = isSensitiveLogKey(key)
        ? REDACTED_LOG_VALUE
        : (sanitizeValue(entry, redaction, seen) as string);
    }
    return result;
  }

  if (typeof FormData !== "undefined" && value instanceof FormData) {
    const result: Record<string, string[]> = {};
    for (const [key, entry] of value.entries()) {
      const safeKey = sanitizeStructuredText(key, redaction);
      const values = result[safeKey] ?? [];
      values.push(
        isSensitiveLogKey(key)
          ? REDACTED_LOG_VALUE
          : typeof entry === "string"
            ? (sanitizeValue(entry, redaction, seen) as string)
            : "[File]"
      );
      result[safeKey] = values;
    }
    return result;
  }

  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      message: sanitizeValue(value.message, redaction, seen),
      type: sanitizeValue(value.name || "Error", redaction, seen),
    };
    if (value.stack) {
      result.stack = sanitizeValue(value.stack, redaction, seen);
    }
    return result;
  }

  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => [
      sanitizeValue(key, redaction, seen),
      sanitizeValue(entry, redaction, seen),
    ]);
  }

  if (value instanceof Set) {
    return [...value].map((entry) => sanitizeValue(entry, redaction, seen));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, redaction, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of safeObjectEntries(value as Record<string, unknown>)) {
    const safeKey = sanitizeStructuredText(key, redaction);
    result[safeKey] = isSensitiveLogKey(key)
      ? REDACTED_LOG_VALUE
      : sanitizeValue(entry, redaction, seen);
  }
  return result;
}

function writeToConsole(line: string, level: SafeLogLevel): void {
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "debug") {
    console.debug(line);
    return;
  }
  console.log(line);
}

export function isSensitiveLogKey(value: string): boolean {
  const normalized = normalizeLogKey(value);
  return (
    SENSITIVE_LOG_KEY_NAMES.has(normalized) ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("credential") ||
    normalized.includes("idempotencykey") ||
    normalized.includes("password") ||
    normalized.includes("privatekey") ||
    normalized.includes("secret") ||
    normalized.includes("signature") ||
    normalized.includes("token") ||
    normalized.includes("apikey") ||
    normalized.includes("accesskey")
  );
}

export function collectConfiguredSecretValues(
  environment: Record<string, string | undefined> = process.env
): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string" || !isSensitiveEnvironmentName(key)) {
      continue;
    }
    values.push(value);
    if (normalizeLogKey(key) !== "environmentmapencryptionkeys") {
      continue;
    }
    try {
      const keyring = JSON.parse(value) as unknown;
      if (isRecord(keyring) && !Array.isArray(keyring)) {
        for (const keyValue of Object.values(keyring)) {
          if (typeof keyValue === "string") {
            values.push(keyValue);
          }
        }
      }
    } catch {
      // The complete malformed value is still treated as sensitive above.
    }
  }
  return normalizedConfiguredSecretValues(values);
}

export function redactLogText(value: string, options: LogRedactionOptions = {}): string {
  return redactTextWithSecrets(value, resolveSecretValues(options));
}

export function createLogTextRedactor(
  options: LogRedactionOptions = {}
): (value: string) => string {
  const redaction = compileLogRedaction(options);
  return (value) =>
    redactTextWithSecretMatcher(value, redaction.longTextMatcher, redaction.shortTextValues);
}

export function createLogValueRedactor(
  options: LogRedactionOptions = {}
): CompiledLogValueRedactor {
  const redaction = compileLogRedaction(options);
  return {
    hasExactStructuredValue: (value) => redaction.exactStructuredValues.has(value),
    redactText: (value) =>
      redactTextWithSecretMatcher(value, redaction.longTextMatcher, redaction.shortTextValues),
    sanitize: (value) => sanitizeValue(value, redaction, new WeakSet<object>()),
  };
}

export function formatJsonLogLevel(label: string): { level: string } {
  return { level: label };
}

export function sanitizeLogValue(value: unknown, options: LogRedactionOptions = {}): unknown {
  return createLogValueRedactor(options).sanitize(value);
}

export function sanitizeLogUrl(value: string | undefined): string {
  if (!value) {
    return "/";
  }
  return value.split(/[?#]/, 1)[0] || "/";
}

export function serializeSafeRequestForLog(
  request: SafeRequestLogInput,
  options: SafeRequestLogSerializerOptions = {}
): Record<string, unknown> {
  const redaction = compileLogRedaction(options);
  const sanitizeUrl = options.sanitizeUrl ?? sanitizeLogUrl;
  const redactText = (value: string): string =>
    redactTextWithSecretMatcher(value, redaction.longTextMatcher, redaction.shortTextValues);
  return {
    hostname: request.hostname === undefined ? undefined : redactText(request.hostname),
    method: request.method === undefined ? undefined : redactText(request.method),
    remoteAddress:
      request.remoteAddress === undefined ? undefined : redactText(request.remoteAddress),
    remotePort: request.remotePort,
    url: redactText(sanitizeUrl(request.url)),
  };
}

export function serializeSafeError(
  error: unknown,
  options: LogRedactionOptions = {}
): SafeSerializedError {
  const sanitized = sanitizeLogValue(error, options);
  if (isRecord(sanitized) && !Array.isArray(sanitized)) {
    return {
      message: typeof sanitized.message === "string" ? sanitized.message : "Unknown error",
      stack: typeof sanitized.stack === "string" ? sanitized.stack : "",
      type: typeof sanitized.type === "string" ? sanitized.type : "Error",
    };
  }

  return {
    message: typeof sanitized === "string" ? sanitized : "Unknown error",
    stack: "",
    type: "Error",
  };
}

export function createSafeLogger(options: SafeLoggerOptions = {}): SafeLogger {
  const write = options.write ?? writeToConsole;
  const redaction = compileLogRedaction(options);
  const emit = (
    level: SafeLogLevel,
    message: string,
    fields: Record<string, unknown> = {}
  ): void => {
    const bindings = asRecord(
      sanitizeValue(options.bindings ?? {}, redaction, new WeakSet<object>())
    );
    const safeFields = asRecord(sanitizeValue(fields, redaction, new WeakSet<object>()));
    const safeMessage = redactTextWithSecretMatcher(
      message,
      redaction.longTextMatcher,
      redaction.shortTextValues
    );
    const record = {
      ...bindings,
      ...safeFields,
      level,
      message: safeMessage,
    };

    try {
      write(JSON.stringify(record), level);
    } catch {
      try {
        write(JSON.stringify({ level, message: "Unable to serialize log entry" }), level);
      } catch {
        // Logging must not make a control-plane process unavailable.
      }
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    error: (message, fields) => emit("error", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
  };
}
