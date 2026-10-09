---
'@runpod/mcp-server': minor
---

Tighten what the server tells a connecting agent. The instructions now say
that for work done with these tools the journey playbook is the procedure,
whether it comes from the plugin's `runpod-mcp` skill or from
`read-guide`; the plugin's other skills stay the lane for the CLIs, image
builds and golden paths. A resource the user names by id is in scope for the
change they asked for and is deleted only when they ask for the delete, and
`create-cluster` waits for the user's go on the quoted shape and total hourly
price. Jobs are submitted with `run-endpoint` and waited on with
`get-job-status`; `runsync-endpoint` is for a warm endpoint and a fast job.

The 402 hint points at `list-billing`, and the 403 hint says a permission error
on a resource the agent did not create is final.

Tool descriptions: `create-cluster` prices the whole shape (pods times GPUs per
pod) and waits for the go; `create-endpoint` describes the CPU choice next to
the GPU one; `update-endpoint` puts `idleTimeout` under `workers` and states
that `gpu.pools` and `gpu.excludedTypes` are one selection; `delete-endpoint`,
`delete-pod`, `delete-cluster` and `delete-secret` allow the one resource the
user asked to delete by id.
