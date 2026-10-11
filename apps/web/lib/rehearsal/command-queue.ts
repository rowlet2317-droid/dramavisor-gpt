import { reduceRehearsal } from "@drama/domain/rehearsal/reducer";
import type { PersistedRehearsalEvent, RehearsalState } from "@drama/domain/rehearsal/types";

export type QueueState = "open" | "recovering" | "terminal";
export type SafetyFenceKind = "pause" | "stop" | "unmount" | "disconnect" | "interruption";
type Unsequenced<T> = T extends { sequence: number } ? Omit<T, "sequence"> : never;
export type UnsequencedRehearsalEvent = Unsequenced<PersistedRehearsalEvent>;

type PendingCommand = {
  command: UnsequencedRehearsalEvent;
  resolve: (event: PersistedRehearsalEvent) => void;
  reject: (error: unknown) => void;
};

type QueueOptions = {
  state: RehearsalState;
  persistEvent: (event: PersistedRehearsalEvent) => Promise<void>;
  onAcknowledged?: (event: PersistedRehearsalEvent, state: RehearsalState,
    previousState: RehearsalState) => void | Promise<void>;
  onEffectError?: (error: unknown, event: PersistedRehearsalEvent) => void;
};

export class RehearsalPersistenceError extends Error {
  constructor(readonly status: number) {
    super(`Rehearsal event write failed (${status})`);
    this.name = "RehearsalPersistenceError";
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export class RehearsalCommandQueue {
  state: RehearsalState;
  queueState: QueueState = "open";
  safetyFence: SafetyFenceKind | null = null;
  private readonly pending: PendingCommand[] = [];
  private draining = false;

  constructor(private readonly options: QueueOptions) {
    this.state = options.state;
  }

  enqueue(command: UnsequencedRehearsalEvent): Promise<PersistedRehearsalEvent> {
    if (this.queueState !== "open") {
      return Promise.reject(new Error(`Rehearsal command queue is ${this.queueState}`));
    }
    const promise = new Promise<PersistedRehearsalEvent>((resolve, reject) => {
      this.pending.push({ command, resolve, reject });
    });
    void this.drain();
    return promise;
  }

  rehydrate(input: { state: RehearsalState; lastSequence: number }): void {
    if (this.queueState === "terminal") throw new Error("A terminal rehearsal command queue cannot be rehydrated");
    this.state = { ...input.state, lastSequence: input.lastSequence };
    this.queueState = "open";
    this.safetyFence = null;
  }

  installSafetyFence(kind: SafetyFenceKind): void {
    this.safetyFence = kind;
  }

  close(): void {
    if (this.queueState === "terminal") return;
    this.queueState = "terminal";
    const error = new Error("Rehearsal command queue is closed");
    for (const command of this.pending.splice(0)) command.reject(error);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.pending.length > 0) {
      const pending = this.pending[0]!;
      const event = { ...pending.command, sequence: this.state.lastSequence + 1 } as PersistedRehearsalEvent;
      try {
        await this.persistWithRetry(event);
        if (this.queueState === "terminal") break;
        const previousState = this.state;
        this.state = reduceRehearsal(this.state, event);
        this.pending.shift();
        pending.resolve(event);
        this.runAcknowledgedEffect(event, previousState);
      } catch (error) {
        if (this.queueState === "terminal") break;
        this.queueState = "recovering";
        for (const command of this.pending.splice(0)) command.reject(error);
        break;
      }
    }
    this.draining = false;
  }

  private async persistWithRetry(event: PersistedRehearsalEvent): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.persistEvent(event);
        return;
      } catch (error) {
        if (this.queueState === "terminal") throw error;
        if (error instanceof RehearsalPersistenceError && !error.retryable) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private runAcknowledgedEffect(event: PersistedRehearsalEvent, previousState: RehearsalState): void {
    try {
      void Promise.resolve(this.options.onAcknowledged?.(event, this.state, previousState))
        .catch((error: unknown) => this.options.onEffectError?.(error, event));
    } catch (error) {
      this.options.onEffectError?.(error, event);
    }
  }
}
