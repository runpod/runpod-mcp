---
'@runpod/mcp-server': patch
---

Fix Claude Code detection and registration in the install wizard on Windows (#56).

Detection used the POSIX-only `command -v claude` plus three POSIX install paths, so
Claude Code was undetectable on a standard Windows install. Windows now probes
`%USERPROFILE%\.local\bin\claude.exe` (native installer) and `%APPDATA%\npm\claude.cmd`
(global npm), and registration resolves the real entrypoint from the installed package
manifest instead of running the `.cmd` shim through `cmd.exe`. Candidates are
canonicalized and confined to their standard install roots, a PATH result resolving into
the current project is rejected, and Claude Code is spawned with `PATH`, `COMSPEC`,
`PATHEXT`, `NODE_OPTIONS`, and `NODE_PATH` sanitized, so nothing a project directory can
plant receives your API key. Custom npm prefixes and redirected roaming profiles are
still not auto-detected; when Claude Code is not found, the wizard now prints the exact
`claude mcp` command to register or remove the entry yourself.

Claude Code add and remove are now verified against its own `.claude.json` rather than
the CLI exit code, which reports success for writes it never made. Re-running the wizard
over an existing entry now says the entry was left unchanged instead of printing a bare
success, since the CLI does not update it and a rotated API key would otherwise look
applied. An entry shadowed by a local-scope one is called out with the command to clear
it.

For the clients that own a JSON config, an edit that would leave the file unparseable —
or land in a duplicated server block the client does not read — now fails with the
original file untouched instead of reporting success, and validity is judged by the
parser each client actually ships (Claude Desktop is strict JSON, Cursor and VS Code
accept JSONC, Windsurf's tolerance is unverified and disclosed rather than assumed).
Claude Desktop on Linux and VS Code now honour `XDG_CONFIG_HOME` instead of writing
where those clients never read, an empty or relative `APPDATA`/`XDG_CONFIG_HOME` no
longer resolves a config path against the current directory, configs this wizard creates
are `0600` because they hold a plaintext API key, and a key taken from the environment is
trimmed.
