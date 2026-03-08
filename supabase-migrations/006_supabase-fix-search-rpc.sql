-- Fix: search_files RPC returns no results when called with service key
-- Problem: auth.uid() returns NULL for service role, so the owner_id check
-- filters out all rows. The service key should bypass RLS (and does for direct
-- queries), but SECURITY DEFINER functions run as the function owner, not the caller.
--
-- Solution: Check if auth.uid() is NULL (service role) and skip the owner filter.
-- The service key is already trusted — it bypasses RLS on direct table access.

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
    ts_rank(fc.content_tsv, websearch_to_tsquery('english', search_query))::REAL AS rank
  FROM file_contents fc
  JOIN repositories r ON r.id = fc.repo_id
  WHERE fc.content_tsv @@ websearch_to_tsquery('english', search_query)
    AND (auth.uid() IS NULL OR r.owner_id = auth.uid())
    AND (lang_filter IS NULL OR fc.language = lang_filter)
  ORDER BY rank DESC
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
