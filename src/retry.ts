export async function withRetry<T>(
  task: () => Promise<T>,
  attempts: number,
  delayMs: number,
  label: string
): Promise<T> {
  let lastError: unknown;

  for (let tryCount = 1; tryCount <= attempts; tryCount += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const details = error instanceof Error ? error.message : String(error);
      // A source that is refusing us will refuse the retry too, and each one
      // deepens the block. Give up on this keyword and let the next cycle try.
      if ((error as { rateLimited?: boolean })?.rateLimited) {
        console.warn(`${label}: rate limited, not retrying (${details})`);
        break;
      }
      if (tryCount === attempts) {
        console.error(`${label}: failed after ${attempts} attempts (${details})`);
        break;
      }
      const wait = delayMs * tryCount;
      console.warn(`${label}: attempt ${tryCount}/${attempts} failed (${details}), retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label}: unknown error`);
}
