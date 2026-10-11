import type { ParseProposal } from "@drama/domain/parse-review";
import type { ExtractedScript } from "@drama/media/scripts/extract";

export interface PlayParser {
  parse(extracted: ExtractedScript): Promise<ParseProposal>;
}
