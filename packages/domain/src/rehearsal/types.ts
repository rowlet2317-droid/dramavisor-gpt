export type RehearsalLine = {
  elementId: string;
  ordinal: number;
  characterId: string;
  text: string;
};

export type RehearsalStatus = "ready" | "active" | "paused" | "disconnected"
  | "recovering" | "await_interruption_choice" | "needs_position_confirmation" | "stopped" | "completed";

export type RehearsalAction =
  | { type: "speak"; elementId: string; characterId: string }
  | { type: "listen"; elementId: string }
  | { type: "show_cue"; elementId: string }
  | { type: "confirm_position"; candidates: Array<{ elementId: string; text: string }> }
  | { type: "await_interruption_choice"; elementId: string }
  | { type: "complete" };

type Sequenced<T> = T & { sequence: number };

export type RehearsalEvent =
  | { type: "actor_partial"; text: string }
  | Sequenced<{ type: "started"; startedAtMs: number }>
  | Sequenced<{ type: "actor_line_final"; text: string; endedAtMs: number }>
  | Sequenced<{ type: "ai_speech_started"; characterId: string; elementId: string; startedAtMs: number }>
  | Sequenced<{ type: "ai_speech_finished"; characterId: string; elementId: string; endedAtMs: number }>
  | Sequenced<{ type: "cue_requested" }>
  | Sequenced<{ type: "restart_requested"; elementId?: string }>
  | Sequenced<{ type: "paused" }>
  | Sequenced<{ type: "resumed" }>
  | Sequenced<{ type: "interrupted"; elementId?: string; atMs: number }>
  | Sequenced<{ type: "continue_after_interruption"; elementId: string }>
  | Sequenced<{ type: "restart_line"; elementId: string }>
  | Sequenced<{ type: "manual_actor_line_completed"; elementId: string; endedAtMs: number }>
  | Sequenced<{ type: "connection_lost"; reason: string }>
  | Sequenced<{ type: "fallback_selected" }>
  | Sequenced<{ type: "position_confirmed"; elementId: string }>
  | Sequenced<{ type: "stopped" }>;

export type PersistedRehearsalEvent = Exclude<RehearsalEvent, { type: "actor_partial" }>;

export type RehearsalState = {
  sessionId: string;
  actorRoleId: string;
  lines: RehearsalLine[];
  status: RehearsalStatus;
  cursorElementId: string | null;
  pendingAction: RehearsalAction | null;
  omittedElementIds: string[];
  transcriptPreview: string;
  lastSequence: number;
  startedAtMs: number | null;
};
