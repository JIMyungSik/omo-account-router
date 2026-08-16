/**
 * Per-account in-process refresh single-flight.
 * Daemon holds the only refresh authority so multi-OMO clients share this lock.
 */
export class AccountRefreshLock {
  private readonly inflight = new Map<string, Promise<unknown>>();

  async withLock<T>(accountKey: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(accountKey);
    if (existing) {
      return existing as Promise<T>;
    }
    const run = (async () => {
      try {
        return await fn();
      } finally {
        this.inflight.delete(accountKey);
      }
    })();
    this.inflight.set(accountKey, run);
    return run;
  }
}
