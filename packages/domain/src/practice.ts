export const TAKE_STATES = ["uploading", "queued", "processing", "completed", "action_required",
  "completed_with_limitations"] as const;
export type TakeState = typeof TAKE_STATES[number];

export const RETENTION_CHOICES = ["retain", "delete_after_analysis"] as const;
export type RetentionChoice = typeof RETENTION_CHOICES[number];

export const PRACTICE_MODES = ["complete_take", "guided_exercise"] as const;
export type PracticeMode = typeof PRACTICE_MODES[number];

export type PracticeSession = {
  id: string;
  ownerUserId: string;
  playId: string;
  playModelId: string;
  playModelVersion: number;
  sceneId: string;
  roleId: string;
  selectedInterpretation: string | null;
  retentionChoice: RetentionChoice;
  practiceMode: PracticeMode;
  createdAt: Date;
  updatedAt: Date;
};

export type Take = {
  id: string;
  ownerUserId: string;
  practiceSessionId: string;
  playId: string;
  playModelId: string;
  playModelVersion: number;
  sceneId: string;
  roleId: string;
  selectedInterpretation: string | null;
  retentionChoice: RetentionChoice;
  practiceMode: PracticeMode;
  durationMs: number;
  mediaType: "audio/webm" | "audio/wav";
  objectKey: string;
  audioDeletedAt: Date | null;
  state: TakeState;
  createdAt: Date;
  updatedAt: Date;
};
