import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
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
 * first deliberately: it is a real executable, so it can be spawned directly with
 * no shell. It also covers installs where the native installer failed to add
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
      // npm -g installs a .cmd shim. Last, because a .cmd cannot be spawned
      // without a shell — see runClaude.
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
 * one name (e.g. `claude` and `claude.cmd`). Prefer a directly-spawnable
 * executable: `execFileSync` uses no shell, so a `.exe` can be launched as-is
 * while a `.cmd` cannot be launched at all. Returns null when nothing came back.
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
  return hits.find((h) => isDirectlySpawnable(h)) ?? hits[0];
}

/**
 * True when Node can spawn this path without a shell. `.cmd` and `.bat` are
 * interpreted by cmd.exe rather than being executables, so `execFile` cannot run
 * them — see the Node child_process docs.
 */
export function isDirectlySpawnable(binary: string): boolean {
  return !/\.(cmd|bat)$/i.test(binary);
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
    // Resolve to a real path rather than returning the bare name: runClaude uses
    // execFileSync, which does not go through a shell and so cannot resolve a
    // .cmd shim from a bare 'claude' on Windows.
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
 * Renders a command for a human to copy, quoting only what needs it. Plain
 * double-quote wrapping, NOT JSON.stringify — the latter escapes the backslashes
 * in a Windows path, which is exactly wrong for something the user will paste.
 */
export function describeCommand(binary: string, args: string[]): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [binary, ...args].map(quote).join(' ');
}

/**
 * Runs the Claude Code CLI with no shell, so an API key containing shell
 * metacharacters cannot be interpreted.
 *
 * A `.cmd` shim can't be run this way — `execFile` has no shell to interpret it —
 * and routing it through `cmd.exe` is deliberately NOT done: the key travels in
 * argv, cmd.exe re-parses the command line, and Node only quotes arguments that
 * contain whitespace or a quote. An argument like `rpa_x&whoami` would reach
 * cmd.exe unquoted and split into a second command. Rather than hand-roll cmd
 * escaping around a credential, print the command for the user to run.
 */
function runClaude(binary: string, args: string[]): AddResult {
  if (!isDirectlySpawnable(binary)) {
    return {
      success: false,
      message: `found a .cmd shim (${binary}) which can only run via a shell, and this wizard will not pass your API key through one. Run this yourself:\n    ${describeCommand(binary, args)}`,
    };
  }
  try {
    execFileSync(binary, args, { stdio: 'pipe' });
    return { success: true };
  } catch (error) {
    const message = errMessage(error);
    // Re-running the wizard should be idempotent, not an error.
    if (message.includes('already exists')) {
      return { success: true, message: 'already configured' };
    }
    return { success: false, message };
  }
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
    // Through runClaude so this shares the .cmd handling: previously it called
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
    // A removal that found nothing to remove is still a success; a shim we refused
    // to run is not.
    if (!result.success && result.message?.includes('.cmd shim')) {
      return Promise.resolve(result);
    }
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
