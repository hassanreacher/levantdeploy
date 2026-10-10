-- LEVANTBASE (compat): enable pg_graphql on new projects, like hosted projects, so `/graphql/v1` works out of the box
-- (upstream's self-hosting image ships the extension but leaves it disabled → "pg_graphql extension is not enabled").
-- The image's `issue_pg_graphql_access` event trigger grants usage to anon/authenticated/service_role and replaces the
-- graphql_public.graphql() placeholder. Runs once, at database initialisation (existing projects: run the statement
-- below in the SQL editor).

create extension if not exists pg_graphql;
