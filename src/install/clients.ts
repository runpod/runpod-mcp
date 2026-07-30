import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import crossSpawn from 'cross-spawn';
import * as jsonc from 'jsonc-parser';

// The npm package and the name the server is registered under in client config.
export const SERVER_NAME = 'runpod';
export const NPM_PACKAGE = '@runpod/mcp-server@latest';

// The hosted Streamable HTTP endpoint. Clients point here and authenticate with
// the OAuth "Sign in with Runpod" flow — no API key is stored in their config.
// Overridable so a non-production deployment can be targeted during testing.
export const HOSTED_URL =
  process.env.RUNPOD_MCP_URL ?? 'https://mcp.getrunpod.io/';

// How the user wants the server wired up:
// - local: run via npx on this machine, authenticated by an API key in the env.
// - hosted: connect to the hosted HTTP server and sign in with Runpod (OAuth).
export type AddMode =
  | { kind: 'local'; apiKey: string }
  | { kind: 'hosted'; url: string };

export interface AddResult {
  success: boolean;
  message?: string;
}

export interface McpClient {
  // Stable id used as the multiselect value.
  id: string;
  // Human-readable label shown in the picker.
  name: string;
  // True when the client appears to be installed on this machine.
  detect(): Promise<boolean>;
  // Write (or update) the Runpod server entry in the client's config.
  add(mode: AddMode): Promise<AddResult>;
  // Remove the Runpod server entry from the client's config.
  remove(): Promise<AddResult>;
  // Where the config lives, for display and manual fallback.
  describeTarget(): string;
}

// The local stdio config: Runpod's MCP server runs via npx and reads the API
// key from the environment. VS Code's `servers` map requires an explicit
// transport type for stdio servers (mcpServers-style clients infer it).
function localServerConfig(apiKey: string, serverProperty: string) {
  const config = {
    command: 'npx',
    args: ['-y', NPM_PACKAGE],
    env: { RUNPOD_API_KEY: apiKey },
  };
  return serverProperty === 'servers' ? { type: 'stdio', ...config } : config;
}

// The hosted config. Clients with native remote-MCP support take the URL
// directly (VS Code additionally needs `type: 'http'`); the rest reach the
// hosted server through the `mcp-remote` stdio bridge, which also drives OAuth.
function hostedServerConfig(
  strategy: 'http' | 'mcp-remote',
  serverProperty: string,
  url: string
) {
  if (strategy === 'mcp-remote') {
    return { command: 'npx', args: ['-y', 'mcp-remote', url] };
  }
  return serverProperty === 'servers' ? { type: 'http', url } : { url };
}

// Read, edit, and write a JSON config while preserving the user's existing
// formatting and comments (jsonc). Creates the file and parent dirs if missing.
// Exported for tests: the client wrappers hardcode real config paths under $HOME, and
// a test must never write there.
export function upsertJsonServer(
  configPath: string,
  serverProperty: string,
  value: unknown
): AddResult {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const content = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf8')
      : '';
    const edits = jsonc.modify(content, [serverProperty, SERVER_NAME], value, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    // Strip a leading BOM from what gets WRITTEN, not just from the validity check.
    // `JSON.parse` throws `Unexpected token '\uFEFF'` on one, and Cursor / Windsurf /
    // Claude Desktop are Node/Electron apps doing exactly that — so keeping the BOM
    // would report success for a config the client silently never loads, which is the
    // one thing this guard exists to prevent. Only VS Code (jsonc) tolerates it.
    const updated = jsonc.applyEdits(content, edits).replace(/^\uFEFF/, '');
    // jsonc edits a malformed file on a best-effort basis: it will happily insert the
    // entry into a config with an unbalanced brace and hand back something still
    // unparseable, which the client then silently never loads. Refuse instead of
    // reporting success over a file we just confirmed is broken.
    const parseErrors: jsonc.ParseError[] = [];
    // PowerShell's Set-Content and Notepad both write BOMs by default, on the platform
    // this wizard targets, so refusing a BOM outright would be a new hard failure. It is
    // removed above instead of tolerated, so the file this writes parses under both
    // JSON.parse and jsonc. Double or trailing BOMs still fail this check, correctly.
    jsonc.parse(updated, parseErrors, { allowTrailingComma: true });
    if (parseErrors.length > 0) {
      return {
        success: false,
        message: `${configPath} is not valid JSON, so it was left untouched — the entry would not have loaded. Fix the file (or move it aside) and re-run.`,
      };
    }
    // mode is honoured only when the file is created; an existing config keeps its
    // own. 0600 because this file holds a plaintext API key, and a freshly created
    // Claude Code config is 0600 — a config this wizard creates should not be looser.
    // No effect on Windows, which has no POSIX mode bits (only the read-only flag is
    // real); there the ACL on the user profile directory is what governs access.
    fs.writeFileSync(configPath, updated, { encoding: 'utf8', mode: 0o600 });
    return { success: true };
  } catch (error) {
    return { success: false, message: errMessage(error) };
  }
}

