import { z } from "zod";

export const ScriptElementSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    ordinal: z.number().int().positive(),
    kind: z.literal("dialogue"),
    characterId: z.string(),
    text: z.string().min(1),
    sourcePage: z.number().int().positive().nullable(),
  }),
  z.object({
    id: z.string(),
    ordinal: z.number().int().positive(),
    kind: z.literal("stage_direction"),
    text: z.string().min(1),
    sourcePage: z.number().int().positive().nullable(),
  }),
  z.object({
    id: z.string(),
    ordinal: z.number().int().positive(),
    kind: z.literal("heading"),
    text: z.string().min(1),
    sourcePage: z.number().int().positive().nullable(),
  }),
]);

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  aliases: z.array(z.string()),
});

export const SceneSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().positive(),
  title: z.string(),
  characterIds: z.array(z.string()),
  elements: z.array(ScriptElementSchema),
});

export const ActSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().positive(),
  title: z.string(),
  scenes: z.array(SceneSchema),
});

export const PlayModelSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  language: z.literal("en"),
  acts: z.array(ActSchema),
  characters: z.array(CharacterSchema),
});

export type PlayModel = z.infer<typeof PlayModelSchema>;
export type ScriptElement = z.infer<typeof ScriptElementSchema>;
export type ScriptReference = { playId: string; elementIds: string[] };
