import type { RehearsalStatus } from "@drama/domain/rehearsal/types";

export function RehearsalControls({ status, onStart, onPause, onResume, onCue, onRestartBeat, onContinue,
  onRestartLine, onStop }:
  { status: RehearsalStatus; onStart: () => void; onPause: () => void; onResume: () => void;
    onCue: () => void; onRestartBeat: () => void; onContinue: () => void; onRestartLine: () => void;
    onStop: () => void }) {
  const started = status !== "ready";
  const canCue = status === "active" || status === "paused" || status === "needs_position_confirmation";
  const canRestartBeat = status === "active" || status === "needs_position_confirmation";
  return <div className="rehearsal-controls" aria-label="Rehearsal controls">
    <button type="button" onClick={onStart} disabled={started}>Start rehearsal</button>
    <button type="button" onClick={onPause} disabled={status !== "active" && status !== "disconnected"}>Pause</button>
    <button type="button" onClick={onResume} disabled={status !== "paused" && status !== "disconnected"}>Resume</button>
    <button type="button" onClick={onCue} disabled={!canCue}>Cue</button>
    <button type="button" onClick={onRestartBeat}
      disabled={!canRestartBeat}>Restart beat</button>
    <button type="button" onClick={onContinue} disabled={status !== "await_interruption_choice"}>Continue</button>
    <button type="button" onClick={onRestartLine} disabled={status !== "await_interruption_choice"}>Restart line</button>
    <button type="button" onClick={onStop} disabled={!started || status === "stopped"}>Stop rehearsal</button>
  </div>;
}
