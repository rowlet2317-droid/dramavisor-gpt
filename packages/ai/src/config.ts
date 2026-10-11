export type AiConfig = {
  analysisModel: string;
  openAiApiKey: string;
};

export function loadAiConfig(environment: Record<string, string | undefined> = process.env): AiConfig {
  const analysisModel = environment.ANALYSIS_MODEL?.trim();
  if (!analysisModel) throw new Error("ANALYSIS_MODEL is required");
  const openAiApiKey = environment.OPENAI_API_KEY?.trim();
  if (!openAiApiKey) throw new Error("OPENAI_API_KEY is required");
  return { analysisModel, openAiApiKey };
}
