DROP TRIGGER IF EXISTS coaching_reports_require_current_transcript ON coaching_reports;
DROP FUNCTION IF EXISTS enforce_current_coaching_report_publication();
DROP TABLE IF EXISTS coaching_reports;
