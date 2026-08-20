---
'@runpod/mcp-server': minor
---

Expose the REST v2 CUDA host constraints on create-pod, create-endpoint, and update-endpoint (`allowedCudaVersions`, `minCudaVersion`, nested under `gpu.*` on the wire per rphttp2 2.9.0), support CUDA-only endpoint patches without resending `gpuPoolIds`, warn when a `gpuPoolIds` update clears GPU-type exclusions set elsewhere, and add the `minCudaVersion` availability filter to list-gpu-types. Requires a server running rphttp2 2.9.0 or later for the new fields.
