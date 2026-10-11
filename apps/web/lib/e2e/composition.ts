import type { PlayParser } from "@drama/ai/play-parser/port";
import type { StudyGenerator } from "@drama/ai/study/port";
import type { ContextualTutor } from "@drama/ai/tutor/port";
import type { AudioReviewer, AudioReviewRequest } from "@drama/ai/audio-review/port";
import type { Coach, CoachingSynthesisRequest } from "@drama/ai/coaching/port";
import type { Transcriber, TranscriptionInput } from "@drama/ai/transcription/port";
import type { Database } from "@drama/db/client";
import type { ParseProposal } from "@drama/domain/parse-review";
import type { GroundedClaim, RoleWorkbook, StudyArtifact } from "@drama/domain/study";
import type { CoachingEvidence, CoachingReport } from "@drama/domain/coaching";
import type { Transcript } from "@drama/domain/transcript";
import type { ExtractedScript } from "@drama/media/scripts/extract";
import { ScriptExtractor } from "@drama/media/scripts/extract";
import { MemoryObjectStorage } from "@drama/storage/memory-storage";
import { runWorkerOnce } from "../../../worker/src/index";

import { installRuntimeDependencies } from "../runtime-composition";

export function installE2eComposition(db: Database): void {
  const storage = new MemoryObjectStorage();
  const parser = new DeterministicPlayParser();
  const studyGenerator = new DeterministicStudyGenerator();
  const tutor = new DeterministicTutor();
  const transcriber = new DeterministicTranscriber();
  const audioReviewer = new DeterministicAudioReviewer();
  const coach = new DeterministicCoach();
  installRuntimeDependencies({ storage, studyGenerator, tutor, modelName: "deterministic-e2e",
    processQueuedJobs: async (ownerUserId) => {
      while (await runWorkerOnce({ db, ownerUserId, extractor: new ScriptExtractor(), parser, studyGenerator,
        studyPromptVersion: "e2e-study-v1", analysisModelName: "deterministic-e2e",
        loadPrivateObject: (key) => storage.getPrivate(key), normalizeAudio: async (audio) => audio,
        normalizedAudioStorage: storage, transcriber, audioReviewer, coach })) { /* drain this actor's queue */ }
    },
  });
}

