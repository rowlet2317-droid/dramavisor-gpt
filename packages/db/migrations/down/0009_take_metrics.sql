DROP TABLE IF EXISTS take_metric_lines;
DROP TABLE IF EXISTS take_metrics;
DROP FUNCTION IF EXISTS enforce_current_take_metric_publication();
ALTER TABLE take_transcripts DROP CONSTRAINT IF EXISTS take_transcripts_metric_chain_unique;
