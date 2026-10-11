"use client";

import type { PlayModel } from "@drama/domain/play-model";
import type { GroundedClaim as GroundedClaimValue } from "@drama/domain/study";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { GroundedClaim } from "./grounded-claim";

export function TutorPanel({ playId, play }: { playId: string; play: PlayModel }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ text: string; claims: GroundedClaimValue[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const sceneSegment = pathname.match(/\/scenes\/([^/]+)/)?.[1];
      const sceneId = sceneSegment ? decodeURIComponent(sceneSegment) : undefined;
      const characterId = searchParams.get("characterId") ?? undefined;
      const elementIds = searchParams.getAll("elementId");
      const response = await fetch(`/api/plays/${playId}/tutor`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          question, context: { sceneId, characterId, elementIds: elementIds.length ? elementIds : undefined },
        }),
      });
      const result = await response.json().catch(() => ({})) as {
        answer?: string; claims?: GroundedClaimValue[]; error?: string;
      };
      setAnswer({ text: response.ok ? result.answer ?? "" : result.error ?? "Unable to answer",
        claims: response.ok ? result.claims ?? [] : [] });
    } catch {
      setAnswer({ text: "Unable to reach the script tutor. Please try again.", claims: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="study-tutor">
      <aside className="tutor-desktop" aria-label="Contextual script tutor"><TutorContent idPrefix="desktop"
        question={question} setQuestion={setQuestion} ask={ask} busy={busy} hydrated={hydrated} answer={answer}
        claims={answer?.claims ?? []} play={play} /></aside>
      <details className="tutor-drawer">
        <summary>Ask the script tutor</summary>
        <div className="tutor-drawer__content"><TutorContent idPrefix="drawer" question={question}
          setQuestion={setQuestion} ask={ask} busy={busy} hydrated={hydrated} answer={answer} claims={answer?.claims ?? []}
          play={play} /></div>
      </details>
    </div>
  );
}

function TutorContent({ idPrefix, question, setQuestion, ask, busy, hydrated, answer, claims, play }: {
  idPrefix: string;
  question: string;
  setQuestion: (value: string) => void;
  ask: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  hydrated: boolean;
  answer: { text: string } | null;
  claims: GroundedClaimValue[];
  play: PlayModel;
}) {
  return <>
    <p className="eyebrow">Grounded help</p>
    <h2>Script tutor</h2>
    <p className="muted">Ask about the current scene or selected role. Answers stay tied to the script.</p>
    <form onSubmit={ask}>
      <label htmlFor={`${idPrefix}-tutor-question`}>Your question</label>
      <textarea id={`${idPrefix}-tutor-question`} rows={4} required maxLength={2000} value={question}
        disabled={!hydrated}
        onChange={(event) => setQuestion(event.target.value)} />
      <button type="submit" disabled={!hydrated || busy}>{busy ? "Checking the script…" : "Ask"}</button>
    </form>
    {answer ? <div role="status" className="tutor-answer"><p>{answer.text}</p>
      {claims.map((claim) => <GroundedClaim key={claim.id} claim={claim} play={play} />)}</div> : null}
  </>;
}
