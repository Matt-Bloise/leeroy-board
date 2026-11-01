-- 0003 performance indexes: index lib_sources.checked_at and fact_fixes
-- Eliminates full table scans during cron source sweeps and audit lookups.

CREATE INDEX IF NOT EXISTS idx_lib_sources_checked ON lib_sources(checked_at ASC);
CREATE INDEX IF NOT EXISTS idx_fact_fixes_page ON fact_fixes(page_id);
CREATE INDEX IF NOT EXISTS idx_fact_fixes_created ON fact_fixes(created_at DESC);
