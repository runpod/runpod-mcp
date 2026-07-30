---
'@runpod/mcp-server': minor
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

`add` and `remove` are now verified against the config instead of trusting the CLI's exit
code, because on Claude Code 2.1.220 that exit code does not answer the only question that
matters — is the API key on disk or not?

- With an unwritable config, `claude mcp remove` prints `Removed MCP server runpod from user
  config / File modified: …` and exits **0** having written nothing. Same for `add`.
- `claude mcp add` defaults to **local** scope while this wizard removes from **user** scope,
  so an entry a user added by hand yields `No MCP server named "runpod" in user scope` and
  exit 1 — which reads as "nothing to remove" while their key stays in `~/.claude.json`.

Neither is settled by a `claude mcp get` probe, and two further observations are why:

- **`mcp get` is cwd-pinned.** Local scope lives at `~/.claude.json →
  projects[<cwd>].mcpServers` and project scope in `<cwd>/.mcp.json`, so an entry added
  in a different directory is invisible from here (verified: added in `projA`, `mcp get`
  from `projB` exits 1 while the key is still in `~/.claude.json`).
- **`mcp get` reports only the WINNING scope, and local shadows user.** With a
  user-scope *and* a local-scope entry both on disk it prints only
  `Scope: Local config` — so one scope string cannot distinguish "user entry present,
  shadowed" from "user entry absent", and those need opposite verdicts.

`--scope user` writes exactly one place: the top-level `mcpServers` of `.claude.json`.
So the wizard reads that file. It is exact, needs no extra process, cannot be shadowed,
and it can enumerate local-scope entries across *every* project directory rather than
only the current one. A removal that leaves the user-scope entry in place is a failure
naming the file and the likely cause; one that succeeds while local-scope entries remain
elsewhere is a success that names those directories and the command to clear them; and a
config that cannot be read or parsed is reported as unverified rather than assumed
either way.

(`remove` also previously called `execFileSync` directly — which cannot spawn a `.cmd` — and
reported success from its `catch` regardless.)

Re-running the wizard over an existing entry no longer prints a bare success either. The
CLI does not update an existing entry, so a user re-running the wizard after rotating their
API key was told "configured" while the old key remained. The result line now says the entry
was left unchanged and gives the full-path command to replace it. An API key taken from the
environment is also trimmed, matching the pasted path — a trailing newline used to be
written verbatim into every client config.

Two smaller leaks in the same area: a client config created by this wizard is written `0600`
rather than `0644`, since it holds a plaintext API key (Claude Code's own config is `0600`);
and any message built from the CLI's output has the key stripped by value, not just by argv
shape — that CLI does echo `-e` tokens back on some errors. A malformed existing config is
also no longer reported as configured: jsonc will best-effort insert an entry into a file
with an unbalanced brace and hand back something still unparseable, which the client then
silently never loads.

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
back whatever the caller had just changed. Endpoints without exclusions (the common case)
are untouched and pay no extra write, and the restore is skipped entirely when the patch
left `gpuIds` alone — so the compensation disappears on its own once the v2 facade stops
rebuilding `gpuIds` from `gpu.pools`. An explicit `gpuPoolIds` still wins — the caller is
deliberately rewriting the pool list — but the reply now names the exclusions that were
lost. If the restore itself fails, the reply says so and quotes the expected `gpuIds`
rather than reporting a clean success.

If the `gpuIds` read fails, the update still applies — a GPU safety net must not block an
unrelated change — but the reply now carries `_gpuIdsCheckSkipped` saying so. Silence there
was indistinguishable from "this endpoint has no exclusions to lose", which is issue #63
recurring behind a claim that it is fixed. It is reachable with a credential that can PATCH
over REST but cannot read the endpoint through GraphQL `myself`.

The restore echoes only the fields `saveEndpoint` writes unconditionally. Fields it writes
solely when the input carries them are deliberately omitted, because echoing a read value
back does damage: `modelReferences` reads as `[]` when empty, and `[]` means *clear all
model references*, which strips `MODEL_NAME` from the endpoint's env and rolls its workers;
a non-empty value re-validates every reference without a HuggingFace token, so a gated model
fails the write outright. `compliance` reads as `[]` and is re-sorted server-side;
`templateId` is read only on the create path, so echoing it on an update is at best a
no-op; `networkVolumeIds` creates volume rows on a legacy single-volume endpoint; and
`type` is both written and validated only when present, so echoing a future `AiApiType`
the validator rejects (`RT` is already in the enum) would fail every restore for no
benefit. `requestTTL` is now read and echoed, because it *is* written unconditionally and
is compared for the version bump — omitting it registered as a change and rolled the
workers for nothing.

`get-endpoint` gains `includeGpuIds`, which adds the real `gpuIds` string and a
`gpuIdsHasExclusions` flag, so an endpoint's true GPU selection can be read back. Before
this, the only way to see it was `set-endpoint-gpus`, which reports `gpuIds` in its reply —
i.e. you had to write to read.

Cost, stated fully:

- One GraphQL read per v2 `update-endpoint` call — including endpoints with no exclusions,
  which pay the read but no write.
- A second GraphQL read for every endpoint that carries exclusions — it happens before
  the "did anything change?" check, so it is paid whether or not anything was lost.
- One `saveEndpoint` write only for endpoints that carry exclusions AND actually lost
  them to the patch.
- The caller's API key now goes to the authenticated GraphQL host on every v2
  `update-endpoint`. If you override `RUNPOD_AUTHED_GRAPHQL_URL`, point it only at a host
  you trust with that.
- `saveEndpoint` writes `workersStandby := workersMax` unconditionally, and `workersStandby`
  is not a field of `EndpointInput` — so the restore cannot preserve a value that differs
  from `workersMax`. The echo-everything-written rule cannot cover this one.
- The restore re-validates the stored config against today's rules (account worker limits,
  the GPU pool catalogue, pool access). An endpoint whose stored config has since drifted out
  of validity fails the restore and reports `_warning` — honest, but it then sits without its
  exclusions until `set-endpoint-gpus` is run.

Separately, `update-endpoint` now rejects a `gpuCount` sent without `gpuPoolIds` on v2. The
v2 `gpu` object requires `pools`, so the mapper dropped `gpu` entirely and the PATCH said
nothing about GPUs: HTTP 200, count unchanged, no indication anything was ignored. Send both,
or use `set-endpoint-gpus` to change the count alone. `set-endpoint-gpus` also keeps its
actionable "use list-endpoints" error for an unknown id, which now arrives as a rejection
rather than a null because `endpoint(id:)` throws for an id it cannot see.
