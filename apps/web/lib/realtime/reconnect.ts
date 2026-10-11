export const RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;

type ReconnectOptions<T> = {
  reconnect: (attempt: number) => Promise<T>;
  sleep?: (delayMs: number) => Promise<void>;
};

export class ReconnectExhaustedError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Realtime reconnect failed after three attempts");
    this.name = "ReconnectExhaustedError";
    this.cause = cause;
  }
}

export class ReconnectCancelledError extends Error {
  constructor() {
    super("Realtime reconnect was cancelled");
    this.name = "ReconnectCancelledError";
  }
}

export class BoundedReconnect<T> {
  private running: Promise<T> | null = null;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private cancelled = false;
  private resolveCancellation: () => void = () => undefined;
  private readonly cancellation = new Promise<void>((resolve) => { this.resolveCancellation = resolve; });

  constructor(private readonly options: ReconnectOptions<T>) {
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  run(): Promise<T> {
    this.running ??= this.attempt().finally(() => { this.running = null; });
    return this.running;
  }

  cancel(): void {
    this.cancelled = true;
    this.resolveCancellation();
  }

  private async attempt(): Promise<T> {
    let lastError: unknown;
    for (let index = 0; index < RECONNECT_DELAYS_MS.length; index += 1) {
      this.throwIfCancelled();
      const cancelled = await Promise.race([
        this.sleep(RECONNECT_DELAYS_MS[index]!).then(() => false),
        this.cancellation.then(() => true),
      ]);
      if (cancelled) throw new ReconnectCancelledError();
      this.throwIfCancelled();
      try {
        const result = await this.options.reconnect(index + 1);
        this.throwIfCancelled();
        return result;
      } catch (error) {
        this.throwIfCancelled();
        lastError = error;
      }
    }
    throw new ReconnectExhaustedError(lastError);
  }
  private throwIfCancelled(): void {
    if (this.cancelled) throw new ReconnectCancelledError();
  }
}
