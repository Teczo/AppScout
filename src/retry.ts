/**
 * Retry an async operation with exponential backoff (max 3 attempts by
 * default), then rethrow the last error for the caller to handle gracefully.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    /** Return false to stop retrying and rethrow immediately (e.g. definitive "not found" errors). */
    shouldRetry?: (err: unknown) => boolean;
    onRetry?: (err: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err;
      lastError = err;
      if (attempt === maxAttempts) break;
      opts.onRetry?.(err, attempt);
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts: ${String(lastError)}`, {
    cause: lastError,
  });
}
