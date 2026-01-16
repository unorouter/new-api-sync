export type LogLevel = "debug" | "info" | "warn" | "error";

let verboseMode = false;

export function setVerbose(verbose: boolean) {
  verboseMode = verbose;
}

function getTimestamp(): string {
  return new Date().toISOString();
}

function getPrefix(level: LogLevel): string {
  const prefixes = {
    debug: "[DEBUG]",
    info: "[INFO]",
    warn: "[WARN]",
    error: "[ERROR]",
  };
  return prefixes[level];
}

export function log(level: LogLevel, message: string, ...args: unknown[]) {
  if (level === "debug" && !verboseMode) return;

  const timestamp = getTimestamp();
  const prefix = getPrefix(level);

  console.log(`${timestamp} ${prefix} ${message}`, ...args);
}

export function logDebug(message: string, ...args: unknown[]) {
  log("debug", message, ...args);
}

export function logInfo(message: string, ...args: unknown[]) {
  log("info", message, ...args);
}

export function logWarn(message: string, ...args: unknown[]) {
  log("warn", message, ...args);
}

export function logError(message: string, ...args: unknown[]) {
  log("error", message, ...args);
}

/**
 * Fetch JSON from URL with error handling
 */
export async function fetchJson<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        logWarn(
          `Retry ${i + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError!;
}