function removeJsonServer(
  configPath: string,
  serverProperty: string
): AddResult {
  try {
    if (!fs.existsSync(configPath)) {
      return { success: true, message: 'nothing to remove' };
    }
    const content = fs.readFileSync(configPath, 'utf8');
    let edits;
    try {
      edits = jsonc.modify(content, [serverProperty, SERVER_NAME], undefined, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      });
    } catch (error) {
      // jsonc throws `Can not delete in empty document` whenever the FIRST path segment
      // is absent — `{}`, an empty file, whitespace, an array root, and also a
      // populated object with no `mcpServers` key. Its message is a misnomer; in every
      // such case there is genuinely no runpod entry to remove. Reporting those as failures is the same class of bug as
      // reporting a failure as a success, just pointed the other way: the user is told
      // cleanup broke when the desired end state already held.
      if (/empty document/i.test(errMessage(error))) {
        return { success: true, message: 'nothing to remove' };
      }
      throw error;
    }
    if (edits.length === 0) {
      return { success: true, message: 'nothing to remove' };
    }
    fs.writeFileSync(configPath, jsonc.applyEdits(content, edits), 'utf8');
    return { success: true };
  } catch (error) {
    return { success: false, message: errMessage(error) };
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// A JSON-config client that differs only in config path, server property, and
// how it reaches the hosted server.
function jsonClient(opts: {
  id: string;
  name: string;
  serverProperty?: string;
  // Native HTTP support, or the `mcp-remote` bridge for stdio-only clients.
  hostedStrategy?: 'http' | 'mcp-remote';
  configPath: () => string;
  detectPaths?: () => string[];
}): McpClient {
  const serverProperty = opts.serverProperty ?? 'mcpServers';
  const hostedStrategy = opts.hostedStrategy ?? 'http';
  return {
    id: opts.id,
    name: opts.name,
    detect: () =>
      Promise.resolve(
        (opts.detectPaths?.() ?? [path.dirname(opts.configPath())]).some(exists)
      ),
    add: (mode) => {
      const value =
        mode.kind === 'local'
          ? localServerConfig(mode.apiKey, serverProperty)
          : hostedServerConfig(hostedStrategy, serverProperty, mode.url);
      return Promise.resolve(
        upsertJsonServer(opts.configPath(), serverProperty, value)
      );
    },
    remove: () =>
      Promise.resolve(removeJsonServer(opts.configPath(), serverProperty)),
    describeTarget: () => opts.configPath(),
  };
}

// Locate the Claude Code CLI binary across common install locations and PATH.
// Claude Code is the only client here detected by locating its executable rather
// than by an existing config file, so it is the only one that needs a PATH lookup
// — and the lookup has to be per-platform. `command -v` is a POSIX shell builtin;
// execSync on Windows runs through cmd.exe, which has no such builtin, so it
// exits non-zero whether or not claude is installed. Windows uses `where.exe`
// (not bare `where`, which PowerShell aliases to Where-Object).
// Exported for tests: the platform decisions are pure, so both branches can be
// exercised on any host without spawning anything or faking process.platform.

/**
 * Install locations to probe before falling back to a PATH lookup. Windows uses
 * win32 path semantics regardless of the host so the branch is testable anywhere.
 *
 * `.local\bin\claude.exe` is the documented native-installer location and comes
 * first deliberately: it is a real executable, so cross-spawn launches it with no
 * shell at all. It also covers installs where the native installer failed to add
 * itself to PATH, which the lookup below could never find.
 */
export function claudeCandidatePaths(
  platform: string,
  homedir: string,
  appdata?: string
): string[] {
  if (platform === 'win32') {
    const win = path.win32;
    return [
      win.join(homedir, '.local', 'bin', 'claude.exe'),
      // npm -g installs a .cmd shim. cross-spawn can run one, but only by going
      // through cmd.exe, so it stays last — see runClaude.
      win.join(
        appdata ?? win.join(homedir, 'AppData', 'Roaming'),
        'npm',
        'claude.cmd'
      ),
    ];
  }
  return [
    path.posix.join(homedir, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

/**
 * The PATH-lookup command. `command -v` is a POSIX shell builtin, and execSync on
 * Windows runs through cmd.exe, which has no such builtin — so on Windows it exited
 * non-zero whether or not claude was installed (issue #56). `where.exe` is cmd.exe's
 * native equivalent.
 */
export function claudeLookupCommand(platform: string): string {
  return platform === 'win32' ? 'where.exe claude' : 'command -v claude';
}

/**
 * Picks one path from a lookup's stdout. `where.exe` prints every match, and an
 * npm-global install produces three: npm's `cmd-shim` writes an extensionless
 * `#!/bin/sh` shim next to `claude.cmd` and `claude.ps1`. `where` lists the
 * exact-name match first, so the naive "first hit" is the sh shim — which Windows
 * cannot run at all (cross-spawn reads its shebang and tries to spawn `/bin/sh`).
 *
 * Hence an explicit ranking rather than a single preference:
 *   1. `.com`/`.exe`  — cross-spawn spawns these with no shell.
 *   2. `.cmd`/`.bat`  — need cmd.exe, but cmd.exe genuinely runs them.
 *   3. anything else  — extensionless, `.ps1`; may not be runnable.
 * A hit inside `cwd` is ranked below every equivalent hit elsewhere: `where.exe`
 * searches the current directory before PATH, so running the wizard from a folder
 * containing a file named `claude.cmd` would otherwise hand it the API key.
 * Returns null when nothing came back.
 */
export function pickClaudeBinary(
  stdout: string,
  platform: string,
  cwd?: string
): string | null {
  const hits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (hits.length === 0) return platform === 'win32' ? null : 'claude';
  if (platform !== 'win32') return hits[0];

  const rank = (hit: string): number => {
    const base = /\.(com|exe)$/i.test(hit)
      ? 0
      : /\.(cmd|bat)$/i.test(hit)
        ? 1
        : 2;
    // Case-insensitive: Windows paths are, and where.exe's casing need not match
    // what process.cwd() reports.
    const inCwd =
      cwd !== undefined &&
      path.win32.dirname(hit).toLowerCase() === cwd.toLowerCase();
    return inCwd ? base + 10 : base;
  };

  // Stable: equal ranks keep the lookup's own order.
  return hits.reduce((best, hit) => (rank(hit) < rank(best) ? hit : best));
}

/**
 * True when running this path means going through cmd.exe. Approximates
 * cross-spawn's rule (lib/parse.js): on Windows it spawns directly only when the
 * resolved file ends in `.com`/`.exe`, and wraps everything else in
 * `cmd.exe /d /s /c`. Always false off Windows.
 *
 * "Approximates", not "mirrors": cross-spawn tests the file it resolved via PATHEXT
 * and shebang substitution, this tests the string as given. They can disagree — an
 * extensionless path whose `.exe` sibling resolves would be spawned shell-free by
 * cross-spawn while this says otherwise. The disagreement is deliberately biased
 * toward over-reporting, since the only consequence is a refusal the guard below
 * did not strictly need; under-reporting would let an unescaped argument through.
 */
export function needsCmdShell(binary: string, platform: string): boolean {
  if (platform !== 'win32') return false;
  return !/\.(com|exe)$/i.test(binary);
}

// cmd.exe metacharacters: the set cross-spawn escapes (lib/util/escape.js) plus every
// whitespace character that can act as a separator. npm's own escaper quotes on
// /[ \t\n\v"]/ (@npmcli/promise-spawn/lib/escape.js), so tab and vertical tab belong
// here too; CR is added on the same principle. A key from a shell profile or .env can
// carry any of them, and their behaviour on a re-parsed command line is not something
// to establish with a live credential.
const CMD_META = /[()\][%!^"`<>&|;, *?\t\n\v\r]/;

/**
 * Whether it is safe to hand these args to a `.cmd` shim.
 *
 * cross-spawn escapes arguments properly for a single cmd.exe parse, but a shim
 * re-expands them: npm's generated `claude.cmd` ends in `node "…cli.js" %*`, so
 * the arguments are parsed a second time. cross-spawn compensates by escaping
 * twice, but only for shims it recognises — its check is
 * `/node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i`, which a global npm shim in
 * `%APPDATA%\npm` does not match. Rather than reimplement its escaping, refuse the
 * narrow case: an argument carrying a metacharacter, bound for a shim. Runpod API
 * keys are `rpa_` + alphanumerics, so in practice this never triggers.
 *
 * Broader than strictly necessary: tracing a single-escaped argument through both
 * parses, the quotes survive and only `"` actually breaks quote state. The rest of
 * the set is refused anyway rather than relying on that reasoning — getting exactly
 * this analysis wrong is what shipped a quoting bug on the first attempt. The known
 * cost is a false refusal for a `RUNPOD_MCP_URL` override carrying a query string.
 */
export function argsSafeForCmdShell(args: string[]): boolean {
  return !args.some((arg) => CMD_META.test(arg));
}

function findClaudeBinary(): string | null {
  const platform = process.platform;

  for (const candidate of claudeCandidatePaths(
    platform,
    os.homedir(),
    process.env.APPDATA
  )) {
    if (exists(candidate)) return candidate;
  }

  try {
    // Resolve to a real path rather than returning the bare name, so the choice
    // among the several files an npm install leaves behind is made here (see
    // pickClaudeBinary) instead of by PATHEXT order inside cmd.exe.
    const out = execSync(claudeLookupCommand(platform), {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return pickClaudeBinary(out, platform, process.cwd());
  } catch {
    return null;
  }
}

/**
 * Renders a command for a human to copy, quoting only what needs it. Display only:
 * this string is never executed. Plain double-quote wrapping, NOT JSON.stringify —
 * the latter escapes the backslashes in a Windows path, which is exactly wrong for
 * something the user will paste.
 */
export function describeCommand(binary: string, args: string[]): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [binary, ...args].map(quote).join(' ');
}

// Placeholder substituted for the key when a command is printed for the user.
// No cmd.exe metacharacters: this string is printed for a user to paste into
// cmd.exe, and `<`/`>` would be parsed as redirection — turning the wizard's own
// remediation command into an error. It satisfies argsSafeForCmdShell by design.
export const KEY_PLACEHOLDER = 'YOUR_RUNPOD_API_KEY';

/**
 * Same as describeCommand, with the API key replaced by a placeholder. Anything
 * printed to the terminal ends up in scrollback, and in a support thread or CI log
 * the moment someone pastes wizard output — so a command shown to a user names the
 * variable but not its value. The user knows their own key.
 */
export function describeCommandRedacted(
  binary: string,
  args: string[]
): string {
  return describeCommand(
    binary,
    args.map((arg) =>
      arg.startsWith('RUNPOD_API_KEY=')
        ? `RUNPOD_API_KEY=${KEY_PLACEHOLDER}`
        : arg
    )
  );
}

/**
 * Runs the Claude Code CLI.
 *
 * Via cross-spawn rather than `child_process` directly. Node's own docs are blunt
 * about why: "`.bat` and `.cmd` files are not executable on their own without a
 * terminal, and therefore cannot be launched using `child_process.execFile()`
 * […] if the script filename contains spaces it needs to be quoted." An npm-global
 * install of Claude Code is exactly a `.cmd`, frequently under a path with a space.
 *
 * cross-spawn handles it: `.com`/`.exe` spawn directly with argv preserved, and
 * anything else is wrapped in `cmd.exe /d /s /c` with each argument quoted,
 * backslash-doubled, `^`-escaped, and `windowsVerbatimArguments` set so libuv does
 * not re-quote on top. Hand-rolling that is how the first attempt at this shipped a
 * quoting bug, which is the whole reason for taking a dependency here. (npm itself
 * does NOT use cross-spawn for this — it has its own escaper in
 * @npmcli/promise-spawn. cross-spawn's claim to trust is ubiquity as a transitive
 * dependency, not adoption by npm's own spawn path.)
 */
// `refused` marks "we declined to run this", as opposed to "we ran it and it
// failed" — `remove` treats those differently.
export interface RunResult extends AddResult {
  refused?: boolean;
  // Raw combined stdout+stderr, for callers that must inspect what the CLI said.
  // INTERNAL ONLY — never surface this to a user: `claude mcp get` prints
  // `Environment: RUNPOD_API_KEY=<plaintext>`.
  output?: string;
}

/**
 * Strips a secret from text that is about to be shown to a user.
 *
 * The redaction above works on argv shape (`RUNPOD_API_KEY=<value>`); this works on
 * the value, which is what actually matters. Needed because `runClaude` surfaces the
 * CLI's own stdout/stderr, and that CLI does echo `-e` tokens back on some errors
 * (observed: `Invalid environment variable format: RUNPOD_API_KEY_rpa_…`). A
 * shape-based guard cannot cover output produced by another program.
 */
export function redactSecret(text: string, secret?: string): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join(KEY_PLACEHOLDER);
}

export function runClaude(
  binary: string,
  args: string[],
  secret?: string
): RunResult {
  if (needsCmdShell(binary, process.platform) && !argsSafeForCmdShell(args)) {
    return {
      success: false,
      refused: true,
      message: `running ${binary} means going through cmd.exe, and an argument contains a character this wizard will not risk escaping around a credential. Run it yourself, substituting your key:\n    ${describeCommandRedacted(binary, args)}`,
    };
  }
  const result = crossSpawn.sync(binary, args, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  // cross-spawn also synthesises an ENOENT here that raw spawnSync misses on
  // Windows, where a missing shell command exits 1 instead of failing to spawn.
  if (result.error)
    return {
      success: false,
      message: redactSecret(errMessage(result.error), secret),
    };
  const stdio = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0) return { success: true, output: stdio };
  if (result.status === null) {
    return { success: false, message: `killed by ${result.signal}` };
  }
  // The CLI reports "already exists" on stderr with a non-zero exit. Re-running the
  // wizard should be idempotent, not an error — but it is NOT an update: the CLI
  // leaves the existing entry alone, so a user re-running the wizard after rotating
  // their API key still has the old key. Say so rather than reporting a bare
  // success. Observed with claude 2.1.220 at the scope this wizard actually writes:
  // `MCP server runpod already exists in user config`, exit 1, stored key unchanged.
  // The remediation command carries the full binary path, because the first candidate
  // path exists precisely to cover installs that are not on PATH.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.includes('already exists')) {
    return {
      success: true,
      // Deliberately not "to replace the API key": this branch is also reached in
      // hosted mode, where there is no key — and the pre-existing entry may be of the
      // other kind entirely, which is exactly what the user needs to know.
      message: `already configured, existing entry left unchanged — it was NOT updated to what you just chose (to replace it, run \`${describeCommand(binary, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'])}\` first, then re-run this wizard)`,
    };
  }
  return {
    success: false,
    message: redactSecret(
      output.trim() ||
        `${path.basename(binary)} exited with code ${result.status}`,
      secret
    ),
  };
}

// What Claude Code's own config says about the runpod entry. Read from the file
// rather than inferred from `claude mcp get`, because that command answers "what
// would Claude Code use from here" — it reports only the WINNING scope, and local
// shadows user. Verified with claude 2.1.220: with a user-scope AND a local-scope
// entry both on disk, `mcp get` prints only `Scope: Local config`. So one scope
// string cannot distinguish "user entry present, shadowed by a local one" from "user
// entry absent, local one present" — and those need opposite verdicts. Two revisions
// of this file got that wrong in both directions.
//
// `--scope user` writes exactly one place: the top-level `mcpServers` of
// `.claude.json`. Reading it is exact, needs no spawn, and cannot be shadowed.
export interface ClaudeConfigState {
  // Is there a runpod entry in USER scope — the only scope this wizard writes?
  // undefined when the file cannot be read or parsed, i.e. "unknown", never a guess.
  userScope: boolean | undefined;
  // Directories whose local-scope config (projects[dir].mcpServers) also carries one.
  // This wizard never touches those, so a removal names them rather than implying the
  // key is gone. NOTE: project scope (`<dir>/.mcp.json`) is a separate file per
  // directory and is NOT covered here — a checked-in team entry can still shadow the
  // one this writes. Every message therefore scopes its claim to the user config.
  localScopeDirs: string[];
}

export function claudeUserConfigPath(): string {
  // CLAUDE_CONFIG_DIR is the documented override and is what the CLI itself honours.
  return path.join(
    process.env.CLAUDE_CONFIG_DIR || os.homedir(),
    '.claude.json'
  );
}

export function readClaudeConfigState(configPath: string): ClaudeConfigState {
  const unknown: ClaudeConfigState = {
    userScope: undefined,
    localScopeDirs: [],
  };
  // Belt and braces on top of the `||` above: a relative path is never the file the
  // CLI would use, so answering "absent" from it would be a guess. Say unknown.
  if (!path.isAbsolute(configPath)) return unknown;

  let raw: string;
  try {
    if (!fs.existsSync(configPath)) {
      // No config at all is a definite "no user-scope entry", not an unknown.
      return { userScope: false, localScopeDirs: [] };
    }
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    // Unreadable (permissions) — say unknown rather than "absent", which would let a
    // caller announce that a key is gone when it cannot see the file at all.
    return unknown;
  }
  const errors: jsonc.ParseError[] = [];
  const parsed = jsonc.parse(raw.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
  }) as
    | {
        mcpServers?: Record<string, unknown>;
        projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
      }
    | undefined;
  // An array or a scalar at the root is not a config this code understands; saying
  // "no user entry" about it would be a guess dressed as a fact.
  if (
    errors.length > 0 ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return unknown;
  }

  const has = (servers: unknown): boolean =>
    typeof servers === 'object' &&
    servers !== null &&
    Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);

  const localScopeDirs =
    typeof parsed.projects === 'object' && parsed.projects !== null
      ? Object.entries(parsed.projects)
          .filter(([, project]) => has(project?.mcpServers))
          .map(([dir]) => dir)
      : [];

  return { userScope: has(parsed.mcpServers), localScopeDirs };
}
/**
 * Turns a `claude mcp remove` run plus the config's own state into an outcome.
 *
 * Neither the exit code nor a `claude mcp get` probe can decide this. Four facts, all
 * observed with claude 2.1.220, each of which produced a false result in an earlier
 * revision of this file:
 *
 *   1. With an unwritable config, `mcp remove` prints `Removed MCP server runpod from
 *      user config / File modified: …` and exits **0** having written nothing.
 *   2. `claude mcp add` defaults to LOCAL scope while this removes from USER scope, so
 *      a hand-added entry reports `No MCP server named "runpod" in user scope`, exit 1.
 *   3. `mcp get` is cwd-pinned: an entry added in another directory is invisible.
 *   4. `mcp get` reports only the WINNING scope, and local shadows user — so a local
 *      entry hides a user entry that is still on disk.
 *
 * Reading `.claude.json` sidesteps all four: `--scope user` writes exactly one place,
 * and local-scope entries are enumerable across every directory rather than only the
 * current one.
 */
export function interpretRemoveResult(
  result: RunResult,
  state: ClaudeConfigState,
  binary = 'claude'
): AddResult {
  // A refusal ran nothing, so there is nothing to verify.
  if (result.refused) return result;

  const alsoElsewhere =
    state.localScopeDirs.length > 0
      ? ` A separate local-scope ${SERVER_NAME} entry (which may carry its own API key) also exists in ${state.localScopeDirs.length === 1 ? state.localScopeDirs[0] : `${state.localScopeDirs.length} project directories`} — this wizard does not touch those. Remove with \`${describeCommand(binary, ['mcp', 'remove', SERVER_NAME, '--scope', 'local'])}\` from each.`
      : '';

  if (state.userScope === true) {
    // Cause (1): the CLI reported whatever it reported, and the entry is still there.
    return {
      success: false,
      message: `the ${SERVER_NAME} entry is STILL in Claude Code's user config (${claudeUserConfigPath()}), so your API key is still on disk. Most likely that file is not writable — the CLI reports success anyway.${alsoElsewhere}`,
    };
  }

  if (state.userScope === false) {
    // Exact, not inferred: the file was read and has no user-scope entry.
    return {
      success: true,
      message:
        (result.success
          ? 'removed from your user config'
          : 'nothing to remove in your user config') + alsoElsewhere,
    };
  }

  // Config unreadable/unparseable — do not claim either way.
  if (result.success) {
    return {
      success: true,
      message: `removal reported success, but ${claudeUserConfigPath()} could not be read to confirm it`,
    };
  }
  return { success: false, message: result.message };
}

/**
 * Turns a `claude mcp add` run plus the config's own state into an outcome.
 *
 * Same reason as above, and the mirror failure is why the scope-string approach was
 * abandoned: with a pre-existing LOCAL entry in the current directory, `mcp get`
 * reports `local` even after a perfectly successful user-scope write — so keying off
 * it reported "nothing was configured" for a key that had just been written.
 */
export function interpretAddResult(
  result: RunResult,
  state: ClaudeConfigState
): AddResult {
  if (result.refused || !result.success) return result;

  if (state.userScope === false) {
    return {
      success: false,
      message: `Claude Code reported success but no ${SERVER_NAME} entry is in its user config afterwards (${claudeUserConfigPath()}) — that file is most likely not writable. Nothing was configured.`,
    };
  }

  if (state.userScope === undefined) {
    // Accepted — failing closed would break every user whose config this cannot parse,
    // for a problem that may not exist — but not reported as a clean success, or the
    // user has no way to know the write went unconfirmed.
    return {
      success: true,
      message: `${result.message ? `${result.message}; ` : ''}could not read ${claudeUserConfigPath()} to confirm the entry landed`,
    };
  }

  return { success: true, message: result.message };
}

/**
 * Built around an injectable binary resolver.
 *
 * The injection is not decoration: tests that drive this client must NOT be able to
 * reach a real `claude`. `findClaudeBinary` probes `~/.claude/local/claude`,
 * `/usr/local/bin/claude` and `/opt/homebrew/bin/claude` BEFORE consulting PATH, so a
 * harness that merely prepends a fake to PATH still runs the contributor's real CLI on
 * any machine with a native-installer or Homebrew install — executing
 * `claude mcp remove --scope user runpod` against their live config. CI cannot catch
 * that, because clean runner images have none of those paths.
 */
export function createClaudeCodeClient(
  resolveBinary: () => string | null,
  // Injected for the same reason as the binary: a test must not read — or draw
  // conclusions from — the developer's real ~/.claude.json.
  readState: () => ClaudeConfigState = () =>
    readClaudeConfigState(claudeUserConfigPath())
): McpClient {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    detect: () => Promise.resolve(resolveBinary() !== null),
    add: (mode) => {
      const binary = resolveBinary();
      if (!binary) {
        return Promise.resolve({
          success: false,
          message: 'claude CLI not found',
        });
      }
      const args =
        mode.kind === 'local'
          ? [
              'mcp',
              'add',
              SERVER_NAME,
              '--scope',
              'user',
              '-e',
              `RUNPOD_API_KEY=${mode.apiKey}`,
              '--',
              'npx',
              '-y',
              NPM_PACKAGE,
            ]
          : [
              'mcp',
              'add',
              '--transport',
              'http',
              '--scope',
              'user',
              SERVER_NAME,
              mode.url,
            ];
      // The key is passed in only so any message built from the CLI's output can have
      // it stripped — see redactSecret.
      const result = runClaude(
        binary,
        args,
        mode.kind === 'local' ? mode.apiKey : undefined
      );
      // Verified against the config, not the exit code — see interpretAddResult.
      return Promise.resolve(
        interpretAddResult(
          result,
          result.success
            ? readState()
            : { userScope: undefined, localScopeDirs: [] }
        )
      );
    },
    remove: () => {
      const binary = resolveBinary();
      if (!binary) {
        return Promise.resolve({
          success: false,
          message: 'claude CLI not found',
        });
      }
      // Through runClaude so this shares the spawn handling: previously it called
      // execFileSync directly, which cannot spawn a .cmd — and its catch reported
      // success regardless, so a failed removal printed a tick while the entry
      // stayed in the user's config.
      const result = runClaude(binary, [
        'mcp',
        'remove',
        '--scope',
        'user',
        SERVER_NAME,
      ]);
      return Promise.resolve(
        interpretRemoveResult(
          result,
          result.refused
            ? { userScope: undefined, localScopeDirs: [] }
            : readState(),
          binary
        )
      );
    },
    describeTarget: () => 'Claude Code user config (via `claude mcp` CLI)',
  };
}

const claudeCodeClient = createClaudeCodeClient(findClaudeBinary);

const home = os.homedir();
const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');

// Claude Desktop stores its config in an OS-specific location.
function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }
  // Linux followed the XDG location. Previously this returned the macOS path on
  // Linux, so a Linux user was told `✓ Claude Desktop configured` for a file under
  // ~/Library that nothing reads.
  // `||`, not `??`: the XDG spec says an empty value must be treated as unset, and
  // path.join('', 'Claude', …) yields a RELATIVE path — which would write a plaintext
  // API key into a Claude/ folder in whatever directory the wizard was launched from.
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'Claude',
    'claude_desktop_config.json'
  );
}

