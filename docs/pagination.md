# Pagination

How every list tool returns its rows one page at a time, which designs we weighed, and why we picked this one. The code is `src/specgen/pagination.ts`; the tests are `tests/specgen-lists.test.ts` and `scripts/smoke-lists.ts`.

## The problem

A list tool used to return the whole list in one result. On a real account that is large: `list-pods` with 100 Pods was 42,011 tokens. MCP clients limit how much of one tool result reaches the model, each in its own way (see "Why 24,000 bytes" below): some truncate it, some move it to a file the agent has to read back, some put all of it into the context. So a list has to come back in pages, and paging has to stay correct while the account changes underneath it: Pods start and stop, audit entries arrive, workers come and go.

## The contract

Every list tool, generated or hand-written, works the same way:

```text
in:   limit   1-100, default 20 (100 for the small catalogs and the metrics; a maximum, not a promise)
      cursor  pagination.nextCursor from the previous page; omit for the first
out:  { <rows>, pagination: { returned, total?, hasNextPage, nextCursor,
                              listChanged?, note? } }
```

- **The default page size is 20**, with two exceptions that default to 100. The four small catalogs agents compare across as a whole ("cheapest 48 GB GPU", "which data center has stock"): `list-gpu-types`, `list-cpu-types`, `list-data-centers` and `get-capacity`, so they usually come back whole in one call; a missing row there gives a wrong answer. And the three endpoint-metrics reads, which are oldest first over a default 24-hour window in 1-hour buckets (up to 25 records): a default of 20 would drop the most recent hours. A generated list sets its default in `listDefaultLimits` in `specgen/generator-config.yaml`, with the reason; a hand-written one in its code.
- **A page holds whole rows.** It stops at `limit` rows, or before the result passes 24,000 bytes (`PAGE_BUDGET_BYTES`), whichever comes first. A row is never cut. A single row larger than the budget comes back alone, so the walk can move on.
- **`hasNextPage` is the only end signal.** `returned` below `limit` is normal; it means the byte budget stopped the page.
- **The cursor is opaque** and belongs to the tool and arguments that issued it. It ends in a checksum, so a cursor an agent copied wrong is refused rather than read as another page. Reusing it with another tool or other filters, or damaging it, is a 400 with `code: 'invalid_cursor'`, before any API call.
- **`total`** is present when this server holds the whole list.
- **A walk ends.** Every page moves forward, as long as the API's cursors do (a cursor that leads back to the same page is a 502). Nothing ever tells an agent to start over, because on a list that keeps changing that would loop.

The byte budget is in bytes because a token is at least one byte and a character at most four: 24,000 bytes is at most 24,000 tokens and 24,000 characters in any language (one rare exception, NFKC compatibility characters, is in `docs/size-limits.md`). Counting characters instead does not bound tokens: 32,000 characters of CJK text measured 68,548 tokens.

**Why 24,000 bytes.** The server is used from many MCP clients, and each limits one tool result differently. Known defaults, for orientation (they change between versions, and some are set by the user):

| Client                    | Limit on one tool result                                           | Past it                              |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| Claude Code               | 25,000 tokens or 50,000 characters                                 | saved to a file the agent reads back |
| Codex CLI                 | about 10,000 tokens (`tool_output_token_limit`, settable per tool) | truncated                            |
| Gemini CLI                | 40,000 characters (`tools.truncateToolOutputThreshold`)            | truncated                            |
| Cursor, VS Code, Windsurf | not documented                                                     | —                                    |

24,000 bytes is at most 24,000 characters, so a page is always under the character limits above. Typical JSON runs about 4.3 bytes per token, so a full page is about 5,500 tokens (the largest measured, 17 Pods, 7,230), under every token limit above. Only a page full of dense non-Latin text could pass a 10,000-token limit. One budget applies to every client: the server cannot reliably know a client's setting, and paging stays the same everywhere. A smaller budget would guarantee the strictest worst case but cut every normal page short.

