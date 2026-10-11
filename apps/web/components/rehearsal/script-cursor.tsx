import type { RehearsalScene } from "./rehearsal-shell";

export function ScriptCursor({ scene, actorRoleId, cursorElementId, revealedElementId,
  transcriptPreview }: { scene: RehearsalScene; actorRoleId: string; cursorElementId: string | null;
  revealedElementId: string | null; transcriptPreview: string }) {
  const cursorIndex = scene.lines.findIndex(({ elementId }) => elementId === cursorElementId);
  const nearby = cursorIndex < 0 ? [] : scene.lines.slice(Math.max(0, cursorIndex - 1), cursorIndex + 2);
  return <section className="rehearsal-script" aria-label="Rehearsal script position">
    <h2>{cursorElementId ? "Current line" : "Scene complete"}</h2>
    {nearby.map((line) => {
      const current = line.elementId === cursorElementId;
      const concealed = line.characterId === actorRoleId && line.elementId !== revealedElementId;
      return <article key={line.elementId} className={current ? "script-line script-line--current" : "script-line"}
        aria-current={current ? "step" : undefined}>
        <header><strong>{line.characterName}</strong><span>{line.voiceLabel}</span></header>
        <p>{concealed ? current ? "Your line is hidden. Ask for a cue when you need it." : "Your upcoming line"
          : line.text}</p>
      </article>;
    })}
    {transcriptPreview ? <p className="transcript-preview" aria-live="polite">Hearing: {transcriptPreview}</p> : null}
  </section>;
}
