import { COACHING_RATING_CATEGORIES } from "@drama/domain/coaching";
import type { TakeComparison as Comparison } from "@drama/domain/take-comparison";

const labels = { line_accuracy: "Line accuracy", clarity: "Clarity", pacing: "Pacing",
  cue_responsiveness: "Cue responsiveness", vocal_variation: "Vocal variation" } as const;

export function TakeComparison({ comparison }: { comparison: Comparison | null }) {
  if (!comparison) return <p className="muted">Complete another comparable take to see progress.</p>;
  return <section className="take-comparison"><h2>Compared with your previous take</h2>
    <dl>{COACHING_RATING_CATEGORIES.map((category) => {
      const score = comparison[category];
      return <div key={category}><dt>{labels[category]}</dt><dd>{score
        ? <><span>{score.previous} → {score.current}</span>
          <strong className={score.delta >= 0 ? "delta-positive" : "delta-negative"}>
            {score.delta >= 0 ? "+" : ""}{score.delta}
          </strong></>
        : <span className="muted">Evidence only</span>}</dd></div>;
    })}</dl></section>;
}
