import type { IssuedRealtimeCredentials } from "../packages/ai/src/realtime/port";
import { OpenAiRealtimeCredentials } from "../packages/ai/src/realtime/openai-credentials";

type SmokeOptions = {
  environment: Record<string, string | undefined>;
  output: (line: string) => void;
  issue?: (input: { userId: string }) => Promise<IssuedRealtimeCredentials>;
};

export async function runRealtimeSmoke(options: SmokeOptions): Promise<number> {
  const apiKey = options.environment.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    options.output("Realtime smoke: SKIPPED (OPENAI_API_KEY is unset)");
    return 0;
  }
  const model = options.environment.REALTIME_MODEL?.trim() || "gpt-realtime-2.1";
  const credentials = new OpenAiRealtimeCredentials({ apiKey, model });
  const issue = options.issue ?? credentials.issue.bind(credentials);
  const grant = await issue({ userId: "realtime-provider-smoke" });
  options.output(`Realtime smoke: PASSED (${grant.model}, expires ${grant.expiresAt})`);
  return 0;
}

if (process.argv[1]?.endsWith("smoke-realtime.ts")) {
  runRealtimeSmoke({ environment: process.env, output: (line) => process.stdout.write(`${line}\n`) })
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
