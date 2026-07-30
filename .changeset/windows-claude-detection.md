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
location) and `%APPDATA%\npm\claude.cmd` (the standard `npm install -g` shim from #56).
It deliberately does not execute `where.exe` or any other PATH lookup: Windows searches
the current directory when resolving the lookup executable itself, and npm/npx prepend
project-local `node_modules\.bin` directories to PATH. Either route could execute a
repository-supplied program before selection, or later hand it the Runpod API key.
Directly probing the two documented user-level locations fixes the standard native and
global-npm installs without extending that trust boundary.

The POSIX `command -v` fallback remains for custom/package-manager installs, but accepts
only canonical paths outside the current repository and rejects `node_modules/.bin`
results. Relative, project-local, symlinked-back-into-project, or uncanonicalizable hits
are treated as not detected rather than being executed with a credential.

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
  user-scope _and_ a local-scope entry both on disk it prints only
  `Scope: Local config` — so one scope string cannot distinguish "user entry present,
  shadowed" from "user entry absent", and those need opposite verdicts.

`--scope user` writes exactly one place: the top-level `mcpServers` of `.claude.json`.
So the wizard reads that file. It is exact, needs no extra process, cannot be shadowed,
and it can enumerate local-scope entries across _every_ project directory rather than
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

Environment-provided directories are handled by variable, not by one blanket rule, because
the right answer differs. `XDG_CONFIG_HOME` and `APPDATA` name paths this wizard invents,
so an empty or relative value is refused outright — `??` did not catch an empty string and
nothing rejected a relative one. The consequences were not cosmetic: an empty
`APPDATA` yielded the relative candidate `npm\claude.cmd`, which is probed before the
Windows lookup decision and resolved against the current directory, so a file planted
there would have been spawned with the live API key; and a relative config directory meant a
plaintext key written into a `Claude/` folder wherever the wizard was launched, reported
as configured. `CLAUDE_CONFIG_DIR` is different: it names a file the Claude Code CLI owns, and that CLI
resolves a relative value against its own cwd (verified — `CLAUDE_CONFIG_DIR=relcfg claude
mcp add … --scope user` writes `relcfg/.claude.json`). Treating it as unset would point
this code at `$HOME/.claude.json`, a file the CLI never touched, and then report a definite
verdict about it — so it is resolved the same way the CLI resolves it. As a backstop,
writing or deleting through a non-absolute config path is refused outright, whatever
computed it. `vsCodeConfigPath` also honours
`XDG_CONFIG_HOME` now — it hardcoded `~/.config`, so an XDG user was told VS Code was
configured for a file VS Code does not read.

Two smaller leaks in the same area: a client config created by this wizard is written `0600`
rather than `0644`, since it holds a plaintext API key (a freshly created Claude Code config is `0600`);
and any message built from the CLI's output has the key stripped by value, not just by argv
shape — that CLI does echo `-e` tokens back on some errors. A config the owning client cannot parse is
also no longer reported as configured, and validity is now decided by the parser that
client actually uses, read out of each client's shipped code rather than inferred from
"it's an Electron app". Claude Desktop is strict — a bare `JSON.parse(readFileSync(...))`
with no preprocessing and no retry — so validating its config leniently meant reporting
success for a file it silently never loads, the same defect a leading BOM had and far more
reachable, since a commented-out server in a hand-edited config is routine. Cursor is
**not** strict, despite also being an Electron app: it is a VS Code fork and its MCP reader
keeps VS Code's tolerance, stripping comments and retrying without trailing commas, so it
is treated as JSONC like VS Code. Windsurf's parser could not be read, so it is marked
unverified: the entry is written, and if the config relies on that leniency the success
message says the tolerance is unconfirmed rather than asserting it. Guessing is not
free in either direction — too strict refuses a healthy config and leaves the client
unconfigured, too lenient reports success for a file that never loads — so the dialect is
required per client with no default, and asserted per client in the tests.

Two further ways an edit could be valid yet ineffective are now caught. Duplicate keys are
legal JSON, and `jsonc.modify` edits the first occurrence while every client keeps the last,
so the entry could land in a block nothing reads — a plaintext key on disk, reported as
configured; both the add and the remove path now confirm the result with the client's own
parser instead of trusting that an edit applied. And removing the sole entry of a
`servers` block followed by a trailing comma left `{ , }` behind, turning a clean config
into one with a parse error while printing a tick; that now falls back to a structural
rewrite, which is disclosed because it costs the file's comments. The message also
distinguishes "this change would break it" from "it was already broken", because the advice
differs.

The POSIX PATH lookup now accepts only a canonical path outside the current repository and
never returns a relative or `node_modules/.bin` result. Whatever it returns is spawned with
the live API key, and with `.` on `PATH` `command -v claude` prints `./claude` under dash —
which is `/bin/sh` on Linux, the shell this uses — so the key could otherwise go to whatever
file sat in the working directory. A global-looking symlink back into the repository is
rejected after canonicalization too.

An `add` that lands in user scope while a **local**-scope entry exists now says so. Local
scope takes precedence, so in those directories the new entry is inert and Claude Code keeps
using the old key — the exact rotation failure the "already exists" caveat was added to
prevent, which that caveat cannot catch because `mcp add --scope user` exits 0 when the
collision is in another scope.

CI gains a `windows-latest` runner, and the suite now runs a real `.cmd` shim out of a
directory whose name contains a space, asserting the arguments arrive intact. A Windows-only
fix with no Windows CI is how this class of bug ships.
