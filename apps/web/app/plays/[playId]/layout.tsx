import { getDatabase } from "@drama/db/client";
import { StudyRepository } from "@drama/db/repositories/study";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { StudyNav } from "../../../components/study/study-nav";
import { TutorPanel } from "../../../components/study/tutor-panel";
import { requirePageUser } from "../../../lib/auth/page-session";

export default async function PlayStudyLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ playId: string }>;
}) {
  const user = await requirePageUser();
  const { playId } = await params;
  const repository = new StudyRepository(getDatabase());
  if (!await repository.getOwnedPlay(user.id, playId)) notFound();
  const approved = await repository.getApprovedModel(user.id, playId);
  if (!approved) return children;
  return <div className="study-shell">
    <StudyNav playId={playId} play={approved.model} />
    <main className="study-main">{children}</main>
    <TutorPanel playId={playId} play={approved.model} />
  </div>;
}
