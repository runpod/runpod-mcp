---
'@runpod/mcp-server': minor
---

Add an `sshPublicKey` parameter to `create-pod` for full SSH access (#73), and fix v2 GPU pod creation failing without an explicit `gpuCount`.

The REST API has no SSH switch yet (the console and runpodctl set it via GraphQL `startSsh`), so Pods created through the MCP got a valid-looking port-22 mapping but no authorized key — direct SSH, SCP, SFTP, and rsync all failed. Passing `sshPublicKey` now merges the key into the `PUBLIC_KEY` environment variable and ensures `22/tcp` is exposed, which any image honoring the `PUBLIC_KEY` convention (all runpod/* official images) turns into a running sshd with the key installed. Template deploys extend the template's ports and env rather than replacing them, an existing `PUBLIC_KEY` is appended to rather than overwritten, and a value that looks like a private key is rejected before it can reach the Pod's environment.

Separately, the v2 pod-create mapper omitted `gpu.count` when the caller passed no `gpuCount`, trusting the spec's documented server-side default of 1. In practice the scheduler matches zero machines without it and every create fails with a misleading "no instances available" error (verified live against both v2 hosts). The mapper now always emits `count`, defaulting to 1.
