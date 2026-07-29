---
'@runpod/mcp-server': patch
---

Fix Claude Code detection on Windows in the install wizard (#56).

`findClaudeBinary()` fell back to `execSync('command -v claude')`. `command -v` is a
POSIX shell builtin and `execSync` on Windows runs through `cmd.exe`, which has no such
builtin — so the lookup exited non-zero whether or not Claude Code was installed. The
three hardcoded candidate paths it checked first (`~/.claude/local/claude`,
`/usr/local/bin/claude`, `/opt/homebrew/bin/claude`) are POSIX-only and can never resolve
on Windows either, so Claude Code was undetectable on a standard Windows install.

Windows now probes `%USERPROFILE%\.local\bin\claude.exe` (the documented native-installer
location, which also covers installs whose PATH entry is missing) and the npm global
`claude.cmd` shim, then falls back to `where.exe claude`. Multi-hit output prefers a
directly-spawnable executable over the `.cmd`.

Registration is NOT routed through `cmd.exe`. A `.cmd` cannot be spawned without a shell,
and the API key travels in argv — Node only quotes arguments containing whitespace or a
quote, so a key like `rpa_x&whoami` would reach `cmd.exe` unquoted and split into a second
command. When only a `.cmd` shim is available the wizard now prints the exact
`claude mcp add …` command for the user to run instead of shelling out with a credential.
An `.exe` or extensionless binary is spawned directly with `execFileSync`, exactly as on
POSIX.

`remove` now shares that path. It previously called `execFileSync` directly — which cannot
spawn a `.cmd` — and reported success regardless, so a failed removal printed a tick while
the entry stayed in the user's config. That path was unreachable before only because
detection always failed on Windows.

CI gains a `windows-latest` runner. A Windows-only fix with no Windows CI is how this class
of bug ships.

Preserve GPU SKU exclusions across `update-endpoint` (#63).

The v2 REST endpoint model cannot represent a SKU exclusion: `EndpointGpuConfig` is
`{pools, count}`, with nowhere to keep the `-<GPU type id>` entries that pin an individual
card. That value exists only in the GraphQL `gpuIds` string, so a v2 `PATCH` could drop
exclusions even when the update never mentioned GPUs — silently, since nothing in the REST
reply reveals it.

Confirmed live on 2026-07-29: an endpoint with `gpuIds` of
`AMPERE_16,-NVIDIA RTX A4500,-NVIDIA RTX 2000 Ada Generation`, patched with only
`{"image": "..."}`, came back as plain `AMPERE_16`. Both exclusions were gone; every other
field survived.

`update-endpoint` now reads `gpuIds` before patching, then re-reads the endpoint after the
patch and re-applies that `gpuIds` on top, reporting it under `_gpuIdsPreserved`. The
re-read matters: `saveEndpoint` is not sparse, so echoing the pre-patch snapshot would put
back whatever the caller had just changed. Endpoints without exclusions (the common case) are untouched and pay
no extra write. An explicit `gpuPoolIds` still wins — the caller is deliberately rewriting
the pool list — but the reply now names the exclusions that were lost. If the restore
itself fails, the reply says so and quotes the expected `gpuIds` rather than reporting a
clean success.

`get-endpoint` gains `includeGpuIds`, which adds the real `gpuIds` string and a
`gpuIdsHasExclusions` flag, so an endpoint's true GPU selection can finally be read back.
Previously there was no way to verify it through the MCP tools at all.

Cost: one GraphQL read per v2 `update-endpoint` call, plus a re-read and a write only for
endpoints that actually use exclusions.