// VS Code uses a `servers` property (not `mcpServers`) in a per-user mcp.json.
function vsCodeConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(appData, 'Code', 'User', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'mcp.json'
    );
  }
  return path.join(home, '.config', 'Code', 'User', 'mcp.json');
}

export const CLIENTS: McpClient[] = [
  claudeCodeClient,
  jsonClient({
    id: 'cursor',
    name: 'Cursor',
    configPath: () => path.join(home, '.cursor', 'mcp.json'),
  }),
  jsonClient({
    id: 'windsurf',
    name: 'Windsurf',
    // Windsurf is stdio-only, so it reaches the hosted server via mcp-remote.
    hostedStrategy: 'mcp-remote',
    configPath: () =>
      path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  }),
  jsonClient({
    id: 'claude-desktop',
    name: 'Claude Desktop',
    // Claude Desktop config files are stdio-only; use the mcp-remote bridge.
    hostedStrategy: 'mcp-remote',
    configPath: claudeDesktopConfigPath,
    // Detect by the application/support directory, which exists once the app runs.
    detectPaths: () => [path.dirname(claudeDesktopConfigPath())],
  }),
  jsonClient({
    id: 'vscode',
    name: 'Visual Studio Code',
    serverProperty: 'servers',
    configPath: vsCodeConfigPath,
    detectPaths: () => [path.dirname(vsCodeConfigPath())],
  }),
];
