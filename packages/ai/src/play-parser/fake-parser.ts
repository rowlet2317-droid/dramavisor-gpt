import type { ParseProposal } from "@drama/domain/parse-review";
import type { ExtractedScript } from "@drama/media/scripts/extract";

import type { PlayParser } from "./port";

export class FakePlayParser implements PlayParser {
  calls = 0;

  constructor(private readonly proposals: ParseProposal[]) {}

  async parse(_extracted: ExtractedScript): Promise<ParseProposal> {
    const proposal = this.proposals[Math.min(this.calls, this.proposals.length - 1)];
    this.calls += 1;
    if (!proposal) throw new Error("FakePlayParser has no proposal configured");
    return structuredClone(proposal);
  }
}
