export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export function defaultShouldRetry(error: unknown): boolean {
  if (!error) return true;

  const status = (error as { response?: { status?: number } }).response?.status;

  if (status === undefined) return true;
  if (status >= 500) return true;
  if (status === 429) return true;

  return false;
}

export function withRetry<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: RetryOptions = {},
): (...args: A) => Promise<R> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    shouldRetry = defaultShouldRetry,
  } = opts;

  return async function (this: unknown, ...args: A): Promise<R> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn.apply(this, args);
      } catch (error) {
        lastError = error;

        if (!shouldRetry(error, attempt)) {
          console.error(`[retry] Non-retryable error, not retrying: ${(error as Error).message}`);
          throw error;
        }

        if (attempt < maxAttempts) {
          const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt - 1),
            maxDelayMs,
          );
          console.warn(
            `[retry] Attempt ${attempt}/${maxAttempts} failed: ${(error as Error).message}. Retrying in ${delay}ms...`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    console.error(`[retry] FAILED after ${maxAttempts} attempts: ${(lastError as Error).message}`);
    throw lastError;
  };
}
