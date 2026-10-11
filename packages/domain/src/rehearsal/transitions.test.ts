import { describe, expect, it } from "vitest";

import type { PersistedRehearsalEvent, RehearsalStatus } from "./types";
import { validateTransition } from "./transitions";

const events = {
  started: { type: "started", sequence: 1, startedAtMs: 0 },
  actor_line_final: { type: "actor_line_final", sequence: 2, text: "Pinned.", endedAtMs: 10 },
  ai_speech_started: { type: "ai_speech_started", sequence: 2, characterId: "role",
    elementId: "line_1", startedAtMs: 10 },
  ai_speech_finished: { type: "ai_speech_finished", sequence: 2, characterId: "role",
    elementId: "line_1", endedAtMs: 20 },
  cue_requested: { type: "cue_requested", sequence: 2 },
  restart_requested: { type: "restart_requested", sequence: 2, elementId: "line_1" },
  paused: { type: "paused", sequence: 2 },
  resumed: { type: "resumed", sequence: 2 },
  interrupted: { type: "interrupted", sequence: 2, elementId: "line_1", atMs: 20 },
  continue_after_interruption: { type: "continue_after_interruption", sequence: 2, elementId: "line_1" },
  restart_line: { type: "restart_line", sequence: 2, elementId: "line_1" },
  manual_actor_line_completed: { type: "manual_actor_line_completed", sequence: 2,
    elementId: "line_1", endedAtMs: 20 },
  connection_lost: { type: "connection_lost", sequence: 2, reason: "network" },
  fallback_selected: { type: "fallback_selected", sequence: 2 },
  position_confirmed: { type: "position_confirmed", sequence: 2, elementId: "line_1" },
  stopped: { type: "stopped", sequence: 2 },
} satisfies Record<PersistedRehearsalEvent["type"], PersistedRehearsalEvent>;

const legalEvents = {
  ready: ["started", "connection_lost", "stopped"],
  active: ["actor_line_final", "ai_speech_started", "ai_speech_finished", "cue_requested",
    "restart_requested", "paused", "interrupted", "manual_actor_line_completed", "connection_lost",
    "position_confirmed", "stopped"],
  paused: ["cue_requested", "resumed", "interrupted", "connection_lost", "stopped"],
  disconnected: ["paused", "resumed", "connection_lost", "fallback_selected", "stopped"],
  recovering: ["stopped"],
  await_interruption_choice: ["ai_speech_finished", "continue_after_interruption", "restart_line",
    "connection_lost", "stopped"],
  needs_position_confirmation: ["actor_line_final", "cue_requested", "restart_requested", "paused",
    "connection_lost", "position_confirmed", "stopped"],
  stopped: [],
  completed: [],
} satisfies Record<RehearsalStatus, PersistedRehearsalEvent["type"][]>;

const statuses = Object.keys(legalEvents) as RehearsalStatus[];
const eventTypes = Object.keys(events) as PersistedRehearsalEvent["type"][];

describe("validateTransition complete legal status/event matrix", () => {
  for (const status of statuses) {
    for (const eventType of eventTypes) {
      it(`${status} + ${eventType} cannot enter an unlisted server transition branch`, () => {
        const result = validateTransition(status, events[eventType]);
        if ((legalEvents[status] as readonly string[]).includes(eventType)) {
          expect(result).toMatchObject({ legal: true, idempotent: false });
        } else {
          expect(result).toEqual({ legal: false, code: status === "stopped"
            ? "TERMINAL_SESSION" : status === "paused" ? "PAUSED_SESSION" : "ILLEGAL_TRANSITION" });
        }
      });
    }
  }

  it("accepts only an explicitly identical stopped retry as idempotent", () => {
    expect(validateTransition("stopped", events.stopped, { identicalRetry: true }))
      .toEqual({ legal: true, idempotent: true });
    expect(validateTransition("stopped", events.ai_speech_finished, { identicalRetry: true }))
      .toEqual({ legal: false, code: "TERMINAL_SESSION" });
    expect(validateTransition("stopped", { ...events.stopped, sequence: 3 }))
      .toEqual({ legal: false, code: "TERMINAL_SESSION" });
    expect(validateTransition("stopped", events.resumed))
      .toEqual({ legal: false, code: "TERMINAL_SESSION" });
  });

  it("rejects provider completion while paused instead of advancing the server timeline", () => {
    expect(validateTransition("paused", events.ai_speech_finished))
      .toEqual({ legal: false, code: "PAUSED_SESSION" });
  });

  it("accepts an exact final-event retry after completion but no new completed-session event", () => {
    expect(validateTransition("completed", events.ai_speech_finished, { identicalRetry: true }))
      .toEqual({ legal: true, idempotent: true });
    expect(validateTransition("completed", events.stopped))
      .toEqual({ legal: false, code: "ILLEGAL_TRANSITION" });
  });
});
