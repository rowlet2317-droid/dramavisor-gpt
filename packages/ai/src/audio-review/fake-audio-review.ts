import type { CoachingEvidence } from "@drama/domain/coaching";

import type { AudioReviewer, AudioReviewRequest } from "./port";

export class FakeAudioReviewer implements AudioReviewer {
  readonly calls: AudioReviewRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: Array<CoachingEvidence[] | Error>) {}

  async review(request: AudioReviewRequest): Promise<CoachingEvidence[]> {
    this.calls.push(structuredClone(request));
    if (this.responses.length === 0) throw new Error("FakeAudioReviewer has no response");
    const response = this.responses[Math.min(this.responseIndex, this.responses.length - 1)]!;
    this.responseIndex += 1;
    if (response instanceof Error) throw response;
    return structuredClone(response);
  }
}
