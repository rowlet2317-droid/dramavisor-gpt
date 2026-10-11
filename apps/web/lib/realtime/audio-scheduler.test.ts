import { describe, expect, it } from "vitest";

import { AudioScheduler, AudioSchedulerStoppedError } from "./audio-scheduler";

describe("AudioScheduler", () => {
  it("starts concurrently queued lines in script ordinal order", async () => {
    const started: string[] = [];
    const scheduler = new AudioScheduler();
    const third = scheduler.schedule({ elementId: "line_3", ordinal: 3,
      start: async () => { started.push("line_3"); } });
    const first = scheduler.schedule({ elementId: "line_1", ordinal: 1,
      start: async () => { started.push("line_1"); } });
    const second = scheduler.schedule({ elementId: "line_2", ordinal: 2,
      start: async () => { started.push("line_2"); } });

    await first;
    expect(started).toEqual(["line_1"]);
    await scheduler.speechFinished("line_1");
    await second;
    expect(started).toEqual(["line_1", "line_2"]);
    await scheduler.speechFinished("line_2");
    await third;
    expect(started).toEqual(["line_1", "line_2", "line_3"]);
  });

  it("does not release the next line for an unrelated speech_finished event", async () => {
    const started: string[] = [];
    const scheduler = new AudioScheduler();
    await scheduler.schedule({ elementId: "line_1", ordinal: 1,
      start: async () => { started.push("line_1"); } });
    void scheduler.schedule({ elementId: "line_2", ordinal: 2,
      start: async () => { started.push("line_2"); } });

    await scheduler.speechFinished("different_line");
    await Promise.resolve();

    expect(started).toEqual(["line_1"]);
  });

  it("rejects queued lines and prevents new scheduling after Stop", async () => {
    const scheduler = new AudioScheduler();
    await scheduler.schedule({ elementId: "line_1", ordinal: 1, start: async () => undefined });
    const queued = scheduler.schedule({ elementId: "line_2", ordinal: 2, start: async () => undefined });

    await scheduler.stop();

    await expect(queued).rejects.toBeInstanceOf(AudioSchedulerStoppedError);
    await expect(scheduler.schedule({ elementId: "line_3", ordinal: 3, start: async () => undefined }))
      .rejects.toBeInstanceOf(AudioSchedulerStoppedError);
  });
});
