---
'@runpod/mcp-server': minor
---

Add an `sshPublicKey` parameter to `create-pod` for full SSH access (#73), and fix v2 GPU pod creation failing without an explicit `gpuCount`.

The REST API has no SSH switch yet (the console and runpodctl set it via GraphQL `startSsh`), so Pods created through the MCP got a valid-looking port-22 mapping but no authorized key — direct SSH, SCP, SFTP, and rsync all failed. Passing `sshPublicKey` now merges the key into the `PUBLIC_KEY` environment variable and ensures `22/tcp` is exposed, which any image honoring the `PUBLIC_KEY` convention (all runpod/\* official images) turns into a running sshd with the key installed. Template deploys extend the template's ports and env rather than replacing them, and an existing `PUBLIC_KEY` is appended to rather than overwritten.

The key is validated before the Pod is created, because an unusable value would otherwise produce a Pod that looks SSH-ready and is not: `22/tcp` exposed, junk in `PUBLIC_KEY`, and a reply reporting SSH as configured. Rejected with a 400: a private key in any format (PEM in any case, or a PuTTY `.ppk`, which contains neither the words "private key" nor a public key line), a file path or SHA256 fingerprint passed instead of the `.pub` file's contents, a bare base64 blob with no key type, and an empty or whitespace-only value (omit the parameter to create a Pod without SSH). Accepted keys are normalized to one key per line with CRLF stripped, since a stray carriage return corrupts the `authorized_keys` entry it lands on. Error messages never echo the rejected value, which may itself be secret.

`create-pod` also now rejects a `gpuCount` below 1 or with a fractional part, which the v2 API answers with an opaque 422.

Separately, the v2 pod-create mapper omitted `gpu.count` when the caller passed no `gpuCount`, trusting the spec's documented server-side default of 1. In practice the scheduler matches zero machines without it and every create fails with a misleading "no instances available" error (verified live against both v2 hosts). The mapper now always emits `count`, defaulting to 1.
