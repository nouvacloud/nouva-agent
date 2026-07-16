const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;
const URL_CREDENTIALS_PATTERN = /\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(URL_CREDENTIALS_PATTERN, "$1[REDACTED]@")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]");
}
