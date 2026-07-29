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
`claude.cmd` shim, then falls back to `where.exe claude`. Multi-hit output is ranked
`.com`/`.exe` → `.cmd`/`.bat` → anything else, because npm's `cmd-shim` writes three files
per bin and `where.exe` lists the extensionless `#!/bin/sh` shim first — which Windows
cannot run at all. A hit in the current directory ranks below equivalent hits elsewhere,
since `where.exe` searches the working directory before PATH.

Registration now spawns through `cross-spawn` instead of `child_process` directly. Node's
docs are explicit that `.bat`/`.cmd` files "cannot be launched using
`child_process.execFile()`" and that "if the script filename contains spaces it needs to be
quoted" — an npm-global Claude Code install is exactly a `.cmd`, often under a path with a
space, so `execFileSync` could never register it. `cross-spawn` handles it: a `.com`/`.exe`
spawns directly with argv preserved, and anything else is wrapped in `cmd.exe /d /s /c`
with each argument quoted, backslash-doubled, `^`-escaped, and `windowsVerbatimArguments`
set so libuv does not re-quote on top. Hand-rolling that escaping is what went wrong on the
first attempt, which is the reason for the dependency.

One case is still refused rather than escaped: an argument containing a `cmd.exe`
metacharacter, bound for a shim. npm's generated `claude.cmd` re-expands its arguments
through `%*`, so they are parsed twice; `cross-spawn` compensates by escaping twice, but
only for shims matching `node_modules/.bin/*.cmd`, which a global shim in `%APPDATA%\npm`
does not. Runpod API keys are `rpa_` plus alphanumerics so this never fires in practice,
but when it does the wizard prints the `claude mcp add …` command instead of guessing at
escaping around a credential — with the key replaced by a placeholder, since anything
printed lands in terminal scrollback and in whatever log someone pastes it into.

`remove` no longer reports every outcome as a success. It previously called `execFileSync`
directly — which cannot spawn a `.cmd` — and reported success from its `catch` regardless.
Only one non-zero exit is a success now: `No MCP server named "runpod" in user scope`,
meaning there was nothing to remove. A removal that fails because the config is read-only
is reported as a failure, instead of printing a tick while the entry — API key included —
stays on disk.

Re-running the wizard over an existing entry no longer prints a bare success either. The
CLI does not update an existing entry, so a user re-running the wizard after rotating their
API key was told "configured" while the old key remained. The result line now says the
entry was left unchanged and how to replace it. An API key taken from the environment is
also trimmed, matching the pasted path — a trailing newline used to be written verbatim
into every client config.

CI gains a `windows-latest` runner, and the suite now runs a real `.cmd` shim out of a
directory whose name contains a space, asserting the arguments arrive intact. A Windows-only
fix with no Windows CI is how this class of bug ships.

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
