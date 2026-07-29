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

Windows now probes the npm global `claude.cmd` shim (via `APPDATA`) plus
`~/.claude/local/claude.{exe,cmd}`, and falls back to `where.exe claude` — `where.exe`
rather than bare `where`, which PowerShell aliases to `Where-Object`. Multi-line
`where.exe` output prefers the `.cmd` shim, because `execFileSync` cannot spawn the
extensionless file.

Registering the server on Windows also has to go through `cmd.exe` for the same reason a
`.cmd` cannot be executed directly. Arguments still travel as an array rather than a
concatenated string, so they are quoted individually — but `%` and `^` survive quoting,
and the API key travels in argv, so a key containing either is now refused with a message
pointing at the manual `claude mcp add` command instead of being silently mangled into the
user's config. POSIX behavior is unchanged.

Preserve GPU SKU exclusions across `update-endpoint` (#63).

The v2 REST endpoint model cannot represent a SKU exclusion: `EndpointGpuConfig` is
`{pools, count}`, with nowhere to keep the `-<GPU type id>` entries that pin an individual
card. That value exists only in the GraphQL `gpuIds` string, so a v2 `PATCH` could drop
exclusions even when the update never mentioned GPUs — silently, since nothing in the REST
reply reveals it.

`update-endpoint` now reads the authoritative `gpuIds` before patching and re-asserts it
afterwards when it carries exclusions, reporting the preserved value under
`_gpuIdsPreserved`. Endpoints without exclusions (the common case) are untouched and pay
no extra write. An explicit `gpuPoolIds` still wins — the caller is deliberately rewriting
the pool list — but the reply now names the exclusions that were lost. If the restore
itself fails, the reply says so and quotes the expected `gpuIds` rather than reporting a
clean success.

`get-endpoint` gains `includeGpuIds`, which adds the real `gpuIds` string and a
`gpuIdsHasExclusions` flag, so an endpoint's true GPU selection can finally be read back.
Previously there was no way to verify it through the MCP tools at all.

Note this costs one GraphQL read per v2 `update-endpoint` call, since the prior value has
to be known before the write that might drop it.
