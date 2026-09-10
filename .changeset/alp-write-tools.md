---
'@runpod/mcp-server': minor
---

Agent Learning Protocol P0 (write-only): three config-gated tools — report_feedback, save_to_journal, ask_question — that submit to one hosted ingest endpoint (POST /api/alp/submit) on both transports, keyed on the resolved Runpod identity. Secrets are scrubbed on write; every response is honest that nothing is served back yet (ask_question explicitly never answers), and all failures are calm non-errors that suppress retries. Hosted-only: the tools appear only on deployments that configure the storage sink (ALP_SINK_URL + ALP_SINK_SECRET) and never on local stdio.
