export function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
  } = opts;

  return async function (...args) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn.apply(this, args);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt - 1),
            maxDelayMs
          );
          console.warn(
            `[retry] Attempt ${attempt}/${maxAttempts} failed: ${error.message}. Retrying in ${delay}ms...`
          );
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    console.error(`[retry] FAILED after ${maxAttempts} attempts: ${lastError.message}`);
    throw lastError;
  };
}
