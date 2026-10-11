import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type RealtimeLatencyTurn = { actorLineEndedAtMs: number; partnerFirstAudioAtMs: number };

export function measureRealtimeLatency(turns: RealtimeLatencyTurn[]) {
  if (turns.length < 30) throw new Error("Realtime acceptance requires at least 30 recorded turns");
  const latenciesMs = turns.map((turn) => {
    const latency = turn.partnerFirstAudioAtMs - turn.actorLineEndedAtMs;
    if (!Number.isFinite(latency) || latency < 0) throw new Error("Realtime turn timestamps must produce nonnegative latency");
    return latency;
  }).sort((left, right) => left - right);
  return { turns: latenciesMs.length, medianMs: percentile(latenciesMs, 0.5), p95Ms: percentile(latenciesMs, 0.95) };
}

export async function writeRealtimeLatencyArtifact(turns: RealtimeLatencyTurn[], directory = "artifacts/acceptance") {
  const result = measureRealtimeLatency(turns);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `realtime-latency-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...result }, null, 2)}\n`);
  return { path, ...result };
}

function percentile(sorted: number[], quantile: number) {
  const index = Math.ceil(sorted.length * quantile) - 1;
  return sorted[Math.max(0, index)]!;
}
