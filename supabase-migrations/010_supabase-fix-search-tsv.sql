-- Fix: search_code returns no results because content_tsv is NULL
--
-- Root cause: The generated column was likely never created properly.
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS with GENERATED ALWAYS can
-- silently fail or add a plain (non-generated) column on some Postgres
-- versions. Either way, content_tsv is NULL for all rows.
--
-- Fix: Drop and recreate the column as a proper generated column using
-- the 'simple' dictionary (better for code — no stemming or stop words).
-- Also update the search_files RPC to use 'simple' to match.

-- 1. Drop the GIN index first
DROP INDEX IF EXISTS idx_file_contents_tsv;

-- 2. Drop the old (broken) column
ALTER TABLE file_contents DROP COLUMN IF EXISTS content_tsv;

-- 3. Re-add as a proper generated column with 'simple' dictionary
ALTER TABLE file_contents
  ADD COLUMN content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

-- 4. Recreate the GIN index
CREATE INDEX idx_file_contents_tsv ON file_contents USING GIN (content_tsv);

-- 5. Update the search_files RPC to use 'simple' dictionary
CREATE OR REPLACE FUNCTION search_files(
  search_query TEXT,
  result_limit INTEGER DEFAULT 10,
  lang_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
  file_path TEXT,
  language TEXT,
  size_bytes INTEGER,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    fc.file_path,
    fc.language,
    fc.size_bytes,
    ts_rank(fc.content_tsv, websearch_to_tsquery('simple', search_query))::REAL AS rank
  FROM file_contents fc
  JOIN repositories r ON r.id = fc.repo_id
  WHERE fc.content_tsv @@ websearch_to_tsquery('simple', search_query)
    AND (auth.uid() IS NULL OR r.owner_id = auth.uid())
    AND (lang_filter IS NULL OR fc.language = lang_filter)
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
