import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadAiConfig } from "../packages/ai/src/config";
import { OpenAiPlayParser } from "../packages/ai/src/play-parser/openai-parser";
import { OpenAiStudyGenerator } from "../packages/ai/src/study/openai-study";
import { normalizeParseProposal } from "../packages/domain/src/parse-review";
import { validateStudyArtifact, type StudyArtifact, type StudySectionKind } from "../packages/domain/src/study";

type SmokeOptions = {
  environment: Record<string, string | undefined>;
  args: string[];
  output: (line: string) => void;
};

export async function runProviderSmoke(options: SmokeOptions): Promise<number> {
  if (!options.environment.OPENAI_API_KEY?.trim()) {
    options.output("Provider smoke: SKIPPED (OPENAI_API_KEY is unset)");
    return 0;
  }
  const fixturePath = options.args[0];
  if (!fixturePath) throw new Error("Usage: pnpm smoke:provider <stage-play.txt>");
  const config = loadAiConfig(options.environment);
  const source = await readFile(resolve(process.cwd(), fixturePath), "utf8");
  const parser = new OpenAiPlayParser({ model: config.analysisModel, apiKey: config.openAiApiKey });
  const parserStartedAt = performance.now();
  const proposal = await parser.parse({ titleHint: source.split(/\r?\n/).find((line) => line.trim()) ?? null,
    pages: [{ page: 1, text: source, extraction: "native" }], warnings: [] });
  const play = normalizeParseProposal(proposal, "33333333-3333-4333-8333-333333333333", 1).playModel;
  const parserLatencyMs = Math.round(performance.now() - parserStartedAt);
  const generator = new OpenAiStudyGenerator({ model: config.analysisModel, apiKey: config.openAiApiKey });
  const requests = [
    ...(["overview", "themes", "dramatic_structure", "characters", "relationships"] as const)
      .map((kind) => ({ kind, scopeId: null })),
    ...play.acts.flatMap((act) => act.scenes.map((scene) => ({ kind: "scene" as const, scopeId: scene.id }))),
  ];
  const artifacts: StudyArtifact[] = [];
  const studyStartedAt = performance.now();
  for (const request of requests) {
    const artifact = validateStudyArtifact(await generator.generateStudySection({ play,
      kind: request.kind as StudySectionKind, scopeId: request.scopeId }), play);
    if (artifact.kind !== request.kind || artifact.scopeId !== request.scopeId) {
      throw new Error(`Provider returned the wrong study scope for ${request.kind}:${request.scopeId ?? "play"}`);
    }
    artifacts.push(artifact);
  }
  const studyLatencyMs = Math.round(performance.now() - studyStartedAt);
  const reportPath = resolve(process.cwd(), "artifacts/provider-smoke/plan-1.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    status: "passed", fixture: fixturePath, models: { parser: config.analysisModel, study: config.analysisModel },
    latencyMs: { parser: parserLatencyMs, study: studyLatencyMs, total: parserLatencyMs + studyLatencyMs },
    validated: { acts: play.acts.length, scenes: play.acts.flatMap((act) => act.scenes).length,
      studyArtifacts: artifacts.length }, generatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  options.output(`Provider smoke: PASSED (${reportPath})`);
  return 0;
}

if (process.argv[1]?.endsWith("provider-smoke.ts")) {
  runProviderSmoke({ environment: process.env, args: process.argv.slice(2),
    output: (line) => process.stdout.write(`${line}\n`) }).then((code) => {
      process.exitCode = code;
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