**What the 24,000 bytes cover.** The whole result exactly as the agent receives it, not just the rows: the outer object and rows key, JSON punctuation, the indentation and line breaks of the pretty-printed JSON the server sends, the `pagination` block with its cursor and note, any fields the API returned beside the rows (billing `metadata`, a worker `summary`), and secret env values after they are replaced by `[redacted]`, which can be longer than the value. The page is built at each candidate size and measured that way (`resultBytes` and `fittingRows` in `pagination.ts`), and the smoke test measures the text a real MCP client receives. Not counted is the MCP transport envelope that wraps this text; clients' limits apply to the text the model reads, not to the transport.

## How a cursor moves

There are two kinds of list, and the cursor works differently for each.

**Lists the API pages** (Pods, clusters, volumes, tags, audit logs, endpoint metrics, …). The Runpod API has its own cursor, and it points at a row's key: the audit-log cursor decodes to the last entry's time, actor, resource and action (checked live, 2026-11-20). Our page can be smaller than the API's page, because of the byte budget. Then our cursor records the API cursor plus how many of that API page's rows were already returned, and the next call re-reads that API page with room for a full page and skips those rows. The API accepts its cursor again with a larger `limit` (checked live).

**Lists this server holds whole** (catalogs, billing, secrets, registries, workers, guides, Hub repos, Public Endpoints, capacity). The API returns everything; this server cuts it into pages. The cursor records an offset.

Whenever the cursor resumes at a position (an offset, or inside a re-read API page), it also carries a short mark of the last row returned: a hash of its `id` (`endpointId` for Public Endpoints), or of the whole row when it has none. If the row just before the resume point is not that row any more, rows were added, removed or reordered before it, or the list shrank below the position, and the page says `listChanged: true` with a note: rows may repeat or be missing, and for an exact read, narrow the list with filters. A cursor to the API's next page needs no mark, because the API's cursor already names the row to continue after.

## Where it comes from

