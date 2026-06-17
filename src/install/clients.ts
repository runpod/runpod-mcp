import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import * as jsonc from 'jsonc-parser';

// The npm package and the name the server is registered under in client config.
export const SERVER_NAME = 'runpod';
export const NPM_PACKAGE = '@runpod/mcp-server@latest';

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
  add(apiKey: string): Promise<AddResult>;
  // Remove the Runpod server entry from the client's config.
  remove(): Promise<AddResult>;
  // Where the config lives, for display and manual fallback.
  describeTarget(): string;
}

// The stdio server config every JSON-based client shares. Runpod's MCP server
// runs locally via npx and reads the API key from the environment.
function serverConfig(apiKey: string) {
  return {
    command: 'npx',
    args: ['-y', NPM_PACKAGE],
    env: { RUNPOD_API_KEY: apiKey },
  };
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

// A JSON-config client that differs only in config path and server property.
function jsonClient(opts: {
  id: string;
  name: string;
  serverProperty?: string;
  configPath: () => string;
  detectPaths?: () => string[];
}): McpClient {
  const serverProperty = opts.serverProperty ?? 'mcpServers';
  return {
    id: opts.id,
    name: opts.name,
    detect: () =>
      Promise.resolve(
        (opts.detectPaths?.() ?? [path.dirname(opts.configPath())]).some(exists)
      ),
    add: (apiKey) =>
      Promise.resolve(
        upsertJsonServer(
          opts.configPath(),
          serverProperty,
          serverConfig(apiKey)
        )
      ),
    remove: () =>
      Promise.resolve(removeJsonServer(opts.configPath(), serverProperty)),
    describeTarget: () => opts.configPath(),
  };
}

// Locate the Claude Code CLI binary across common install locations and PATH.
function findClaudeBinary(): string | null {
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  try {
    execSync('command -v claude', { stdio: 'pipe' });
    return 'claude';
  } catch {
    return null;
  }
}

// Claude Code manages its own config, so we drive its CLI rather than writing
// files directly. This mirrors the documented `claude mcp add` command.
const claudeCodeClient: McpClient = {
  id: 'claude-code',
  name: 'Claude Code',
  detect: () => Promise.resolve(findClaudeBinary() !== null),
  add: (apiKey) => {
    const binary = findClaudeBinary();
    if (!binary) {
      return Promise.resolve({
        success: false,
        message: 'claude CLI not found',
      });
    }
    const args = [
      'mcp',
      'add',
      SERVER_NAME,
      '--scope',
      'user',
      '-e',
      `RUNPOD_API_KEY=${apiKey}`,
      '--',
      'npx',
      '-y',
      NPM_PACKAGE,
    ];
    try {
      execSync(`${binary} ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
        stdio: 'pipe',
      });
      return Promise.resolve({ success: true });
    } catch (error) {
      const message = errMessage(error);
      // Re-running the wizard should be idempotent, not an error.
      if (message.includes('already exists')) {
        return Promise.resolve({
          success: true,
          message: 'already configured',
        });
      }
      return Promise.resolve({ success: false, message });
    }
  },
  remove: () => {
    const binary = findClaudeBinary();
    if (!binary) {
      return Promise.resolve({
        success: false,
        message: 'claude CLI not found',
      });
    }
    try {
      execSync(`${binary} mcp remove --scope user ${SERVER_NAME}`, {
        stdio: 'pipe',
      });
      return Promise.resolve({ success: true });
    } catch (error) {
      return Promise.resolve({ success: true, message: errMessage(error) });
    }
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
    configPath: () =>
      path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  }),
  jsonClient({
    id: 'claude-desktop',
    name: 'Claude Desktop',
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
