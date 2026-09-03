---
'@runpod/mcp-server': minor
---

Add a `networkVolumeId` parameter to `create-pod` for attaching an existing Network Volume at `volumeMountPath`. On the v2 REST API this maps to `mounts.network: [{ volumeId, path }]`.

Network Volume requests are rejected before any API call when the mount path is missing or when `volumeInGb` also requests a new persistent volume. When deploying from a template, an explicit Network Volume replaces the template's inherited persistent mount.
