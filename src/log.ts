import pino from "pino";
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "token",
    "cookie",
    "headers",
    "password",
    "err.config",
    "err.request",
  ],
});
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bot\d+:[\w-]+/g, "bot[REDACTED]")
    .replace(/\d{6,}:[\w-]{20,}/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^/\s]+@/g, "$1[REDACTED]@")
    .slice(0, 800);
}
