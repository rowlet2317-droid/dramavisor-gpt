import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { cueResponseEvidence, rehearsalEvents } from "./schema";

describe("cueResponseEvidence Drizzle constraints", () => {
  it("declares the same evidence invariants used by the runtime migration", () => {
    // Break caught: omitting Drizzle checks lets schema tooling erase runtime cue-evidence invariants.
    const dialect = new PgDialect();
    const checks = Object.fromEntries(getTableConfig(cueResponseEvidence).checks.map((constraint) => [
      constraint.name,
      dialect.sqlToQuery(constraint.value).sql.replaceAll('"cue_response_evidence".', "")
        .replaceAll('"', "").replace(/\s+/g, " ").trim(),
    ]));

    expect(checks).toEqual({
      cue_response_evidence_version_check: "length(btrim(measurement_version)) > 0",
      cue_response_evidence_clock_check: "clock_id IS NULL OR length(btrim(clock_id)) > 0",
      cue_response_evidence_delay_check: "delay_ms IS NULL OR delay_ms >= 0",
      cue_response_evidence_confidence_check: "confidence IN ('high', 'medium', 'low')",
      cue_response_evidence_score_check: "score IS NULL OR score BETWEEN 0 AND 100",
      cue_response_evidence_qualified_check: "(confidence = 'low' AND score IS NULL) OR "
        + "(confidence IN ('high', 'medium') AND score IS NOT NULL AND delay_ms IS NOT NULL AND "
        + "clock_id IS NOT NULL AND cue_event_id IS NOT NULL AND actor_event_id IS NOT NULL)",
    });
  });
});

describe("rehearsalEvents Drizzle constraints", () => {
  it("declares complete nullable receipt and selected provenance tuples", () => {
    // Break caught: schema tooling must preserve the all-null-or-complete provenance contract.
    const dialect = new PgDialect();
    const checks = Object.fromEntries(getTableConfig(rehearsalEvents).checks.map((constraint) => [
      constraint.name,
      dialect.sqlToQuery(constraint.value).sql.replaceAll('"rehearsal_events".', "")
        .replaceAll('"', "").replace(/\s+/g, " ").trim(),
    ]));

    expect(checks).toEqual({
      rehearsal_events_receipt_timing_check: "(received_at_ms IS NULL AND received_clock_id IS NULL) OR "
        + "(received_at_ms IS NOT NULL AND received_at_ms >= 0 AND received_clock_id IS NOT NULL AND "
        + "length(btrim(received_clock_id)) > 0)",
      rehearsal_events_selected_timing_check: "(timing_source IS NULL AND timing_at_ms IS NULL AND "
        + "timing_clock_id IS NULL) OR (timing_source IN ('provider-derived', 'server-receipt') AND "
        + "timing_at_ms IS NOT NULL AND timing_at_ms >= 0 AND timing_clock_id IS NOT NULL AND "
        + "length(btrim(timing_clock_id)) > 0)",
    });
  });
});
