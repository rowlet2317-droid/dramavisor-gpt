import { describe, expect, it, vi } from "vitest";

import { BoundedReconnect, ReconnectCancelledError, ReconnectExhaustedError } from "./reconnect";

describe("BoundedReconnect", () => {
  it("uses the bounded 250 ms, 1 s, and 3 s schedule with a fresh attempt each time", async () => {
    const delays: number[] = [];
    const reconnect = vi.fn().mockRejectedValue(new Error("offline"));
    const coordinator = new BoundedReconnect({ reconnect,
      sleep: async (delayMs) => { delays.push(delayMs); } });

    await expect(coordinator.run()).rejects.toBeInstanceOf(ReconnectExhaustedError);

    expect(delays).toEqual([250, 1_000, 3_000]);
    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(reconnect.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
  });

  it("rehydrates after the first successful reconnect and stops retrying", async () => {
    const reconnect = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ lastSequence: 9 });
    const delays: number[] = [];
    const coordinator = new BoundedReconnect({ reconnect,
      sleep: async (delayMs) => { delays.push(delayMs); } });

    await expect(coordinator.run()).resolves.toEqual({ lastSequence: 9 });
    expect(delays).toEqual([250, 1_000]);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it("can be retried explicitly after exhaustion", async () => {
    const reconnect = vi.fn().mockRejectedValue(new Error("offline"));
    const coordinator = new BoundedReconnect({ reconnect, sleep: async () => undefined });
    await expect(coordinator.run()).rejects.toBeInstanceOf(ReconnectExhaustedError);
    reconnect.mockResolvedValue({ lastSequence: 10 });

    await expect(coordinator.run()).resolves.toEqual({ lastSequence: 10 });
  });

  it("cancels an in-flight attempt without starting another retry", async () => {
    let rejectAttempt: (error: Error) => void = () => undefined;
    let markAttempted: () => void = () => undefined;
    const attempted = new Promise<void>((resolve) => { markAttempted = resolve; });
    const reconnect = vi.fn(() => {
      markAttempted();
      return new Promise<never>((_resolve, reject) => { rejectAttempt = reject; });
    });
    const coordinator = new BoundedReconnect({ reconnect, sleep: async () => undefined });

    const running = coordinator.run();
    await attempted;
    coordinator.cancel();
    rejectAttempt(new Error("late failure"));

    await expect(running).rejects.toBeInstanceOf(ReconnectCancelledError);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a scheduled retry immediately when cancelled", async () => {
    let markSleeping: () => void = () => undefined;
    const sleeping = new Promise<void>((resolve) => { markSleeping = resolve; });
    const reconnect = vi.fn();
    const coordinator = new BoundedReconnect({ reconnect,
      sleep: () => { markSleeping(); return new Promise<void>(() => undefined); } });

    const running = coordinator.run();
    await sleeping;
    coordinator.cancel();

    await expect(running).rejects.toBeInstanceOf(ReconnectCancelledError);
    expect(reconnect).not.toHaveBeenCalled();
  });
});
