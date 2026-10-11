"use client";

import { useEffect, useRef, useState } from "react";

import type { PracticeMode } from "@drama/domain/practice";

import type { MicrophoneCheck } from "../../lib/audio/microphone-check";
import { BrowserTakeRecorder, type TakeRecorder } from "../../lib/audio/recorder";

type RecorderPhase = "idle" | "checking" | "starting" | "recording" | "stopping" | "uploading";

export function recorderControlState(phase: RecorderPhase) {
  if (["checking", "starting", "stopping", "uploading"].includes(phase)) {
    return { startDisabled: true, stopDisabled: true, cancelDisabled: true };
  }
  return { startDisabled: phase !== "idle", stopDisabled: phase !== "recording",
    cancelDisabled: phase !== "recording" };
}

export function RecorderControls({ playId, sceneId, playModelVersion, roles, createRecorder,
  practiceMode = "complete_take", onTakeUploaded, showReportLink = true }: {
  playId: string;
  sceneId: string;
  playModelVersion: number;
  roles: Array<{ id: string; name: string }>;
  createRecorder?: (onMicrophoneCheck: (result: MicrophoneCheck) => void) => TakeRecorder;
  practiceMode?: PracticeMode;
  onTakeUploaded?: (takeId: string) => void;
  showReportLink?: boolean;
}) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [interpretation, setInterpretation] = useState("");
  const [retentionChoice, setRetentionChoice] = useState<"retain" | "delete_after_analysis">("retain");
  const [check, setCheck] = useState<MicrophoneCheck | null>(null);
  const [message, setMessage] = useState("");
  const [uploadedTakeId, setUploadedTakeId] = useState<string | null>(null);
  const recorder = useRef<TakeRecorder | null>(null);
  const mounted = useRef(true);
  const controls = recorderControlState(phase);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recorder.current?.cancel();
      recorder.current = null;
    };
  }, []);

  async function start(): Promise<void> {
    setMessage("");
    setPhase("checking");
    const next = createRecorder
      ? createRecorder((result) => { if (mounted.current) setCheck(result); })
      : new BrowserTakeRecorder({ onMicrophoneCheck: (result) => { if (mounted.current) setCheck(result); } });
    recorder.current = next;
    try {
      setPhase("starting");
      await next.start();
      if (mounted.current) setPhase("recording");
    } catch (error) {
      recorder.current = null;
      if (mounted.current) {
        setPhase("idle");
        setMessage(error instanceof Error && error.name === "NotAllowedError"
          ? "Microphone permission is required to record a take."
          : "The microphone could not start. Try again.");
      }
    }
  }

  async function stop(): Promise<void> {
    const current = recorder.current;
    if (!current) return;
    setPhase("stopping");
    try {
      const take = await current.stop();
      recorder.current = null;
      if (!mounted.current) return;
      setPhase("uploading");
      const form = new FormData();
      form.set("audio", new File([take.blob], `take.${take.mimeType.includes("wav") ? "wav" : "webm"}`,
        { type: take.mimeType }));
      form.set("durationMs", String(take.durationMs));
      form.set("playModelVersion", String(playModelVersion));
      form.set("sceneId", sceneId);
      form.set("roleId", roleId);
      form.set("retentionChoice", retentionChoice);
      form.set("practiceMode", practiceMode);
      if (interpretation.trim()) form.set("selectedInterpretation", interpretation.trim());
      const response = await fetch(`/api/plays/${encodeURIComponent(playId)}/takes`, { method: "POST", body: form });
      if (!response.ok) throw new Error("Upload failed");
      const body = await response.json() as { take?: { id?: string } };
      const nextTakeId = body.take?.id ?? null;
      setUploadedTakeId(nextTakeId);
      if (nextTakeId) onTakeUploaded?.(nextTakeId);
      setMessage("Take uploaded privately and queued for coaching.");
    } catch {
      if (mounted.current) setMessage("The take could not be uploaded. Record it again when you are ready.");
    } finally {
      if (mounted.current) setPhase("idle");
    }
  }

  function cancel(): void {
    recorder.current?.cancel();
    recorder.current = null;
    setPhase("idle");
    setMessage("Take cancelled.");
  }

  return <section className="recorder-controls" aria-label="Complete take recorder">
    <label htmlFor="practice-role">Role</label>
    <select id="practice-role" value={roleId} onChange={(event) => setRoleId(event.target.value)}
      disabled={phase !== "idle"}>
      {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
    </select>
    <label htmlFor="practice-interpretation">Interpretation or director concept (optional)</label>
    <input id="practice-interpretation" value={interpretation}
      onChange={(event) => setInterpretation(event.target.value)} disabled={phase !== "idle"} />
    <fieldset disabled={phase !== "idle"}>
      <legend>Audio retention</legend>
      <label><input type="radio" name="retention" checked={retentionChoice === "retain"}
        onChange={() => setRetentionChoice("retain")} /> Keep this recording for progress comparison</label>
      <label><input type="radio" name="retention" checked={retentionChoice === "delete_after_analysis"}
        onChange={() => setRetentionChoice("delete_after_analysis")} /> Delete this recording after analysis</label>
    </fieldset>
    <div className="recorder-actions">
      <button type="button" onClick={() => void start()} disabled={controls.startDisabled || !roleId}>
        {phase === "checking" || phase === "starting" ? "Checking microphone…" : "Start recording"}
      </button>
      <button type="button" onClick={() => void stop()} disabled={controls.stopDisabled}>Stop and upload</button>
      <button type="button" onClick={cancel} disabled={controls.cancelDisabled}>Cancel</button>
    </div>
    {check?.warnings.length ? <p role="status">Microphone advisory: {check.warnings.join(", ")}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {showReportLink && uploadedTakeId ? <a className="button-link" href={`/plays/${encodeURIComponent(playId)}/takes/${uploadedTakeId}`}>
      View coaching progress</a> : null}
  </section>;
}
