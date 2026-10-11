export type RealtimeSessionGrant = {
  clientSecret: string;
  expiresAt: string;
  model: string;
  rehearsalSessionId: string;
};

export type IssuedRealtimeCredentials = Omit<RealtimeSessionGrant, "rehearsalSessionId">;

export type RealtimeSessionPurpose =
  | { type: "actor_input" }
  | { type: "role_output"; roleId: string; voice: string };

export type RealtimeEvent =
  | { type: "actor_transcript_partial"; text: string }
  | { type: "actor_transcript_final"; text: string; endedAtMs: number }
  | { type: "speech_started"; characterId: string; elementId: string; startedAtMs: number }
  | { type: "speech_finished"; characterId: string; elementId: string; endedAtMs: number }
  | { type: "interrupted"; atMs: number }
  | { type: "disconnected"; reason: string };

export interface RealtimeCredentialIssuer {
  issue(input: { userId: string; purpose: RealtimeSessionPurpose }): Promise<IssuedRealtimeCredentials>;
}

export type RealtimeSpeechRequest = {
  characterId: string;
  elementId: string;
  exactText: string;
  performanceDirection: string;
};

export interface RealtimeTransport {
  connect(grant: RealtimeSessionGrant): Promise<void>;
  sendAudio(chunk: ArrayBuffer): void;
  requestSpeech(input: RealtimeSpeechRequest): Promise<void>;
  onEvent(listener: (event: RealtimeEvent) => void): () => void;
  close(): Promise<void>;
}
