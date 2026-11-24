# Querying lists with `jmespath`

Most list tools take an optional `jmespath` argument: [JMESPath](https://jmespath.org), the same expression language AWS CLI's `--query` runs — but here it runs on the server, before the rows are paged, over a restricted set of forms that stay correct across pages (`--query` runs on the CLI's own machine, after it has already fetched and paged through everything itself, and accepts the full grammar). Without it a list behaves exactly as before. The code is `src/specgen/list-query.ts` (checks and evaluation) and the end of `src/specgen/pagination.ts` (scanning and sorting); the tests are `tests/specgen-jmespath.test.ts` and `scripts/smoke-lists.ts`. Paging itself is in `docs/pagination.md`.

## Why

Pods, endpoints, templates and volumes have no filter in the Runpod API or in this server. An agent that wants "my running Pods" or "the cheapest 48 GB GPU" reads every page and filters in its own context, about 1.5 KB per Pod row. With `jmespath` the server does the filtering and only the matching rows, with only the columns asked for, reach the agent.

Filters the API has (catalog filters, billing windows, audit-log actors) are still tool arguments and run first, at the source. `jmespath` runs on what the API returned. The agent works on what `jmespath` returned.

## What an agent can write

| Form               | Example                                                                        | What it does                                                              |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Filter             | ``[?status=='RUNNING' && cost > `0.5`]``                                       | Rows that match, whole                                                    |
| Filter and columns | `[?status=='RUNNING'].{id: id, name: name, gpu: gpu.id}`                       | Matching rows, only these fields, under these names                       |
| Columns            | `[].{id: id, name: name}`                                                      | Every row, only these fields (`[*]` or `[]` alone: every row, whole)      |
| Sort               | ``sort_by([?secure && memory >= `48`].{id: id, price: price.secure}, &price)`` | Any of the above, ordered by a field (of the output, when it has columns) |
| Sort, descending   | `reverse(sort_by(@, &createdAt))`                                              | The same, reversed                                                        |

Text goes in single quotes (`'RUNNING'`), numbers and `true`/`false` in backticks (`` `0.5` ``), `null` as `` `null` ``. `<`, `<=`, `>` and `>=` compare two numbers, or two texts as text (right for ISO timestamps such as `createdAt`); anything else, a missing value included, never matches, so ``[?cost < `1`]`` leaves out rows with no cost. One of several values: `[?status=='RUNNING' || status=='STARTING']`. A list field is filtered by its items: `[?tags[?key=='team']]`, or `[?contains(ports, '8888/http')]` for a list of text. Matching is case-sensitive; `[?name && (contains(name, 'vllm') || contains(name, 'VLLM'))]` matches both spellings.

An expression may also start from the key the rows come back under (`pods[?status=='RUNNING']`, `sort_by(pods, &cost)`), as other servers' JMESPath arguments expect; it means the same as without it. Only these forms are accepted. Each keeps rows independent: a row's result depends on that row alone, so reading a list one API page at a time gives exactly what the expression gives on the whole list. That is what makes filtering across API pages correct. Counts and "the first N" need no expression: `pagination.total` and `limit` give them.

## Which lists take it

37 lists: every generated list (35, from `list-pods` and `list-gpu-types` to the billing lists and the endpoint-metrics reads) and the hand-written `list-endpoints` and `list-templates`, whose expression sees the trimmed rows they return.

Four lists do not: `list-hub-repos`, `list-public-endpoints` and `get-capacity` read GraphQL, so there is no API spec row schema to check fields against, and they have their own filters; `list-guides` has its own `query`, `kind` and `concept`. The directory profile (`/directory`) serves no `jmespath`: agents find a list's fields through `describe-tool`, which that profile does not serve.

## How an agent finds the fields

- `describe-tool` returns `rowFields` for every list that takes `jmespath`: each field path with its type, enum values spelled out (`status: PROVISIONING | STARTING | RUNNING | EXITED | ERROR | TERMINATED`), array items as `tags[].key`, free-form maps as `object (any keys)`. It costs nothing until called.
- Every mistake that would otherwise return no rows is a 400 that names the fix (below), including the valid fields at that point.
- `limit: 1` shows a real row.

The fields come from the API spec (the generator writes each list's `rowSchema` into `tools.gen.ts`; where the spec has variants, `oneOf` and the like, their fields and enum values are merged, so a value one variant allows is never refused). They are the v2 names: a Pod's state is `status`, its price `cost`. `pnpm smoke:lists --live` checks that every field of the live rows it reads is in the schema, with the schema's type and enum values.

## Checks before any API call

An expression is checked against the list's row schema before anything is fetched. Each check stops a mistake that would otherwise come back as an empty, plausible answer:

| Mistake                                  | Example                           | 400 says                                          |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------- |
| Unknown field                            | `[?desiredStatus=='RUNNING']`     | the field is unknown, and lists the fields there  |
| Bare word read as a field                | `[?status == RUNNING]`            | the same, and to quote text                       |
| Enum value that does not exist           | `[?status=='RUNING']`             | the field's values                                |
| A number field compared with quoted text | `[?cost > '0.5']`                 | write numbers in backticks                        |
| A text field compared with a number      | ``[?name == `1`]``                | write text in single quotes                       |
| A field read from a text or number       | `[?gpu.id.x]`                     | that value has no fields                          |
| A field read through a list              | `[?tags.key=='team']`             | filter the list's items: `[?tags[?key=='team']]`  |
| A list compared with one value           | `[?ports=='8888/http']`           | use `contains(ports, '8888/http')`                |
| Not one of the forms                     | `length(@)`, `[0]`, `[].name`     | the accepted forms; counts are `pagination.total` |
| A list of values                         | `[?contains(['A', 'B'], status)]` | `[?status=='A' \|\| status=='B']`                 |
| Syntax error                             | `[?status==`                      | the parser's message                              |
| Longer than 500 characters               |                                   | the limit                                         |

Errors have `code: 'invalid_jmespath'`, an `error` and a `hint`. Fields are checked in their context: inside `tags[?key=='team']` the fields are a tag's; a sort key after columns is an output column. Free-form maps (`env`) are not checked below themselves.

Three mistakes can only show while running, each a 400 with the fix: a sort key that is missing on some rows (`sort_by(@, &cost)` with a `null` cost; filter first, ``sort_by([?cost != `null`], &cost)``), a function given a missing field (`starts_with(name, 'x')` where `name` is `null`; guard it, `[?name && starts_with(name, 'x')]`), and columns that make a row larger than the list's own rows (`[].{a: @, b: @}`; name each field once).

## Lists the API pages: scanning

The API returns these lists 100 rows at a time and has no filter, so the server reads API pages from the cursor, keeps the rows that match, and stops when the page is full or after 5 API pages (500 rows, `MAX_SCAN_PAGES`). The page then says how far it got:

```text
pagination: { returned: 3, scanned: 500, hasNextPage: true, nextCursor: "v1.…",
              note: "3 of 500 rows scanned matched. More rows remain: pass cursor=nextCursor
                     to keep scanning before concluding a match is absent." }
```

- `scanned` is the number of list rows up to `nextCursor`, so "N of M rows scanned matched" is exact, and the `scanned` values of a whole walk add up to the list's length.
- **A page can be empty while `hasNextPage` is true**: no match in those 500 rows, more to read. The note says so, and the server instructions tell agents to keep following `nextCursor` before concluding a match is absent.
- `total` (the number of matches) is present only when one call read the whole list from its start.
- The cursor counts raw API rows, not matches, so a page that drops `id` from its columns still resumes at the right row, a row removed before the resume point still sets `listChanged`, and the expression may change between pages (below).
- When a page fills up inside an API page, the next call reads that API page again and continues after the last row returned; rows after it are evaluated twice. That costs work, never a wrong row.
- Each call reads at most 5 API pages, so up to about 0.75 to 3 seconds (one API call measured 150 to 600 ms), and the calls count against the API's per-minute rate limit.

## Paging with a filter

Every page call sends its arguments again, `jmespath` included, with `cursor` set to the previous page's `nextCursor`: the same pattern as every other argument of a list tool (Google AIP-158, AWS `NextToken`). The server keeps nothing between calls; the cursor holds the place to continue from and a checksum of the other arguments.

- **On a list the API pages,** the cursor is a place in the list's rows, so `jmespath` may be added, changed or dropped between pages: the next page continues from the same row under the expression sent with it. An agent that paged the plain list and then adds a filter keeps its place. Sending a cursor without `jmespath` continues unfiltered.
- **After `sort_by`, and on a list held whole,** the cursor is a place in the expression's result, so it works only with the same expression; anything else is a 400 `invalid_cursor` before any API call.
- Changing any other argument (a filter such as `includeClusterPods`) with an old cursor is a 400 `invalid_cursor`, as without `jmespath`. Its hint says to call again without `cursor`.
- Each filtered page's note repeats the rule: call again with `cursor=nextCursor` and the same `jmespath`.

## Sorting

`sort_by` needs every row. On a list this server holds whole it always works. On a list the API pages, the server reads it from the start, up to 5 API pages: a list of up to 500 rows is sorted and paged like a list held whole (an offset cursor; each page reads the list again), and a longer one is a 400 with `code: 'jmespath_list_too_long'` rather than a sort of the first 500 rows. Whether a call sorts depends on the expression, never on the data, so one cursor never changes mode. Sorting longer lists needs a sort parameter in the API.

## Lists held whole

The server already has every row: the expression runs once on all of them and the result is paged with the existing offset cursor. `total` is the number of matches, the note says "N of M rows matched", and fields the API returns beside the rows (billing `metadata`, a worker `summary`) are kept as they are.

## Safety

- **Secrets.** The expression runs on rows whose secret env values are already replaced by `[redacted]`, the same redaction every result gets. Without that, `[?starts_with(env.HF_TOKEN, 'hf_a')]` could read a secret one character at a time.
- **No code execution.** JMESPath has no file, network or environment access and no loops. The engine is `jmespath` 0.16.0 (Apache-2.0, no dependencies), bundled into this package with one patch (`patches/jmespath@0.16.0.patch`): `<`, `<=`, `>` and `>=` are null unless both sides are numbers or both are text, as the JMESPath spec has it, instead of JavaScript's comparison, which counts `null` as 0. It looks fields up without an own-property check, so the names of JavaScript's built-in object properties (`constructor`, `__proto__`, `toString`, …) are refused everywhere, and only the 26 standard functions are allowed.
- **Bounded work and output.** No pipes (`|`) and no lists of values (`[a, b]`); at most 500 characters; at most 5 API pages per call; and an output row is never larger than its input row (row by row) or the list's largest row (`sort_by`, which reorders rows and so has no one input row to hold each output row against), so columns cannot multiply a row past what the API sent. The engine has no timeout; these bounds keep an expression on 500 rows in milliseconds.
- **Never forwarded, never stored.** The expression is not sent to the Runpod API or into a GraphQL query, and the server keeps no state between calls: each call carries its expression, and a cursor into a sorted or whole-list result is bound to its expression.

## Why JMESPath

It is a small, specified query language that models already write well (the AWS CLI's `--query`), it has no side effects, and its syntax tree can be checked before running. jq and JSONata can read the environment, read files or loop; another MCP server [moved from jq to JMESPath](https://github.com/equinix-labs/equinix-docs-mcp-server/pull/43) for that reason. The community fork `@jmespath-community/jmespath` is maintained, compares like the patched original and has timeouts, but is MPL-2.0; the original stays within the licenses this package already ships (Apache-2.0, listed in `THIRD_PARTY_NOTICES.txt`).

## How other MCP servers do it

| Server                                                                                        | Argument                         | Where it runs                  | Field discovery            | Unknown field                           |
| --------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------ | -------------------------- | --------------------------------------- |
| [Zscaler](https://zscaler-mcp-server.readthedocs.io/en/latest/guides/jmespath-filtering.html) | `query` (JMESPath) on every list | after one API response         | docs                       | silent                                  |
| [WorldMonitor](https://www.worldmonitor.app/docs/mcp-jmespath)                                | `jmespath` on every tool         | before serialization           | `describe_tool`, `summary` | reported when the field appears nowhere |
| [Equinix docs](https://github.com/equinix-labs/equinix-docs-mcp-server/pull/43)               | `query` on one wrapper tool      | after the full response        | output schemas             | tool error                              |
| [Superset](https://preset.io/blog/superset-mcp-service-deep-dive/)                            | `filters`, `select_columns`      | server, with a 25k-token guard | `get_schema`               | structured error                        |
| [Atlassian](https://github.com/atlassian/atlassian-mcp-server/issues/17)                      | `fields`                         | server                         | none                       | `fields` was silently ignored (the bug) |

None of them scans across API pages or checks fields against a schema. This server does both because the lists that need filtering most are paged by the API, and a silent empty result is the failure the others ran into.

## Limits

| Limit                         | Value                                                                   | Where                         |
| ----------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| `JMESPATH_MAX_LENGTH`         | 500 characters                                                          | `src/specgen/list-query.ts`   |
| `MAX_SCAN_PAGES`              | 5 API pages (500 rows) per call                                         | `src/specgen/pagination.ts`   |
| Sort on a list the API pages  | up to 500 rows                                                          | `src/specgen/pagination.ts`   |
| A page                        | 24,000 bytes, measured on the output rows (`docs/pagination.md`)        | `src/specgen/pagination.ts`   |
| An output row                 | at most the size of its input row                                       | `src/specgen/list-query.ts`   |
| Tokens added to every session | 1,073 in tool definitions (29 per list), 178 in the server instructions | `tests/specgen-gates.test.ts` |

## What we did not build

- **Filters and a sort parameter in the Runpod API** (follow-ups A1, A2): with them, a filtered list comes back small from the source and sorting works at any length.
- **`jmespath` on the GraphQL lists**: needs hand-written row schemas for `list-hub-repos`, `list-public-endpoints` and `get-capacity`.
- **`jmespath` on single objects** (`get-pod` and the like): a different shape (one object, no rows); build it if agents ask.
- **A timeout**: the original engine has none; the community fork has one, after a license review.
- **Grouping, distinct values, counts by field** (`group_by`, `unique`): neither exists in `jmespath` 0.16.0 (not just unallowed — absent from the library), and reaching them needs a pipe, which is disallowed because it is the other way (besides a list of values) to multiply output unboundedly. Grouping also cannot be row-independent, so it could never go through the per-row scan that makes filtering correct across API pages. Other MCP servers that need this (SearchUnify's `get-filter-options`, GovTribe's `per_page: 0` rollup) solve it with a separate, purpose-built tool or argument, computed server-side where the rows already are, not by extending the query language. The same shape would work here, bounded the same way `sort_by` is: lists held whole, or an API-paged list after a full ≤500-row scan.
