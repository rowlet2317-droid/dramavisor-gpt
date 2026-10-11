import type { CoachingReport } from "@drama/domain/coaching";

const labels = {
  line_accuracy: "Line accuracy",
  clarity: "Clarity",
  pacing: "Pacing",
  cue_responsiveness: "Cue responsiveness",
  vocal_variation: "Vocal variation",
} as const;

export function RatingCard({ rating }: { rating: CoachingReport["ratings"][number] }) {
  return <article className="rating-card">
    <p>{labels[rating.category]}</p>
    <strong>{rating.score === null ? "N/A" : rating.score}</strong>
    <span className={`confidence confidence--${rating.confidence}`}>{rating.confidence} confidence</span>
  </article>;
}
