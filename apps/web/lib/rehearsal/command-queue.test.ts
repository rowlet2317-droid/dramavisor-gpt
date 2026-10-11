import { describe, expect, it } from "vitest";

import { createRehearsalState } from "@drama/domain/rehearsal/controller";
import { reduceRehearsal } from "@drama/domain/rehearsal/reducer";
import type { PersistedRehearsalEvent } from "@drama/domain/rehearsal/types";

import { RehearsalCommandQueue, RehearsalPersistenceError } from "./command-queue";

const lines = [
  { elementId: "line_1", ordinal: 1, characterId: "actor", text: "A" },
  { elementId: "line_2", ordinal: 2, characterId: "role", text: "B" },
];

describe("RehearsalCommandQueue", () => {
  it("does not reduce or send command N+1 before command N is acknowledged", async () => {
    const acknowledgements: Array<() => void> = [];
    const posted: PersistedRehearsalEvent[] = [];
    const initial = reduceRehearsal(createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines }),
      { type: "started", sequence: 1, startedAtMs: 0 });
    const queue = new RehearsalCommandQueue({ state: initial, persistEvent: (event) => {
      posted.push(event);
      return new Promise<void>((resolve) => acknowledgements.push(resolve));
    } });

    const first = queue.enqueue({ type: "actor_line_final", text: "A", endedAtMs: 10 });
    const second = queue.enqueue({ type: "ai_speech_started", characterId: "role", elementId: "line_2",
      startedAtMs: 11 });

    expect(posted).toEqual([{ type: "actor_line_final", text: "A", endedAtMs: 10, sequence: 2 }]);
    expect(queue.state.cursorElementId).toBe("line_1");
    acknowledgements[0]!();
    await first;
    expect(posted).toEqual([
      { type: "actor_line_final", text: "A", endedAtMs: 10, sequence: 2 },
      { type: "ai_speech_started", characterId: "role", elementId: "line_2", startedAtMs: 11, sequence: 3 },
    ]);
    expect(queue.state.cursorElementId).toBe("line_2");
    acknowledgements[1]!();
    await second;
  });

  it("retries an identical event and does not reduce it before acknowledgement", async () => {
    const posted: PersistedRehearsalEvent[] = [];
    let acknowledgeRetry!: () => void;
    const initial = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines });
    const queue = new RehearsalCommandQueue({ state: initial, persistEvent: (event) => {
      posted.push(event);
      if (posted.length === 1) return Promise.reject(new Error("temporary network failure"));
      return new Promise<void>((resolve) => { acknowledgeRetry = resolve; });
    } });

    const result = queue.enqueue({ type: "started", startedAtMs: 20 });
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toEqual([
      { type: "started", startedAtMs: 20, sequence: 1 },
      { type: "started", startedAtMs: 20, sequence: 1 },
    ]);
    expect(queue.state).toEqual(initial);
    acknowledgeRetry();
    await result;
    expect(queue.state).toMatchObject({ lastSequence: 1, status: "active" });
  });

  it("enters recovery on a 409 conflict without reducing or sending queued commands", async () => {
    const posted: PersistedRehearsalEvent[] = [];
    const initial = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines });
    const queue = new RehearsalCommandQueue({ state: initial, persistEvent: async (event) => {
      posted.push(event);
      throw new RehearsalPersistenceError(409);
    } });

    const first = queue.enqueue({ type: "started", startedAtMs: 20 });
    const second = queue.enqueue({ type: "paused" });
    const results = await Promise.allSettled([first, second]);

    expect(posted).toEqual([{ type: "started", startedAtMs: 20, sequence: 1 }]);
    expect(queue.state).toEqual(initial);
    expect(queue.queueState).toBe("recovering");
    expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  });

  it("requires server rehydration after exhausted retries and resumes at the server sequence", async () => {
    const posted: PersistedRehearsalEvent[] = [];
    let online = false;
    const initial = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines });
    const queue = new RehearsalCommandQueue({ state: initial, persistEvent: async (event) => {
      posted.push(event);
      if (!online) throw new Error("offline");
    } });

    await expect(queue.enqueue({ type: "started", startedAtMs: 20 })).rejects.toThrow("offline");
    expect(posted).toHaveLength(3);
    expect(queue.state).toEqual(initial);
    await expect(queue.enqueue({ type: "started", startedAtMs: 21 })).rejects.toThrow("recovering");

    online = true;
    const recovered = { ...initial, lastSequence: 5 };
    queue.rehydrate({ state: recovered, lastSequence: 5 });
    await queue.enqueue({ type: "paused" });

    expect(posted.at(-1)).toEqual({ type: "paused", sequence: 6 });
    expect(queue.queueState).toBe("open");
    expect(queue.state.lastSequence).toBe(6);
  });

  it("ignores late acknowledgements and effects after an unmount fence closes the queue", async () => {
    let acknowledge!: () => void;
    const acknowledged: PersistedRehearsalEvent[] = [];
    const initial = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines });
    const queue = new RehearsalCommandQueue({ state: initial,
      persistEvent: () => new Promise<void>((resolve) => { acknowledge = resolve; }),
      onAcknowledged: (event) => { acknowledged.push(event); } });

    const pending = queue.enqueue({ type: "started", startedAtMs: 20 });
    queue.installSafetyFence("unmount");
    queue.close();
    acknowledge();

    await expect(pending).rejects.toThrow("closed");
    await Promise.resolve();
    expect(queue.queueState).toBe("terminal");
    expect(queue.safetyFence).toBe("unmount");
    expect(queue.state).toEqual(initial);
    expect(acknowledged).toEqual([]);
  });

  it("commits an acknowledged command before running effects so a long effect cannot block command N+1", async () => {
    let finishEffect!: () => void;
    const posted: PersistedRehearsalEvent[] = [];
    const initial = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines });
    const queue = new RehearsalCommandQueue({
      state: initial,
      persistEvent: async (event) => { posted.push(event); },
      onAcknowledged: (event) => event.type === "started"
        ? new Promise<void>((resolve) => { finishEffect = resolve; })
        : undefined,
    });

    const first = queue.enqueue({ type: "started", startedAtMs: 20 });
    const second = queue.enqueue({ type: "paused" });
    await Promise.all([first, second]);

    expect(posted).toEqual([
      { type: "started", startedAtMs: 20, sequence: 1 },
      { type: "paused", sequence: 2 },
    ]);
    expect(queue.state).toMatchObject({ lastSequence: 2, status: "paused" });
    expect(queue.queueState).toBe("open");
    finishEffect();
  });

  it("isolates a throwing post-acknowledgement effect from persistence recovery", async () => {
    const posted: PersistedRehearsalEvent[] = [];
    const effectErrors: unknown[] = [];
    const initial = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines });
    const queue = new RehearsalCommandQueue({
      state: initial,
      persistEvent: async (event) => { posted.push(event); },
      onAcknowledged: () => { throw new Error("speaker failed"); },
      onEffectError: (error) => { effectErrors.push(error); },
    });

    await queue.enqueue({ type: "started", startedAtMs: 20 });
    await queue.enqueue({ type: "paused" });
    await Promise.resolve();

    expect(posted).toHaveLength(2);
    expect(queue.queueState).toBe("open");
    expect(queue.state.lastSequence).toBe(2);
    expect(effectErrors).toHaveLength(2);
  });

  it("stays terminal when a persistence call rejects after close", async () => {
    let rejectPersistence!: (error: unknown) => void;
    const initial = createRehearsalState({ sessionId: "session_1", actorRoleId: "actor", lines });
    const queue = new RehearsalCommandQueue({
      state: initial,
      persistEvent: () => new Promise<void>((_resolve, reject) => { rejectPersistence = reject; }),
    });

    const pending = queue.enqueue({ type: "started", startedAtMs: 20 });
    queue.close();
    rejectPersistence(new RehearsalPersistenceError(409));

    await expect(pending).rejects.toThrow("closed");
    await Promise.resolve();
    expect(queue.queueState).toBe("terminal");
    expect(queue.state).toEqual(initial);
  });
});
