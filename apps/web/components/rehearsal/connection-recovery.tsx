import type { FallbackReadiness } from "../../lib/realtime/fallback-player";

export function ConnectionRecovery({ visible, reconnecting, readiness, onRetry, onFallback, onEndAndSave }: {
  visible: boolean;
  reconnecting: boolean;
  readiness: FallbackReadiness;
  onRetry: () => void;
  onFallback: () => void;
  onEndAndSave: () => void;
}) {
  if (!visible && !reconnecting) return null;
  return <section aria-live="polite" aria-label="Connection recovery">
    <p>{reconnecting ? "Reconnecting rehearsal…" : "Realtime connection could not be restored."}</p>
    {visible ? <div>
      <button type="button" onClick={onRetry}>Retry</button>
      {readiness.canContinue
        ? <button type="button" onClick={onFallback}>Continue with Scripted Voices</button> : null}
      <button type="button" onClick={onEndAndSave}>End and Save</button>
    </div> : null}
  </section>;
}
