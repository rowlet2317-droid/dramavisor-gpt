import type { StudyGenerator } from "@drama/ai/study/port";
import type { ContextualTutor } from "@drama/ai/tutor/port";
import type { ObjectStorage } from "@drama/storage/port";

export type RuntimeDependencies = {
  storage: ObjectStorage;
  studyGenerator: StudyGenerator;
  tutor: ContextualTutor;
  modelName: string;
  processQueuedJobs: (ownerUserId: string) => Promise<void>;
};

type RuntimeGlobal = typeof globalThis & { __dramaRuntimeDependencies?: RuntimeDependencies | null };

export function installRuntimeDependencies(dependencies: RuntimeDependencies | null): void {
  (globalThis as RuntimeGlobal).__dramaRuntimeDependencies = dependencies;
}

export function getRuntimeDependencies(): RuntimeDependencies | null {
  return (globalThis as RuntimeGlobal).__dramaRuntimeDependencies ?? null;
}
