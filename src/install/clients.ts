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
function upsertJsonServer(
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
    const updated = jsonc.applyEdits(content, edits);
    // jsonc edits a malformed file on a best-effort basis: it will happily insert the
    // entry into a config with an unbalanced brace and hand back something still
    // unparseable, which the client then silently never loads. Refuse instead of
    // reporting success over a file we just confirmed is broken.
    const parseErrors: jsonc.ParseError[] = [];
    jsonc.parse(updated, parseErrors, { allowTrailingComma: true });
    if (parseErrors.length > 0) {
      return {
        success: false,
        message: `${configPath} is not valid JSON, so it was left untouched — the entry would not have loaded. Fix the file (or move it aside) and re-run.`,
      };
    }
    // mode is honoured only when the file is created; an existing config keeps its
    // own. 0600 because this file holds a plaintext API key, and Claude Code's own
    // config is 0600 — a fresh config should not be the loosest thing in the chain.
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
    const edits = jsonc.modify(
      content,
      [serverProperty, SERVER_NAME],
      undefined,
      { formattingOptions: { tabSize: 2, insertSpaces: true } }
    );
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
  if (result.status === 0) return { success: true };
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
      message: `already configured, entry left unchanged (to replace the API key, run \`${describeCommand(binary, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'])}\` first, then re-run this wizard)`,
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

// Whether the runpod entry is registered with Claude Code, in ANY scope:
// true/false, or undefined when the probe itself could not answer.
//
// `claude mcp get <name>` exits 0 when the server exists and 1 with
// `No MCP server named "runpod"` when it does not, and — unlike `mcp remove` — it is
// not scope-pinned (observed, claude 2.1.220). Nothing else here can answer the only
// question that matters: is the API key on disk or not?
export type EntryPresence = boolean | undefined;

function claudeEntryExists(binary: string): EntryPresence {
  const probe = runClaude(binary, ['mcp', 'get', SERVER_NAME]);
  if (probe.success) return true;
  if (/No MCP server named/i.test(probe.message ?? '')) return false;
  return undefined;
}

/**
 * Turns a `claude mcp remove` run plus a presence probe into a removal outcome.
 *
 * The exit code alone CANNOT decide this, which is why the probe exists. Two
 * observations with claude 2.1.220, both of which made the previous version of this
 * function report a false success:
 *
 *   1. With an unwritable config the CLI prints `Removed MCP server runpod from user
 *      config / File modified: …` and exits **0** — while the entry, API key
 *      included, is still on disk.
 *   2. `claude mcp add` defaults to LOCAL scope, but the wizard removes with
 *      `--scope user`. An entry a user added by hand therefore yields
 *      `No MCP server named "runpod" in user scope`, exit 1 — which reads as
 *      "nothing to remove" while their key stays in `~/.claude.json`.
 *
 * So the answer comes from what is observably on disk afterwards, and the exit code
 * is only a tiebreaker when the probe cannot answer. Getting this wrong is the
 * recurring bug in this file — three earlier revisions each reported a failed
 * removal as a green tick, by a different mechanism each time.
 */
export function interpretRemoveResult(
  result: RunResult,
  stillExists: EntryPresence,
  binary = 'claude'
): AddResult {
  // A refusal ran nothing, so there is nothing to verify.
  if (result.refused) return result;

  if (stillExists === true) {
    return {
      success: false,
      message: `the ${SERVER_NAME} entry is STILL registered with Claude Code, so your API key is still on disk. Two common causes: the config is not writable (the CLI reports success anyway), or the entry lives in a different scope — \`claude mcp add\` defaults to *local* scope while this removes from *user* scope. Check with \`${describeCommand(binary, ['mcp', 'get', SERVER_NAME])}\` and remove it with the matching \`--scope local\` or \`--scope project\`.`,
    };
  }

  if (stillExists === false) {
    // Verified gone. A non-zero exit here means there was nothing in user scope to
    // begin with, which is the desired end state either way.
    return {
      success: true,
      message: result.success ? result.message : 'nothing to remove',
    };
  }

  // Probe inconclusive — fall back to the run's own verdict rather than inventing
  // either answer, and say that it is unverified.
  if (result.success) {
    return {
      success: true,
      message: 'removal reported success, but it could not be verified',
    };
  }
  return { success: false, message: result.message };
}

/**
 * Turns a `claude mcp add` run plus a presence probe into a registration outcome.
 * Same reason as above: with an unwritable config the CLI prints
 * `Added stdio MCP server runpod …` and exits 0 without writing anything, so a bare
 * exit code would report a configuration that does not exist.
 */
export function interpretAddResult(
  result: RunResult,
  exists: EntryPresence
): AddResult {
  if (result.refused || !result.success) return result;
  if (exists === false) {
    return {
      success: false,
      message: `Claude Code reported success but no ${SERVER_NAME} entry is registered afterwards — its config is most likely not writable. Nothing was configured.`,
    };
  }
  return { success: true, message: result.message };
}

// Claude Code manages its own config, so we drive its CLI rather than writing
// files directly. This mirrors the documented `claude mcp add` command.
const claudeCodeClient: McpClient = {
  id: 'claude-code',
  name: 'Claude Code',
  detect: () => Promise.resolve(findClaudeBinary() !== null),
  add: (mode) => {
    const binary = findClaudeBinary();
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
        result.success ? claudeEntryExists(binary) : undefined
      )
    );
  },
  remove: () => {
    const binary = findClaudeBinary();
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
        result.refused ? undefined : claudeEntryExists(binary),
        binary
      )
    );
  },
  describeTarget: () => 'Claude Code user config (via `claude mcp` CLI)',
};

const home = os.homedir();
const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');

// Claude Desktop stores its config in an OS-specific location.
function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(
    home,
    'Library',
    'Application Support',
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
