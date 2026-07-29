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
    fs.writeFileSync(configPath, jsonc.applyEdits(content, edits), 'utf8');
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
 * Picks one path from a lookup's stdout. `where.exe` can print several lines for
 * one name (e.g. `claude` and `claude.cmd`). Prefer something cross-spawn can
 * launch without cmd.exe, so the common case involves no shell at all. Returns
 * null when nothing came back.
 */
export function pickClaudeBinary(
  stdout: string,
  platform: string
): string | null {
  const hits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (hits.length === 0) return platform === 'win32' ? null : 'claude';
  if (platform !== 'win32') return hits[0];
  return hits.find((h) => !needsCmdShell(h, platform)) ?? hits[0];
}

/**
 * True when running this path means going through cmd.exe. Mirrors cross-spawn's
 * own rule (lib/parse.js): on Windows it spawns directly only when the resolved
 * file ends in `.com`/`.exe`; anything else — a `.cmd` shim, an extensionless hit —
 * is wrapped in `cmd.exe /d /s /c`. Always false off Windows.
 */
export function needsCmdShell(binary: string, platform: string): boolean {
  if (platform !== 'win32') return false;
  return !/\.(com|exe)$/i.test(binary);
}

// cmd.exe metacharacters, the same set cross-spawn escapes in lib/util/escape.js.
const CMD_META = /[()\][%!^"`<>&|;, *?]/;

/**
 * Whether it is safe to hand these args to a `.cmd` shim.
 *
 * cross-spawn escapes arguments properly for a single cmd.exe parse, but a shim
 * re-expands them: npm's generated `claude.cmd` ends in `node "…cli.js" %*`, so
 * the arguments are parsed a second time. cross-spawn compensates by escaping
 * twice, but only for shims it recognises — its check is
 * `/node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i`, which a global npm shim in
 * `%APPDATA%\npm` does not match. Rather than reimplement its escaping, refuse the
 * narrow case: an argument carrying a metacharacter, bound for a shim. Runpod API
 * keys are `rpa_` + alphanumerics, so in practice this never triggers.
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
    // between a .exe and a .cmd shim is made here (see pickClaudeBinary) instead of
    // being left to PATHEXT order inside cmd.exe.
    const out = execSync(claudeLookupCommand(platform), {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return pickClaudeBinary(out, platform);
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

/**
 * Runs the Claude Code CLI.
 *
 * Via cross-spawn rather than `child_process` directly. Node's own docs are blunt
 * about why: "`.bat` and `.cmd` files are not executable on their own without a
 * terminal, and therefore cannot be launched using `child_process.execFile()`
 * […] if the script filename contains spaces it needs to be quoted." An npm-global
 * install of Claude Code is exactly a `.cmd`, frequently under a path with a space.
 *
 * cross-spawn is the ecosystem's answer to that (it is what npm itself uses):
 * `.com`/`.exe` spawn directly with argv preserved, and anything else is wrapped in
 * `cmd.exe /d /s /c` with each argument quoted, backslash-doubled, `^`-escaped, and
 * `windowsVerbatimArguments` set so libuv does not re-quote on top. Hand-rolling
 * that is how the first attempt at this shipped a quoting bug — the library has had
 * a decade of npm-scale abuse finding those.
 */
// `refused` marks "we declined to run this", as opposed to "we ran it and it
// failed" — `remove` treats those differently.
export interface RunResult extends AddResult {
  refused?: boolean;
}

export function runClaude(binary: string, args: string[]): RunResult {
  if (needsCmdShell(binary, process.platform) && !argsSafeForCmdShell(args)) {
    return {
      success: false,
      refused: true,
      message: `running ${binary} means going through cmd.exe, and an argument contains a character this wizard will not risk escaping around a credential. Run it yourself:\n    ${describeCommand(binary, args)}`,
    };
  }
  const result = crossSpawn.sync(binary, args, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  // cross-spawn also synthesises an ENOENT here that raw spawnSync misses on
  // Windows, where a missing shell command exits 1 instead of failing to spawn.
  if (result.error)
    return { success: false, message: errMessage(result.error) };
  if (result.status === 0) return { success: true };
  if (result.status === null) {
    return { success: false, message: `killed by ${result.signal}` };
  }
  // The CLI reports "already exists" on stderr with a non-zero exit. Re-running
  // the wizard should be idempotent, not an error.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.includes('already exists')) {
    return { success: true, message: 'already configured' };
  }
  return {
    success: false,
    message:
      output.trim() ||
      `${path.basename(binary)} exited with code ${result.status}`,
  };
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
    return Promise.resolve(runClaude(binary, args));
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
    // A removal that found nothing to remove is still a success (the desired end
    // state holds either way); one we declined to run is not.
    if (result.refused) return Promise.resolve(result);
    return Promise.resolve({ success: true, message: result.message });
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
