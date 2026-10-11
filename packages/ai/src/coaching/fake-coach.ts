import type { CoachingReport } from "@drama/domain/coaching";

import type { Coach, CoachingSynthesisRequest } from "./port";

export class FakeCoach implements Coach {
  readonly calls: CoachingSynthesisRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: Array<CoachingReport | Error>) {}

  async synthesize(request: CoachingSynthesisRequest): Promise<CoachingReport> {
    this.calls.push(structuredClone(request));
    if (this.responses.length === 0) throw new Error("FakeCoach has no response");
    const response = this.responses[Math.min(this.responseIndex, this.responses.length - 1)]!;
    this.responseIndex += 1;
    if (response instanceof Error) throw response;
    return structuredClone(response);
  }
}
