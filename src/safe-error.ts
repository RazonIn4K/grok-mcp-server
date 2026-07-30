const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /xai-[A-Za-z0-9_-]+/g,
];

export function redactSecrets(value: string): string {
  return secretPatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

export interface SafeErrorDetails {
  name: string;
  message: string;
  code?: string;
  status?: number;
}

export function toSafeError(error: unknown): SafeErrorDetails {
  if (!(error instanceof Error)) {
    return {
      name: "UnknownError",
      message: redactSecrets(String(error)),
    };
  }

  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.response?.status ?? candidate.status;

  return {
    name: candidate.name,
    message: redactSecrets(candidate.message),
    ...(typeof candidate.code === "string" && { code: candidate.code }),
    ...(typeof status === "number" && { status }),
  };
}
