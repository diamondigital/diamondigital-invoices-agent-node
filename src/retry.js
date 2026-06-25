// src/retry.js — Exponential backoff retry wrapper

/**
 * Wraps an async function with exponential backoff retry.
 * @param {Function} fn - async function to retry
 * @param {Object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.baseDelayMs=1000]
 * @param {number} [opts.maxDelayMs=30000]
 * @returns {Function} wrapped function
 */
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