class DeterministicPlayParser implements PlayParser {
  async parse(extracted: ExtractedScript): Promise<ParseProposal> {
    const text = extracted.pages.map((page) => page.text).join("\n");
    const title = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Untitled play";
    const dialogue = [...text.matchAll(/^\s*([A-Z][A-Z0-9 _'-]*):\s*(.+)$/gm)].map((match) => ({
      speaker: match[1]!.trim(), text: match[2]!.trim(),
    }));
    if (dialogue.length < 4) throw new Error("Deterministic parser requires four dialogue lines");
    const characterNames = [...new Set(dialogue.map(({ speaker }) => speaker))];
    const characters = characterNames.map((name) => ({ id: `provider-character-${slug(name)}`,
      name: name.slice(0, 1) + name.slice(1).toLowerCase(), aliases: [] }));
    const characterIds = new Map(characterNames.map((name, index) => [name, characters[index]!.id]));
    const elements = dialogue.map((line, index) => ({ id: `provider-element-${index + 1}`,
      ordinal: index + 1, kind: "dialogue" as const, characterId: characterIds.get(line.speaker)!,
      text: line.text, sourcePage: extracted.pages[0]?.page ?? 1 }));
    return { playModel: { id: "provider-play", title, language: "en",
      characters,
      acts: [{ id: "provider-act-1", ordinal: 1, title: "Act I", scenes: [
        { id: "provider-scene-1", ordinal: 1, title: "Scene One", characterIds: [...characterIds.values()],
          elements },
      ] }],
    }, issues: [
      { id: "provider-issue-unreadable", kind: "unreadable_text", elementIds: [elements[0]!.id],
        message: "Confirm the first line." },
      { id: "provider-issue-owner", kind: "dialogue_owner", elementIds: [elements[1]!.id],
        message: "Confirm who owns this dialogue." },
      { id: "provider-issue-boundary", kind: "scene_boundary",
        elementIds: [elements[2]!.id, elements[3]!.id],
        message: "Choose each new scene boundary one at a time." },
    ] };
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

class DeterministicStudyGenerator implements StudyGenerator {
  async generateStudySection(request: Parameters<StudyGenerator["generateStudySection"]>[0]): Promise<StudyArtifact> {
    const element = request.scopeId
      ? request.play.acts.flatMap((act) => act.scenes).find(({ id }) => id === request.scopeId)?.elements[0]
      : request.play.acts[0]?.scenes[0]?.elements[0];
    if (!element) throw new Error("E2E study passage not found");
    return { id: `${request.kind}:${request.scopeId ?? "play"}`, kind: request.kind, scopeId: request.scopeId,
      claims: [claim(request.play.id, element.id)] };
  }

  async generateRoleWorkbook(request: Parameters<StudyGenerator["generateRoleWorkbook"]>[0]): Promise<RoleWorkbook> {
    const element = request.play.acts.flatMap((act) => act.scenes).flatMap((scene) => scene.elements)
      .find((candidate) => candidate.kind === "dialogue" && candidate.characterId === request.characterId);
    if (!element) throw new Error("E2E role passage not found");
    const claims = [claim(request.play.id, element.id)];
    return { id: `role:${request.characterId}`, characterId: request.characterId,
      directorConcept: request.directorConcept, circumstances: claims, relationships: claims,
      superObjectiveOptions: claims, sceneObjectives: claims, obstacles: claims, stakes: claims, tactics: claims,
      entranceExitStates: claims, beats: claims, subtextOptions: claims, referencedStageDirections: [] };
  }
}

class DeterministicTutor implements ContextualTutor {
  async answer(request: Parameters<ContextualTutor["answer"]>[0]) {
    const element = request.context.elements[0] ?? request.context.scene?.elements[0];
    if (!element) return { answer: "The script does not establish this", claims: [] };
    return { answer: "Alex initiates the exchange.", claims: [claim(request.play.id, element.id)] };
  }
}

class DeterministicTranscriber implements Transcriber {
  readonly version = "deterministic-e2e-v1";
  private takeCount = 0;

  async transcribe(_input: TranscriptionInput): Promise<Transcript> {
    this.takeCount += 1;
    const words = this.takeCount % 2 === 1 ? ["We", "turn", "now"] : ["We", "begin", "now"];
    return { text: words.join(" "), language: "en", provider: "fake", modelName: "deterministic-e2e",
      transcriberVersion: this.version, timingSource: "whisper_word_timestamps",
      words: words.map((text, index) => ({ text, startMs: index * 250, endMs: (index + 1) * 250,
        confidence: 1 })) };
  }
}

class DeterministicAudioReviewer implements AudioReviewer {
  async review(request: AudioReviewRequest): Promise<CoachingEvidence[]> {
    const line = request.lines[0];
    if (!line) return [];
    return [{ id: `audio:${line.elementId}`, kind: "audio_observation", confidence: "high",
      description: "The final word is audibly sustained.", startMs: 0,
      endMs: Math.min(request.durationMs, 750), elementIds: [line.elementId] }];
  }
}

class DeterministicCoach implements Coach {
  async synthesize(request: CoachingSynthesisRequest): Promise<CoachingReport> {
    const lineEvidence = request.lineAccuracy.evidenceIds;
    const firstEvidence = lineEvidence[0] ?? request.evidence[0]?.id;
    if (!firstEvidence) throw new Error("Deterministic coach needs evidence");
    return { ratings: [
      { category: "line_accuracy", ...request.lineAccuracy },
      { category: "clarity", score: null, confidence: "low", evidenceIds: [] },
      { category: "pacing", score: null, confidence: "low", evidenceIds: [] },
      { category: "cue_responsiveness", score: null, confidence: "low", evidenceIds: [] },
      { category: "vocal_variation", score: null, confidence: "low", evidenceIds: [] },
    ], strengths: [{ text: "The thought remains connected.", evidenceIds: [firstEvidence] }],
    priorities: [{ text: "Let the final word land cleanly.", evidenceIds: [firstEvidence] }],
    exercise: { title: "Final-word ladder", instructions: "Repeat the line and sustain its final word.",
      targetCategory: "line_accuracy", evidenceIds: [firstEvidence] }, interpretationNotes: [] };
  }
}

function claim(versionedPlayId: string, elementId: string): GroundedClaim {
  return { id: `claim:${elementId}`, text: "Alex begins the exchange.", epistemicStatus: "explicit",
    reference: { playId: versionedPlayId.replace(/:v\d+$/, ""), elementIds: [elementId] } };
}
