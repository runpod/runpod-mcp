---
'@runpod/mcp-server': minor
---

**Breaking for scripts that parse list results.** Every list now returns one page per call: follow `pagination.nextCursor` while `pagination.hasNextPage` is true. `list-endpoints`, `list-hub-repos`, `list-public-endpoints` and `get-capacity` return their rows under `endpoints`, `repos`, `endpoints` and `gpus` instead of `items`; the last three drop `pagination.offset`, and their `pagination.truncated` is now `pagination.hasNextPage`. `list-guides` replaces `count` with `pagination.total`. `get-endpoint-request-metrics`, `get-endpoint-cold-start-metrics` and `get-endpoint-worker-metrics` now page too (20 records by default instead of the API's 1,000). A cursor from an older version is rejected with a 400.

Every list tool now pages the same way, after Google AIP-158: `limit` (a maximum, 1 to 100, default 20; 100 for the small catalogs `list-gpu-types`, `list-cpu-types`, `list-data-centers` and `get-capacity`, which agents compare across as a whole, and for the three endpoint-metrics reads, which are oldest first) and `cursor` in, and the rows plus `pagination: { returned, total?, hasNextPage, nextCursor, listChanged?, note? }` out. The server's connect instructions tell agents to follow `nextCursor` and that a walk is best effort.

- A page also stops before its result passes 24,000 bytes, measured as sent (after secret env values are redacted), so it can hold fewer rows than `limit` while more exist. That keeps a page within what common MCP clients pass to the model from one tool result (`docs/pagination.md` compares them). Separately, a single row larger than that is still returned on its own so the list can move on.
- `nextCursor` resumes right after the last row returned. Lists the API pages follow the API's own cursor, which points at a row's key, so rows added in front do not shift the walk. Lists this server holds whole resume at an offset. A walk is best effort, not a snapshot, and ends as long as the API's cursors move forward (a cursor leading back to the same page is a 502): when rows were added, removed or reordered before the cursor, the page carries `pagination.listChanged: true` and a note to narrow the list with filters for an exact read. `docs/pagination.md` explains the design and the options weighed.
- A cursor is opaque and belongs to the call that issued it: a damaged cursor, or one reused with another tool or different filters, is a 400 with `code: 'invalid_cursor'` and a hint instead of a wrong page, rejected before any API call. Optional arguments sent empty (`""`, `[]`, `null`) count as omitted. `limit` may change between pages.
- `total` is the full count when the server holds the whole list (the catalogs, billing lists, guides, Hub repos, Public Endpoints, capacity), so a first page shows how much exists.
- An API page that reports more results but no cursor, or one leading back to the same page, is a 502, not the end of the list.
- The 14 lists the API pages (`list-pods`, `list-clusters`, `list-network-volumes`, `list-audit-logs`, `list-tags` and others) now return at most 20 rows per call by default instead of the API's default of up to 1,000 rows (200 for the audit log, 100 for endpoint builds and organization groups).
- The 18 lists the API returns whole (`list-gpu-types`, `list-data-centers`, `list-cpu-types`, the six billing lists, `list-cluster-pods`, `list-endpoint-workers`, `list-public-templates`, `list-secrets`, `list-registries`, `list-delegations`, the organization users, roles and invites) now take `limit` and `cursor` and return one page. Fields beside the rows, such as billing `metadata` or the worker `summary`, are kept. Each page re-reads the whole list from the API.
- `list-guides` pages its 118 guides the same way.

Tokens per default call, measured with `@anthropic-ai/tokenizer` on realistic rows as the server sends them:

| Tool (example account)                         | Before | After                            | Saved |
| ---------------------------------------------- | ------ | -------------------------------- | ----- |
| `list-pods` (100 Pods)                         | 42,011 | 7,230 (17 Pods, the size budget) | 83%   |
| `list-guides` (118 guides)                     | 21,040 | 3,178                            | 85%   |
| `list-public-templates` (100 templates)        | 21,285 | 4,344                            | 80%   |
| `list-pod-billing` (10 Pods, 30 daily buckets) | 18,222 | 1,311                            | 93%   |
