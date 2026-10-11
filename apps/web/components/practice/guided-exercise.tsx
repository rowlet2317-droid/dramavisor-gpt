"use client";

import { useState } from "react";

import type { CoachingReport } from "@drama/domain/coaching";
import type { ExerciseKind, ExerciseSession } from "@drama/domain/exercises";

import { RecorderControls } from "./recorder-controls";

type Phase = "setup" | "ready" | "processing" | "feedback" | "finished";
type ExerciseResponse = { session: ExerciseSession };
type ReportResponse = { take: { state: string }; coaching: { report: CoachingReport | null } | null };

export function GuidedExercise({ playId, sceneId, playModelVersion, roles, e2eMode = false }: {
  playId: string;
  sceneId: string;
  playModelVersion: number;
  roles: Array<{ id: string; name: string }>;
  e2eMode?: boolean;
}) {
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [kind, setKind] = useState<ExerciseKind>("repeat_line");
  const [session, setSession] = useState<ExerciseSession | null>(null);
  const [phase, setPhase] = useState<Phase>("setup");
  const [turn, setTurn] = useState(1);
  const [attempt, setAttempt] = useState(1);
  const [note, setNote] = useState<CoachingReport["priorities"][number] | null>(null);
  const [error, setError] = useState("");
  const [fixture, setFixture] = useState<File | null>(null);

  async function begin(): Promise<void> {
    setError("");
    const response = await fetch(`/api/plays/${encodeURIComponent(playId)}/exercises`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playModelVersion, sceneId, roleId, kind }) });
    if (!response.ok) { setError("The exercise could not be prepared."); return; }
    const body = await response.json() as ExerciseResponse;
    setSession(body.session); setTurn(1); setAttempt(1); setPhase("ready");
  }

  async function uploaded(takeId: string): Promise<void> {
    setPhase("processing"); setError("");
    for (let count = 0; count < 30; count += 1) {
      const response = await fetch(`/api/plays/${encodeURIComponent(playId)}/takes/${encodeURIComponent(takeId)}`,
        { cache: "no-store" });
      if (response.ok) {
        const body = await response.json() as ReportResponse;
        const nextNote = body.coaching?.report?.priorities[0];
        if (nextNote) { setNote(nextNote); setPhase("feedback"); return; }
        if (body.take.state === "action_required") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    setError("Coaching for this attempt is not ready. Try the attempt again."); setPhase("ready");
  }

  async function uploadFixture(): Promise<void> {
    if (!fixture || !session) return;
    setPhase("processing");
    const form = new FormData();
    form.set("audio", fixture); form.set("playModelVersion", String(playModelVersion));
    form.set("sceneId", sceneId); form.set("roleId", roleId); form.set("retentionChoice", "retain");
    form.set("practiceMode", "guided_exercise");
    const response = await fetch(`/api/plays/${encodeURIComponent(playId)}/takes`, { method: "POST", body: form });
    const body = response.ok ? await response.json() as { take?: { id?: string } } : null;
    if (!body?.take?.id) { setError("The prerecorded attempt could not be uploaded."); setPhase("ready"); return; }
    await uploaded(body.take.id);
  }

  function choose(choice: "continue" | "retry" | "finish"): void {
    if (!session || choice === "finish" || choice === "continue" && turn >= session.maxTurns) {
      setPhase("finished"); return;
    }
    if (choice === "continue") setTurn((value) => value + 1);
    setAttempt((value) => value + 1); setNote(null); setPhase("ready");
  }

  if (phase === "finished") return <section className="processing-card"><p className="eyebrow">Exercise complete</p>
    <h2>Keep the useful adjustment</h2><p>No recording starts until you choose another exercise.</p></section>;

  if (!session) return <section className="guided-exercise" aria-labelledby="guided-setup-heading">
    <h2 id="guided-setup-heading">Choose a guided exercise</h2>
    <label htmlFor="exercise-role">Role</label><select id="exercise-role" value={roleId}
      onChange={(event) => setRoleId(event.target.value)}>{roles.map((role) =>
        <option value={role.id} key={role.id}>{role.name}</option>)}</select>
    <label htmlFor="exercise-kind">Exercise</label><select id="exercise-kind" value={kind}
      onChange={(event) => setKind(event.target.value as ExerciseKind)}>
      <option value="repeat_line">Repeat a line</option><option value="change_tactic">Change tactic</option>
      <option value="pause_and_intend">Pause and intend</option>
      <option value="alternative_interpretation">Alternative interpretation</option>
    </select>
    <button type="button" onClick={() => void begin()} disabled={!roleId}>Begin guided exercise</button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;

  return <section className="guided-exercise" aria-labelledby="guided-heading">
    <p className="eyebrow">Turn {turn} of {session.maxTurns}</p><h2 id="guided-heading">{session.prompt}</h2>
    {phase === "ready" ? <>
      <p>Start only when you are ready. The exercise will not activate your microphone automatically.</p>
      {e2eMode ? <div><label htmlFor="exercise-fixture">Prerecorded exercise attempt</label>
        <input id="exercise-fixture" type="file" accept="audio/wav"
          onChange={(event) => setFixture(event.target.files?.[0] ?? null)} />
        <button type="button" disabled={!fixture} onClick={() => void uploadFixture()}>
          Upload prerecorded attempt</button></div>
        : <RecorderControls key={`${turn}:${attempt}`} playId={playId} sceneId={sceneId}
          playModelVersion={playModelVersion} roles={roles.filter(({ id }) => id === roleId)}
          practiceMode="guided_exercise" onTakeUploaded={(takeId) => void uploaded(takeId)}
          showReportLink={false} />}
    </> : null}
    {phase === "processing" ? <p role="status">Preparing one coaching note…</p> : null}
    {phase === "feedback" && note ? <section aria-labelledby="one-note-heading"><h3 id="one-note-heading">
      One coaching note</h3><ul><li data-evidence-ids={note.evidenceIds.join(",")}>{note.text}</li></ul>
      <div className="recorder-actions"><button type="button" onClick={() => choose("continue")}>Continue</button>
        <button type="button" onClick={() => choose("retry")}>Retry</button>
        <button type="button" onClick={() => choose("finish")}>Finish</button></div></section> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
