# Eval suite

Does a format or wording change (compact vs pretty JSON, an instruction edit, a cursor scheme) cost accuracy, and does a real agent still work against this server at all? `evals/` answers both, on demand — it is not part of CI (see "Why this isn't automated" below).

## The three checks

| Check | Answers | Model | Config |
| --- | --- | --- | --- |
| Reading | Given the same real tool result, does the model answer correctly in both formats? | GLM-5.3 | `evals/promptfooconfig.yaml` |
| Decisions | Does the model pick the right filter, follow a cursor, answer from `total`, recover from a damaged cursor? | GLM-5.3 | `evals/promptfooconfig.decisions.yaml` |
| Agent smoke | Does a real agent, through the real `claude` CLI, use this server at all? | Claude (any; `haiku` by default) | `evals/smoke-agent.ts` |

Reading and decisions are [promptfoo](https://www.promptfoo.dev/) evals: each test case is a frozen conversation (system, user, the assistant's tool call, and the real tool result exactly as the server sent it) with two variants — compact and pretty — selected by `evals/prompt.cjs`. A case that grades a final answer is two-layer: a deterministic `javascript` assert and an `llm-rubric` judge; both must pass. Most decision cases grade which tool call was made instead — a tool call is unambiguous, nothing for a rubric to judge — so those use the `javascript` assert alone.

Agent smoke is not a promptfoo eval. It spawns the `claude` CLI against the built server (`dist/stdio.mjs`) on a live account and checks the agent called the right tool, hit no tool error, and produced a real answer — a contract check, not a content grade.

## Running it

```bash
pnpm build

# GLM-5.3, needs RUNPOD_API_KEY — ~$0.02 a run from scratch, free when cached
pnpm dlx promptfoo@latest eval -c evals/promptfooconfig.yaml --repeat 10 -o evals/out/catalog-reading-result.json
pnpm dlx promptfoo@latest eval -c evals/promptfooconfig.decisions.yaml --repeat 10 -o evals/out/catalog-decisions-result.json

# needs RUNPOD_API_KEY and an authenticated `claude` CLI (bills to that account, not RUNPOD_API_KEY)
pnpm smoke:agent [model]   # haiku by default
```

`evals/out/` is gitignored: it holds run results (`evals/out/*.json`) and `smoke-agent`'s scratch files, never the suite itself. Nothing with live numbers in it is committed — see "Results are not committed" below.

Add `--filter-pattern <regex>` to promptfoo to run one test case while iterating; see `pnpm dlx promptfoo@latest eval --help` for the rest.

## Reliability: this is not a deterministic test suite

GLM-5.3 is called at `temperature: 0` already. That is necessary, not sufficient: the endpoint is served via vLLM with tensor and expert parallelism, and batched inference is not bit-reproducible under concurrent load even at temperature 0 (floating-point reduction order depends on what else is in the batch). Confirmed directly: 20 concurrent, byte-identical requests with a fixed `seed` still returned several distinct outputs. A `--repeat 10` run's exact pass count will differ a little on a rerun — that is expected, not a regression. What should stay stable across reruns:

- Every easy task at 10/10 in both formats, every time.
- The same one or two genuinely hard tasks (no server-side filter to fall back on) showing the only variance, roughly equally in both formats.

If a rerun shows a *different* task newly failing, or one format losing by a wide, repeatable margin, that is worth investigating. A single run moving by one or two passes out of several hundred is not.

## Results are not committed

`evals/out/` is gitignored on purpose. A results file is a timestamped sample of a live model's behavior, not a fixed fact about a commit — the same code can and does produce slightly different counts on a rerun (see above). Committing one would go stale immediately and make a reviewer compare their own fresh run against a number that was never meant to be exact. Cite results in a PR description as a dated snapshot with the command to reproduce it, not as a committed artifact.

## Extending the suite

**A new reading or decisions test case**: capture the real conversation (system/user/assistant tool_call/tool result) in both compact and pretty, add it to `evals/tests/catalog-reading.json` or `catalog-decisions.json` (copy an existing case's shape — a `javascript` + `llm-rubric` assert pair if it grades a final answer, `javascript` alone if it grades which tool call was made), and add any new tool it calls to `evals/tools/catalog-tools.json`.

**Before scripting a "no filter" or "hand-count" scenario**, check whether a filter actually exists for that field and whether real agents use it. An earlier version of this suite scripted two such tasks for fields that *do* have a matching filter; checked against real multi-model tool-call traces, agents used the filter 94–97% of the time on their own, so the scripted scenario didn't predict anything about real use and was dropped. If there's truly no filter (confirm against the tool's schema), the task is realistic as-is.

**A new agent-smoke task**: add to the `tasks` array in `evals/smoke-agent.ts` — a prompt, and the specific tool name the agent must call to answer it correctly.

**Account-task evals** (a fake account's Pods, billing, endpoints) and **write/restraint evals** don't exist yet — build and verify them in the PR that needs them.

## Why this isn't automated

CI (`.github/workflows/ci.yml`) never touches `RUNPOD_API_KEY` or `evals/`. The reading and decisions evals need a real GLM-5.3 Public Endpoint call; `smoke:agent` additionally needs an authenticated `claude` CLI session — neither is available in CI. All three stay manual, run-before-merge checks: run them when a change could plausibly affect model-read accuracy (serialization format, connect-instruction wording, a tool's filter/schema), not on every PR.
