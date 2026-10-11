import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPrivateResourceMatrixFixture,
  type AuthorizationProof,
  type PrivateResourceMatrixFixture,
} from "./private-resource-fixture";

type PrivateResource = {
  family: string;
  endpoint: string;
  proof: AuthorizationProof;
};

const matrix: PrivateResource[] = [
  { family: "play", endpoint: "DELETE /api/plays/:playId", proof: "play" },
  { family: "source file", endpoint: "GET /api/plays/:playId/source/:sourceId", proof: "source" },
  { family: "Play Model", endpoint: "GET /api/plays/:playId/study", proof: "study" },
  { family: "study artifact", endpoint: "GET /api/plays/:playId/study", proof: "study" },
  { family: "actor note", endpoint: "POST /api/plays/:playId/my-role", proof: "actor-note" },
  { family: "take", endpoint: "GET /api/plays/:playId/takes/:takeId", proof: "take-report" },
  { family: "rehearsal-linked take", endpoint: "GET /api/plays/:playId/takes/:takeId", proof: "take-report" },
  { family: "audio range", endpoint: "GET /api/plays/:playId/takes/:takeId/audio", proof: "audio" },
  { family: "transcript", endpoint: "GET /api/plays/:playId/takes/:takeId", proof: "take-report" },
  { family: "metrics", endpoint: "GET /api/plays/:playId/takes/:takeId", proof: "take-report" },
  { family: "coaching report", endpoint: "GET /api/plays/:playId/takes/:takeId", proof: "take-report" },
  { family: "cue-response evidence", endpoint: "GET /api/plays/:playId/takes/:takeId", proof: "take-report" },
  { family: "rehearsal session", endpoint: "POST /api/rehearsals/:sessionId/resume", proof: "resume" },
  { family: "rehearsal event", endpoint: "POST /api/rehearsals/:sessionId/events", proof: "event" },
  { family: "realtime grant", endpoint: "POST /api/realtime/session", proof: "realtime-grant" },
];

describe.sequential("private resource authorization matrix", () => {
  let fixture: PrivateResourceMatrixFixture;

  beforeAll(async () => {
    fixture = await createPrivateResourceMatrixFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("enumerates the 15 private-resource families exactly once", () => {
    expect(matrix).toHaveLength(15);
    expect(new Set(matrix.map(({ family }) => family)).size).toBe(15);
  });

  it.each(matrix)("returns a nonleaking 404 for $family via $endpoint", async ({ proof }) => {
    const accessesBefore = fixture.externalAccesses.length;

    const response = await fixture.executeAsIntruder(proof);

    expect(response.status).toBe(404);
    expect(fixture.externalAccesses).toHaveLength(accessesBefore);
    const serialized = await response.text();
    for (const identifier of fixture.privateIdentifiers) {
      expect(serialized).not.toContain(identifier);
    }
  });

  it("omits every user-A identifier from user B's real play list", async () => {
    const plays = await fixture.listIntruderPlays();
    expect(plays).toEqual([]);
    const serialized = JSON.stringify(plays);

    for (const identifier of fixture.privateIdentifiers) {
      expect(serialized).not.toContain(identifier);
    }
  });
});
