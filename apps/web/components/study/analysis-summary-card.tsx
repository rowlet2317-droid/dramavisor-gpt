import type { GroundedClaim } from "@drama/domain/study";

export function AnalysisSummaryCard({ title, claims, href, unavailable = "Analysis is not available yet." }: {
  title: string;
  claims: GroundedClaim[] | undefined;
  href: string;
  unavailable?: string;
}) {
  const summary = claims?.[0]?.text;
  return <article className="analysis-summary-card">
    <div><h3>{title}</h3><span>{claims?.length ?? 0} grounded {claims?.length === 1 ? "note" : "notes"}</span></div>
    <p className={summary ? undefined : "muted"}>{summary ?? unavailable}</p>
    {claims?.length ? <a className="analysis-summary-card__link" href={href}>Explore {title.toLowerCase()} →</a> : null}
  </article>;
}
