import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type CoachingLatencyFixture = {
  fixtureId: string;
  consented: boolean;
  durationSeconds: number;
  uploadedAtMs: number;
  completedAtMs: number;
};

/** Runs exactly the consented fixtures through a real uploader/poller supplied by the provider environment. */
export async function runCoachingLatencyHarness(
  fixtures: Array<Omit<CoachingLatencyFixture, "uploadedAtMs" | "completedAtMs">>,
  uploadAndAwait: (fixture: Omit<CoachingLatencyFixture, "uploadedAtMs" | "completedAtMs">)
    => Promise<{ uploadedAtMs: number; completedAtMs: number }>,
  directory?: string,
) {
  if (fixtures.length !== 10 || !fixtures.every(({ consented, durationSeconds }) => consented && durationSeconds >= 300)) {
    throw new Error("Coaching acceptance requires exactly ten consented five-minute fixtures");
  }
  const measured = await Promise.all(fixtures.map(async (fixture) => ({ ...fixture, ...await uploadAndAwait(fixture) })));
  return writeCoachingLatencyArtifact(measured, directory);
}

export function measureCoachingLatency(fixtures: CoachingLatencyFixture[]) {
  if (fixtures.length !== 10) throw new Error("Coaching acceptance requires exactly ten consented five-minute fixtures");
  if (!fixtures.every(({ consented, durationSeconds }) => consented && durationSeconds >= 300)) {
    throw new Error("Every coaching acceptance fixture must be consented and at least five minutes");
  }
  const durationsMs = fixtures.map(({ uploadedAtMs, completedAtMs }) => {
    const duration = completedAtMs - uploadedAtMs;
    if (!Number.isFinite(duration) || duration < 0) throw new Error("Coaching fixture timestamps must produce nonnegative latency");
    return duration;
  });
  return { fixtures: fixtures.length, within90Seconds: durationsMs.filter((duration) => duration <= 90_000).length,
    within90SecondsFraction: durationsMs.filter((duration) => duration <= 90_000).length / fixtures.length };
}

export async function writeCoachingLatencyArtifact(fixtures: CoachingLatencyFixture[], directory = "artifacts/acceptance") {
  const result = measureCoachingLatency(fixtures);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `coaching-latency-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...result }, null, 2)}\n`);
  return { path, ...result };
}
