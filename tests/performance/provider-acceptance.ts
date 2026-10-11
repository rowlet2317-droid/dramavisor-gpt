import { readFile } from "node:fs/promises";

import { writeCoachingLatencyArtifact, type CoachingLatencyFixture } from "./coaching-latency";
import { writeRealtimeLatencyArtifact, type RealtimeLatencyTurn } from "./realtime-latency";

type ProviderAcceptanceEvidence = {
  dialogueOwnershipFraction: number;
  majorClaims: Array<{ hasReference: boolean }>;
  lowConfidenceNumericScores: number;
  realtimeTurns: RealtimeLatencyTurn[];
  coachingFixtures: CoachingLatencyFixture[];
};

async function main() {
  const evidencePath = process.env.ACCEPTANCE_PROVIDER_EVIDENCE?.trim();
  if (!evidencePath) {
    throw new Error("Set ACCEPTANCE_PROVIDER_EVIDENCE to a nonproduction provider-run evidence JSON file");
  }
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as ProviderAcceptanceEvidence;
  if (evidence.dialogueOwnershipFraction < 0.95) throw new Error("Dialogue ownership is below the 95% acceptance threshold");
  if (!evidence.majorClaims.every((claim) => claim.hasReference)) {
    throw new Error("Every explicit major claim must expose a supporting reference");
  }
  if (evidence.lowConfidenceNumericScores !== 0) {
    throw new Error("Low-confidence evidence produced a numeric score");
  }
  const realtime = await writeRealtimeLatencyArtifact(evidence.realtimeTurns);
  if (realtime.medianMs > 1_500 || realtime.p95Ms > 2_500) {
    throw new Error(`Realtime latency failed: median=${realtime.medianMs}ms p95=${realtime.p95Ms}ms`);
  }
  const coaching = await writeCoachingLatencyArtifact(evidence.coachingFixtures);
  if (coaching.within90SecondsFraction < 0.9) {
    throw new Error(`Coaching latency failed: ${(coaching.within90SecondsFraction * 100).toFixed(1)}% within 90 seconds`);
  }
  process.stdout.write(JSON.stringify({ realtime, coaching }) + "\n");
}

void main();
