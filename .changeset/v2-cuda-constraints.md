---
'@runpod/mcp-server': minor
---

Expose the REST v2 CUDA host constraints (`gpu.allowedCudaVersions`,
`gpu.minCudaVersion`) on the pod and endpoint write tools, plus the
`minCudaVersion` availability filter on list-gpu-types. On the spec-generated
surface these come straight from the vendored spec, so no hand-written mapping
is involved. `update-endpoint` now warns in its own description that sending
`gpu.pools` replaces the GPU selection wholesale and clears any
`gpu.excludedTypes` set elsewhere.
