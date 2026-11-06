---
'@runpod/mcp-server': patch
---

Treat a `null` optional argument as omitted on the hand-written tools too.
Strict-schema clients such as Codex and opencode send every property, and the
fix for generated tools did not reach the curated ones: `get-job-status` and
`runsync-endpoint` rejected `wait: null` with a 400, `set-endpoint-gpus`
rejected every null GPU field (`gpuIds`, `gpuCount`, `minCudaVersion` and the
rest) so it could not be called at all, and `run-endpoint` and
`runsync-endpoint` forwarded `webhook: null`, `policy: null` and
`s3Config: null` into the job body. A null required argument is still reported
as missing.