- [Google AIP-158](https://google.aip.dev/158): `limit` is a maximum, the page token is opaque and bound to the request's other parameters, a total is optional.
- [DynamoDB Query](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html): a page stops at the item limit or a size cap, whichever comes first.
- [Stripe](https://docs.stripe.com/api/pagination): a key cursor (`starting_after`) that continues after the last object; the Runpod API's cursor works this way.
- [Kubernetes list chunking](https://kubernetes.io/docs/reference/using-api/api-concepts/#retrieving-large-results-sets-in-chunks): consistent snapshots that expire; weighed and not taken (see below).
- [Anthropic, "Writing effective tools for agents"](https://www.anthropic.com/engineering/writing-tools-for-agents): paginate with sensible defaults and tell the agent when there is more.

Our own additions: the byte budget measured on the result exactly as sent, and the last-row mark that reports a change between pages as `listChanged`.

## Options we weighed

| Option                        | Used by                                                       | Rows change mid-walk                                                 | Can a walk fail to finish?                                             | Cost                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Offset** ("skip 40")        | Simple APIs                                                   | Inserts or deletes before the position repeat or skip rows           | No                                                                     | Smallest                                                                                                                                                               |
| **Key cursor** ("after id X") | Stripe (`starting_after`), the Runpod API                     | Inserts and deletes before the cursor do not move it; not a snapshot | No                                                                     | Small; needs a stable order with a unique key                                                                                                                          |
| **Server snapshot**           | Kubernetes (`resourceVersion` + `continue`), database cursors | Exact                                                                | Yes: snapshots expire (Kubernetes: 5–15 minutes, then 410 and restart) | State on the server; the hosted server runs several instances, so a cursor can reach one without the snapshot                                                          |
| **Client snapshot**           | Clients that save oversized results to a file                 | Exact                                                                | No                                                                     | Depends on the client: some save big results to a file, others truncate them or put them into the context. Lists the API pages would have to be fetched in full first. |
| **Restart on change**         | —                                                             | Exact when it finishes                                               | Yes: a list that keeps changing never finishes                         | —                                                                                                                                                                      |

**What we chose:** the key cursor where the API provides one, an offset where this server holds the list, and a change flag on both. It is the smallest design that never loops, never needs state on the server, and works in every MCP client. Its cost is that a list held whole can repeat or skip a row when it changes between two pages; the page then says so.

**What we did not build, and when to:**

- **A key cursor for lists held whole** (Stripe's `starting_after`: resume after the marked row when it is still there). About six lines in `pageInMemory`; the mark already identifies the row. It would make the 14 lists held whole that have an `id` (or `endpointId`) as robust as the API-paged ones. `get-capacity` and `list-hub-repos` would stay on offsets: they are ranked by live stock and deploy counts, so a row jumps around and resuming after it would wander. Build it if agents report repeated or missing rows.
- **An exact snapshot on request**, as an MCP `resource_link` the client fetches separately. Build it if an agent needs a guaranteed complete, consistent list.
- **Filters on the API side** (by status, by time). A narrow list fits on one page, which makes change between pages moot. This is the long-term answer for big lists that churn.

## Every list

| Group                             | Lists                                                                                                                                                                                                                                                                                                                                      | Cursor                               | Change handling                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API-paged, rows with `id`         | `list-pods`, `list-clusters`, `list-network-volumes`, `list-global-volumes`, `list-queued-pods`, `list-tags`, `list-tag-resources`, `list-cost-centers`, `list-cost-center-resources`, `list-endpoint-builds`, `list-endpoint-releases`, `list-organization-groups`, `list-organization-group-members`, `list-endpoints`, `list-templates` | API cursor (+ rows already returned) | API key cursor; mark on a re-read API page                                                                                                                                                            |
| API-paged, time-keyed             | `list-audit-logs`, `get-endpoint-request-metrics`, `get-endpoint-cold-start-metrics`, `get-endpoint-worker-metrics`                                                                                                                                                                                                                        | same                                 | same                                                                                                                                                                                                  |
| Held whole, rows with `id`        | `list-gpu-types`, `list-cpu-types`, `list-data-centers`, `list-public-templates`, `list-secrets`, `list-registries`, `list-delegations`, `list-endpoint-workers`, `list-cluster-pods`, `list-organization-users`, `list-organization-roles`, `list-organization-invites`, `list-guides`, `list-public-endpoints`                           | offset                               | mark → `listChanged`                                                                                                                                                                                  |
| Held whole, time buckets          | `list-billing`, `list-pod-billing`, `list-serverless-billing`, `list-endpoint-billing`, `list-network-volume-billing`, `list-cluster-billing`                                                                                                                                                                                              | offset                               | mark on the whole record → `listChanged`: without `startTime` the 30-day window drops its oldest bucket at each boundary, shifting every row; a growing amount on the last record returned also flags |
| Held whole, ranked by live values | `get-capacity`, `list-hub-repos`                                                                                                                                                                                                                                                                                                           | offset                               | mark → `listChanged`; their order moves with stock and deploys, so rows can repeat or be missed between pages                                                                                         |

A new generated list needs nothing: the generator treats any GET named `list*`, or one that takes a `cursor`, as a list, and `pnpm test` walks every list over eight fake account shapes. A new hand-written list needs an entry in `LISTS` in `scripts/smoke-lists.ts` (and in `GRAPHQL_LISTS` there if it reads GraphQL); `pnpm test` fails until it has one.

`RUNPOD_API_KEY=… pnpm smoke:lists --live` walks every list on that key's account. It creates free test data first (a Serverless endpoint that can never start a worker, with a tag and a cost center attached, all named `mcp-smoke-*`) so the nested lists have a parent, and deletes it afterwards. A skip fails the run. Six lists stay covered by the fake API only: `list-cluster-pods` needs an Instant Cluster, which bills, and the five organization lists need a key with membership scopes.

## Long text and logs (not paged yet)

Paging is one idea: split a sequence of whole units into pages. A list's unit is a row. Text has none until we pick one.

- **READMEs and guides:** the unit would be a line. A page holds whole lines up to the byte budget; the cursor means "after line N". Text that fits returns unchanged.
- **Logs:** they only grow at the end, so "start at line N, give me M lines" is stable (an offset works here, unlike in a list that grows at the front), as long as old lines are not dropped. The stream's own event id (`Last-Event-ID`) is the key-cursor version. Today the log tools cut a snapshot at 32,000 characters instead.
- **Job output and single large objects:** one JSON value has no units. It cannot be paged, only cut with a visible "truncated" note.
