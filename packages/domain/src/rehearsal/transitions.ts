import type { PersistedRehearsalEvent, RehearsalStatus } from "./types";

export type TransitionResult =
  | { legal: true; idempotent: boolean }
  | { legal: false; code: "TERMINAL_SESSION" | "PAUSED_SESSION" | "ILLEGAL_TRANSITION" };

const legalEvents: Record<RehearsalStatus, ReadonlySet<PersistedRehearsalEvent["type"]>> = {
  ready: new Set(["started", "connection_lost", "stopped"]),
  active: new Set(["actor_line_final", "ai_speech_started", "ai_speech_finished", "cue_requested",
    "restart_requested", "paused", "interrupted", "manual_actor_line_completed", "connection_lost",
    "position_confirmed", "stopped"]),
  paused: new Set(["cue_requested", "resumed", "interrupted", "connection_lost", "stopped"]),
  disconnected: new Set(["paused", "resumed", "connection_lost", "fallback_selected", "stopped"]),
  recovering: new Set(["stopped"]),
  await_interruption_choice: new Set(["ai_speech_finished", "continue_after_interruption", "restart_line",
    "connection_lost", "stopped"]),
  needs_position_confirmation: new Set(["actor_line_final", "cue_requested", "restart_requested", "paused",
    "connection_lost", "position_confirmed", "stopped"]),
  stopped: new Set(),
  completed: new Set(),
};

export function validateTransition(status: RehearsalStatus, event: PersistedRehearsalEvent,
  options: { identicalRetry?: boolean } = {}): TransitionResult {
  if (options.identicalRetry) {
    return status !== "stopped" || event.type === "stopped"
      ? { legal: true, idempotent: true } : { legal: false, code: "TERMINAL_SESSION" };
  }
  if (!legalEvents[status].has(event.type)) {
    return { legal: false, code: status === "stopped" ? "TERMINAL_SESSION"
      : status === "paused" ? "PAUSED_SESSION" : "ILLEGAL_TRANSITION" };
  }
  return { legal: true, idempotent: false };
}

export function statusAfterTransition(status: RehearsalStatus,
  event: PersistedRehearsalEvent): RehearsalStatus {
  switch (event.type) {
    case "started":
    case "resumed":
    case "fallback_selected":
    case "restart_requested":
    case "continue_after_interruption":
    case "restart_line":
    case "position_confirmed": return "active";
    case "paused": return status === "disconnected" ? "disconnected" : "paused";
    case "interrupted": return "await_interruption_choice";
    case "connection_lost": return "disconnected";
    case "stopped": return "stopped";
    default: return status;
  }
}
