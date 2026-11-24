---
'@runpod/mcp-server': minor
---

List tools take an optional `jmespath` argument that filters rows, chooses columns and sorts on the server before paging, so only the rows and fields an agent needs reach it: `[?status=='RUNNING']`, `[?status=='RUNNING'].{id: id, name: name}`, ``sort_by([?secure && memory >= `48`], &price.secure)``. Without it a list behaves as before. `docs/list-queries.md` explains it.

- 37 lists take it: every generated list and `list-endpoints` and `list-templates`. `list-hub-repos`, `list-public-endpoints`, `get-capacity` and `list-guides` do not; nor does the directory profile.
- `describe-tool` returns each of these lists' `rowFields` (field paths, types and enum values, from the API spec).
- An expression is checked before any API call: an unknown field, an enum value that does not exist, a quoted number, a field read through a list or a form that does not return rows is a 400 with `code: 'invalid_jmespath'` and the fix, instead of an empty result.
- On lists the API pages (`list-pods`, `list-endpoints`, `list-templates`, volumes, clusters, tags, audit logs and others), a call reads up to 5 API pages (500 rows) to fill a page. A filtered page can be empty while `hasNextPage` is true; `pagination.scanned` and the note say how many rows were read. `sort_by` works on these lists up to 500 rows, and is a 400 (`jmespath_list_too_long`) above that.
- Each page call sends `jmespath` again with `cursor`, like every other argument. On a list the API pages it may also be added or changed between pages, and the walk continues from the same row; a cursor into a sorted or whole-list result stays bound to its expression. The server keeps no state between calls.
- Expressions see rows with secret env values already redacted.
- `jmespath` 0.16.0 (Apache-2.0, no dependencies) is bundled, with one patch: `<`, `<=`, `>` and `>=` never match a missing value or a number against text, as the JMESPath spec has it (`patches/`, `THIRD_PARTY_NOTICES.txt`).
- Every session carries 1,251 more tokens: 1,073 in tool definitions (29 per list) and 178 in the server instructions.
