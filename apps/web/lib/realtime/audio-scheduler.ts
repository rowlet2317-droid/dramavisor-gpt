type ScheduledLine = {
  elementId: string;
  ordinal: number;
  start: () => Promise<void>;
};

type PendingLine = ScheduledLine & {
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class AudioSchedulerStoppedError extends Error {
  constructor() {
    super("Audio scheduler has stopped");
    this.name = "AudioSchedulerStoppedError";
  }
}

export class AudioScheduler {
  private readonly queue: PendingLine[] = [];
  private activeElementId: string | null = null;
  private drainScheduled = false;
  private draining = false;
  private stopped = false;

  schedule(line: ScheduledLine): Promise<void> {
    if (this.stopped) return Promise.reject(new AudioSchedulerStoppedError());
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ ...line, resolve, reject });
      this.queue.sort((left, right) => left.ordinal - right.ordinal
        || left.elementId.localeCompare(right.elementId));
    });
    this.scheduleDrain();
    return promise;
  }

  async speechFinished(elementId: string): Promise<void> {
    if (this.activeElementId !== elementId) return;
    this.activeElementId = null;
    await this.drain();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.activeElementId = null;
    const error = new AudioSchedulerStoppedError();
    for (const line of this.queue.splice(0)) line.reject(error);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped || this.activeElementId || this.queue.length === 0) return;
    this.draining = true;
    const line = this.queue.shift()!;
    this.activeElementId = line.elementId;
    try {
      await line.start();
      line.resolve();
    } catch (error) {
      this.activeElementId = null;
      line.reject(error);
    } finally {
      this.draining = false;
      if (!this.activeElementId && this.queue.length > 0) this.scheduleDrain();
    }
  }
}
