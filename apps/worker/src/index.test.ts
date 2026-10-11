import { beforeEach, describe, expect, it, vi } from "vitest";

const jobHandlers = vi.hoisted(() => ({
  claimNextJob: vi.fn(),
  failJob: vi.fn(),
  runSynthesizeCoachingJob: vi.fn(),
  failSynthesizeCoachingJob: vi.fn(),
  runMeasureTakeJob: vi.fn(),
  runLimitedMeasureTakeJob: vi.fn(),
  failMeasureTakeJob: vi.fn(),
  emitWorkerJobFailureEvent: vi.fn(),
}));

vi.mock("./jobs/claim", () => ({
  claimNextJob: jobHandlers.claimNextJob,
  failJob: jobHandlers.failJob,
}));

vi.mock("./observability/sink", () => ({
  emitWorkerJobFailureEvent: jobHandlers.emitWorkerJobFailureEvent,
}));

vi.mock("./jobs/measure-take", () => ({
  runMeasureTakeJob: jobHandlers.runMeasureTakeJob,
  runLimitedMeasureTakeJob: jobHandlers.runLimitedMeasureTakeJob,
  failMeasureTakeJob: jobHandlers.failMeasureTakeJob,
}));

vi.mock("./jobs/synthesize-coaching", () => ({
  runSynthesizeCoachingJob: jobHandlers.runSynthesizeCoachingJob,
  failSynthesizeCoachingJob: jobHandlers.failSynthesizeCoachingJob,
}));

import { loadAudioReviewModel, loadCoachingModel, resolveJobFailureCode, runWorkerCycle, runWorkerOnce } from "./index";

describe("worker composition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the configured analysis model for coaching unless it is explicitly overridden", () => {
    expect(loadCoachingModel({ ANALYSIS_MODEL: "gpt-5.6-terra" })).toBe("gpt-5.6");
    expect(loadCoachingModel({ ANALYSIS_MODEL: "gpt-5.6-terra", COACHING_MODEL: "gpt-5.6" }))
      .toBe("gpt-5.6");
  });

  it("uses the documented audio model unless explicitly configured", () => {
    expect(loadAudioReviewModel({})).toBe("gpt-audio-1.5");
    expect(loadAudioReviewModel({ AUDIO_REVIEW_MODEL: "gpt-audio-mini" })).toBe("gpt-audio-mini");
  });

  it("keeps explicit stage codes and classifies uncoded coaching failures", () => {
    expect(resolveJobFailureCode(new Error("PINNED_SCENE_NOT_FOUND"), "synthesize_coaching"))
      .toBe("PINNED_SCENE_NOT_FOUND");
    expect(resolveJobFailureCode(new Error("provider unavailable"), "synthesize_coaching"))
      .toBe("COACHING_SYNTHESIS_RUNTIME_FAILURE");
  });

  it("discovers owner partitions and runs each partition explicitly", async () => {
    const visited: string[] = [];

    const processed = await runWorkerCycle({
      listOwnerPartitions: async () => ["owner-a", "owner-b"],
      runOwnerPartition: async (ownerUserId) => {
        visited.push(ownerUserId);
        return ownerUserId === "owner-a";
      },
    });

    expect(visited).toEqual(["owner-a", "owner-b"]);
    expect(processed).toBe(1);
  });

  it("marks an ordinary coaching synthesis failure actionable instead of leaving the take processing", async () => {
    const job = { id: "job-1", kind: "synthesize_coaching", leaseToken: "lease-1", attemptCount: 2 };
    jobHandlers.claimNextJob.mockResolvedValue(job);
    jobHandlers.runSynthesizeCoachingJob.mockRejectedValue(new Error("provider unavailable"));
    jobHandlers.failSynthesizeCoachingJob.mockResolvedValue(undefined);

    await expect(runWorkerOnce({
      db: {} as never,
      ownerUserId: "owner-1",
      extractor: {} as never,
      parser: {} as never,
      coach: {} as never,
    })).resolves.toBe(true);

    expect(jobHandlers.failSynthesizeCoachingJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.id,
      ownerUserId: "owner-1",
      leaseToken: job.leaseToken,
      attemptCount: 2,
      code: "COACHING_SYNTHESIS_RUNTIME_FAILURE",
    }));
    expect(jobHandlers.failJob).not.toHaveBeenCalled();
  });

  it("continues a take with limited metrics after an unclassified measurement failure", async () => {
    const job = { id: "job-1", kind: "measure_take", leaseToken: "lease-1", attemptCount: 1 };
    jobHandlers.claimNextJob.mockResolvedValue(job);
    jobHandlers.runMeasureTakeJob.mockRejectedValue(new Error("unexpected numeric failure"));
    jobHandlers.runLimitedMeasureTakeJob.mockResolvedValue({ measurementId: "measurement-1" });

    await expect(runWorkerOnce({ db: {} as never, ownerUserId: "owner-1", extractor: {} as never,
      parser: {} as never, normalizedAudioStorage: {} as never })).resolves.toBe(true);

    expect(jobHandlers.runLimitedMeasureTakeJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.id, leaseToken: job.leaseToken, attemptCount: 1,
    }));
    expect(jobHandlers.failMeasureTakeJob).not.toHaveBeenCalled();
    expect(jobHandlers.emitWorkerJobFailureEvent).not.toHaveBeenCalled();
  });
});
