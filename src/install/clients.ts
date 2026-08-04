import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
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
  // How this client parses its config, for clients that own a JSON file. Exposed so the
  // per-client wiring is assertable: reverting it to a single shared default left every
  // test green while Cursor was misclassified, because upsertJsonServer was only ever
  // exercised with an explicit dialect. Absent for Claude Code, which is driven by CLI.
  dialect?: ConfigDialect;
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

/**
 * How the client that owns a config parses it. This decides what "valid" means, so
 * every value here is a claim about a specific shipped parser and must be read out of
 * that client's own code — not inferred from "it's an Electron app".
 *
 *   'jsonc'      comments and trailing commas are accepted.
 *   'json'       strict `JSON.parse`; both are fatal.
 *   'unverified' tolerance not established. Validated leniently (so a config the
 *                client may well load is never refused) and any reliance on that
 *                leniency is disclosed to the user instead of being asserted away.
 *
 * Getting a value wrong breaks a user either way round: too strict refuses a healthy
 * config and leaves the client unconfigured, too lenient reports "configured" for a
 * file the client silently never loads. Verified against the shipped code:
 *
 *   Cursor         'jsonc'. Not strict, despite being an Electron app — a VS Code fork,
 *                  and its reader keeps VS Code's tolerance. `parseMcpServersFromFile`
 *                  → `t$t(content)`, which is
 *                    `stripComments` → `JSON.parse`, and on failure
 *                    `.replace(/,\s*([}\]])/g,'$1')` → `JSON.parse` again.
 *                  So comments and trailing commas both survive.
 *                  (workbench.desktop.main.js; a BOM is still fatal, hence the strip
 *                  on write below.)
 *   Claude Desktop 'json'. `wxr()` is `JSON.parse(Et.readFileSync(t,'utf8'))` with no
 *                  preprocessing and no retry (app.asar).
 *   VS Code        'jsonc'. Reads mcp.json as JSONC by design.
 *   Windsurf       'unverified' — not installed here, so its parser was never read.
 *                  It is a VS Code fork like Cursor, so it is probably lenient, but
 *                  "probably" is not a fact to put in a success message.
 */
export type ConfigDialect = 'json' | 'jsonc' | 'unverified';

function describeDialect(dialect: ConfigDialect): string {
  return dialect === 'json' ? 'JSON' : 'JSONC';
}

function parseFailure(
  content: string,
  dialect: ConfigDialect
): string | undefined {
  if (dialect === 'json') {
    try {
      JSON.parse(content);
      return undefined;
    } catch (error) {
      return errMessage(error);
    }
  }
  const errors: jsonc.ParseError[] = [];
  jsonc.parse(content, errors, { allowTrailingComma: true });
  return errors.length > 0
    ? `JSONC parse error at offset ${errors[0].offset}`
    : undefined;
}

// Parse the way the owning client parses, to answer "what will the client actually
// see?" rather than "is this file well-formed?". The two differ: duplicate keys are
// legal JSON, and every parser here keeps the LAST occurrence while `jsonc.modify`
// edits the FIRST.
function parseAsClient(content: string, dialect: ConfigDialect): unknown {
  // Lenient for 'unverified' as well as 'jsonc'. Using the strict parser here made a
  // commented config look as though the entry were absent, so the duplicate-key guard
  // below refused a perfectly good write — the same false-refusal defect as the Cursor
  // misclassification, introduced by the fix for it. This question is only "which
  // duplicate block wins", which is independent of comment tolerance.
  if (dialect !== 'json') {
    return jsonc.parse(content, [], { allowTrailingComma: true });
  }
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

// What the client will read at `[serverProperty][SERVER_NAME]` — undefined when absent.
function readBackEntry(
  content: string,
  serverProperty: string,
  dialect: ConfigDialect
): unknown {
  const parsed = parseAsClient(content, dialect);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const servers = (parsed as Record<string, unknown>)[serverProperty];
  if (typeof servers !== 'object' || servers === null) return undefined;
  return (servers as Record<string, unknown>)[SERVER_NAME];
}

// A file that only parses because the reader is lenient. Used to disclose the risk for
// 'unverified' clients rather than silently betting on it.
function reliesOnLeniency(content: string): boolean {
  if (content.trim() === '') return false;
  try {
    JSON.parse(content);
    return false;
  } catch {
    return parseFailure(content, 'jsonc') === undefined;
  }
}

// Read, edit, and write a JSON config while preserving the user's existing
// formatting and comments (jsonc). Creates the file and parent dirs if missing.
// Exported for tests: the client wrappers hardcode real config paths under $HOME, and
// a test must never write there.
export function upsertJsonServer(
  configPath: string,
  serverProperty: string,
  value: unknown,
  // Required, with no default: the default used to be the lenient value, so a caller
  // that forgot it silently got the very behaviour this parameter exists to prevent.
  dialect: ConfigDialect
): AddResult {
  // Refuse a relative target outright rather than trusting every caller to have
  // resolved one. This function creates directories and writes a plaintext API key, so
  // a relative path means creating a folder and leaking a credential into whatever
  // directory the wizard happened to be launched from. Guarding here closes the class
  // for every client at once, however the path was computed.
  if (!path.isAbsolute(configPath)) {
    return {
      success: false,
      message: `refusing to write "${configPath}": not an absolute path, so it would resolve against the current directory. This usually means an environment variable (APPDATA, XDG_CONFIG_HOME) is set to an empty or relative value.`,
    };
  }
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
    // Checked with the parser the OWNING CLIENT uses, not a lenient one. PowerShell's
    // Set-Content and Notepad write BOMs by default on the platform this targets, so the
    // BOM is stripped above rather than refused; double or trailing BOMs still fail here.
    const failure = parseFailure(updated, dialect);
    if (failure) {
      // Distinguish "we would break it" from "it was already broken", because the second
      // is the user's pre-existing problem and the advice differs.
      const wasAlreadyBroken =
        content.trim() !== '' && parseFailure(content, dialect) !== undefined;
      return {
        success: false,
        message: wasAlreadyBroken
          ? `${configPath} could not be parsed as ${describeDialect(dialect)} before this change either (${failure}), so it was left untouched — this client would not load the entry. Fix the file (or move it aside) and re-run.`
          : `writing to ${configPath} would leave it unparseable (${failure}), so it was left untouched.`,
      };
    }
    // Valid is not the same as effective. `jsonc.modify` edits the FIRST occurrence of a
    // duplicated key; every parser here keeps the LAST. Duplicate keys are legal JSON, so
    // the validity check above passes and the entry lands in a block nothing reads —
    // reporting success while writing a plaintext API key that never takes effect. Ask
    // the client's own parser what it will see instead of trusting that an edit applied.
    const landed = readBackEntry(updated, serverProperty, dialect);
    if (JSON.stringify(landed) !== JSON.stringify(value)) {
      return {
        success: false,
        message: `${configPath} was left untouched: the entry would have been written where this client does not read it, so it would have had no effect. This usually means "${serverProperty}" appears more than once in the file — the last one wins, so merge them into a single block and re-run.`,
      };
    }
    // mode is honoured only when the file is created; an existing config keeps its
    // own. 0600 because this file holds a plaintext API key, and a freshly created
    // Claude Code config is 0600 — a config this wizard creates should not be looser.
    // No effect on Windows, which has no POSIX mode bits (only the read-only flag is
    // real); there the ACL on the user profile directory is what governs access.
    fs.writeFileSync(configPath, updated, { encoding: 'utf8', mode: 0o600 });
    // The entry is written and this client's parser accepts the file. When that
    // acceptance rests on leniency we have not actually verified, say so rather than
    // print an unqualified tick: refusing would leave a probably-fine client
    // unconfigured, and claiming success would be asserting the thing we do not know.
    if (dialect === 'unverified' && reliesOnLeniency(updated)) {
      return {
        success: true,
        message:
          'written, but this config uses comments or trailing commas and whether this client accepts them is unverified — if the Runpod server does not appear, remove them',
      };
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: errMessage(error) };
  }
}

// Exported for the same reason as upsertJsonServer: the client wrappers hardcode real
// config paths under $HOME. Untested while unexported, which is how the relative-path
// guard here — and the trailing-comma corruption below — went unnoticed.
export function removeJsonServer(
  configPath: string,
  serverProperty: string,
  dialect: ConfigDialect
): AddResult {
  if (!path.isAbsolute(configPath)) {
    return {
      success: false,
      message: `refusing to touch "${configPath}": not an absolute path. Check APPDATA / XDG_CONFIG_HOME.`,
    };
  }
  try {
    if (!fs.existsSync(configPath)) {
      return { success: true, message: 'nothing to remove' };
    }
    const content = fs.readFileSync(configPath, 'utf8');
    if (content.trim() === '') {
      return { success: true, message: 'nothing to remove' };
    }
    const existingFailure = parseFailure(content, dialect);
    if (existingFailure !== undefined) {
      return {
        success: false,
        message: `could not safely remove the Runpod entry from ${configPath}: the existing config is not valid ${describeDialect(dialect)} (${existingFailure}). The original file was left unchanged; repair it or delete the entry by hand.`,
      };
    }
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
    // Zero edits normally means the entry is absent. It can also mean `jsonc.modify`
    // targeted a duplicate `serverProperty` block that does not contain it while the
    // block the client actually reads does — reporting "nothing to remove" over a
    // plaintext key still on disk. Confirm absence with the client's parser.
    if (edits.length === 0) {
      return readBackEntry(content, serverProperty, dialect) === undefined
        ? { success: true, message: 'nothing to remove' }
        : {
            success: false,
            message: `the Runpod entry is still present in ${configPath} and could not be removed automatically — "${serverProperty}" appears more than once, so the edit targeted a block this client does not read. Delete the entry by hand.`,
          };
    }
    const updated = jsonc.applyEdits(content, edits);
    // A surgical delete can leave a hole the parser rejects: removing the sole member of
    // `servers` that is followed by a trailing comma yields `{ , }`. Verified turning a
    // clean VS Code mcp.json into one with a parse error while reporting success. Both
    // VS Code and Cursor happen to recover from that shape, but a strict client would
    // stop loading every other server in the file, so it cannot be left behind.
    //
    // Do not fall back to a structural rewrite. JSON.stringify would make the file
    // parseable, but it would also erase comments and formatting from unrelated user
    // configuration without asking. The edit has not been written yet, so failing
    // closed leaves the original recoverable and gives the user a manual path.
    const brokeIt = parseFailure(updated, dialect) !== undefined;
    const stillThere =
      readBackEntry(updated, serverProperty, dialect) !== undefined;
    if (brokeIt || stillThere) {
      return {
        success: false,
        message: `could not remove the Runpod entry from ${configPath} without ${brokeIt ? 'making the config unparseable' : 'leaving the entry present'}. The original file was left unchanged so its comments and formatting are preserved; delete the Runpod entry by hand.`,
      };
    }
    fs.writeFileSync(configPath, updated, 'utf8');
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
  // How the owning client parses its config — see ConfigDialect for the evidence
  // behind each value. Deliberately required and un-defaulted: Cursor was misread as
  // strict purely by inheriting a default here, which refused configs Cursor loads fine
  // and left it unconfigured. A wrong value breaks users in one direction or the other,
  // so every client has to state its own.
  dialect: ConfigDialect;
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
        upsertJsonServer(opts.configPath(), serverProperty, value, opts.dialect)
      );
    },
    dialect: opts.dialect,
    remove: () =>
      Promise.resolve(
        removeJsonServer(opts.configPath(), serverProperty, opts.dialect)
      ),
    describeTarget: () => opts.configPath(),
  };
}

// A direct install location to probe, paired with the root its canonical target must
// stay inside. Pairing them here — rather than re-deriving the root from the
// candidate's position in a list, as an earlier revision did — means inserting or
// reordering a candidate cannot silently confine it to the wrong root.
export interface ClaudeCandidate {
  path: string;
  trustedRoot: string;
}

/**
 * Install locations to probe before the POSIX-only PATH lookup. Windows uses win32
 * path semantics regardless of the host so the branch is testable anywhere.
 *
 * `.local\bin\claude.exe` is the documented native-installer location and comes
 * first deliberately: it is a real executable and launches with no shell at all.
 * It also covers installs where the native installer failed to add
 * itself to PATH, which the lookup below could never find.
 */
export function claudeCandidates(
  platform: string,
  homedir: string,
  appdata?: string
): ClaudeCandidate[] {
  if (platform === 'win32') {
    const win = path.win32;
    // Automatic credential-bearing execution is limited to the standard per-user
    // roaming root, whatever APPDATA says: an arbitrary redirected APPDATA has no
    // trustworthy provenance merely because it is absolute.
    const defaultAppdata = win.join(homedir, 'AppData', 'Roaming');
    return [
      {
        path: win.join(homedir, '.local', 'bin', 'claude.exe'),
        trustedRoot: homedir,
      },
      // npm -g installs a .cmd shim. runClaude bypasses it and resolves the real
      // native or JavaScript target from the installed package manifest.
      //
      // absoluteEnvDir, not `?? `: an empty or relative APPDATA yielded the relative
      // `npm\claude.cmd`. Candidates are probed before any lookup, so a relative
      // candidate would resolve against the current directory and receive the live
      // API key.
      {
        path: win.join(
          absoluteEnvDir(appdata, () => defaultAppdata),
          'npm',
          'claude.cmd'
        ),
        trustedRoot: defaultAppdata,
      },
    ];
  }
  return [
    // Where the current native installer puts it (verified on a real install:
    // ~/.local/bin/claude -> versions/2.1.220). Same reasoning as the Windows
    // .local\bin\claude.exe entry — it also covers an install whose PATH entry is
    // missing, which the lookup can never find. Without it, POSIX detection depended
    // entirely on PATH.
    {
      path: path.posix.join(homedir, '.local', 'bin', 'claude'),
      trustedRoot: homedir,
    },
    {
      path: path.posix.join(homedir, '.claude', 'local', 'claude'),
      trustedRoot: homedir,
    },
    { path: '/usr/local/bin/claude', trustedRoot: '/usr/local' },
    { path: '/opt/homebrew/bin/claude', trustedRoot: '/opt/homebrew' },
  ];
}

// The probe locations alone. Kept as the stable test surface for "which paths does
// each platform look at".
export function claudeCandidatePaths(
  platform: string,
  homedir: string,
  appdata?: string
): string[] {
  return claudeCandidates(platform, homedir, appdata).map((c) => c.path);
}

function pathIsInside(
  candidate: string,
  directory: string,
  pathApi: typeof path.posix | typeof path.win32
): boolean {
  const relative = pathApi.relative(
    pathApi.resolve(directory),
    pathApi.resolve(candidate)
  );
  return (
    relative === '' ||
    (!relative.startsWith(`..${pathApi.sep}`) &&
      relative !== '..' &&
      !pathApi.isAbsolute(relative))
  );
}

function isNodeModulesBin(candidate: string): boolean {
  return /(^|[\\/])node_modules[\\/]\.bin([\\/]|$)/i.test(candidate);
}

/**
 * Picks a trustworthy absolute result from POSIX `command -v` output.
 *
 * Windows never calls this helper: its two standard install locations are probed
 * directly, avoiding both a shadowable lookup executable and project-local PATH
 * entries. POSIX still needs a fallback for package-manager/custom installs, but
 * relative paths, cwd descendants, and node_modules/.bin shims are rejected before
 * the canonical project-boundary check in findClaudeBinary.
 */
export function pickClaudeBinary(
  stdout: string,
  platform: string,
  cwd?: string
): string | null {
  if (platform === 'win32') return null;

  const hits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    hits.find(
      (hit) =>
        path.posix.isAbsolute(hit) &&
        !isNodeModulesBin(hit) &&
        (cwd === undefined || !pathIsInside(hit, cwd, path.posix))
    ) ?? null
  );
}

const PROJECT_BOUNDARY_MARKERS = [
  '.git',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

/**
 * The outermost source/workspace boundary containing cwd, never $HOME itself.
 *
 * `.git` alone is insufficient: release archives and copied workspaces routinely
 * omit VCS metadata. A nested package can have its own package.json, so keep
 * walking and retain the outermost ancestor carrying a project marker.
 *
 * The walk stops at `home` (canonical) without counting it. $HOME routinely carries
 * project markers that make it no repository at all — a stray `package.json` from an
 * accidental `npm install`, a dotfiles `.git` — and treating it as a boundary rejects
 * every candidate underneath it, including `~/.local/bin/claude` itself: the wizard
 * then reports Claude Code not found on exactly the standard installs it probes for.
 * A repository can only plant files inside its own tree, so a boundary above the
 * outermost marked directory *below* home defends nothing. Deliberately still the
 * OUTERMOST marked ancestor below home, not the nearest: in a monorepo whose package
 * dirs carry their own package.json, "nearest" would trust a tool planted at the repo
 * root.
 */
function projectBoundary(cwd: string, home?: string): string | null {
  let current = cwd;
  let boundary: string | null = null;
  while (true) {
    if (current === home) return boundary;
    if (
      PROJECT_BOUNDARY_MARKERS.some((marker) =>
        exists(path.join(current, marker))
      )
    ) {
      boundary = current;
    }
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    current = parent;
  }
}

/**
 * Canonical trust check for every Claude executable candidate.
 *
 * Direct user-level candidates are not automatically trusted: the path can be a
 * symlink/junction into the repository, and APPDATA/HOME can be redirected. PATH
 * results are rejected when they resolve inside an identifiable source/workspace
 * boundary. An unmarked cwd cannot be treated as a project root: doing so rejects
 * ordinary nvm/asdf/Volta installs when the wizard is launched from $HOME. Nor can a
 * MARKED $HOME — see projectBoundary, which never counts home itself.
 */
function trustedClaudeBinary(
  binary: string,
  cwd: string,
  home?: string,
  requiredRoot?: string
): string | null {
  try {
    const canonicalBinary = fs.realpathSync.native(binary);
    const canonicalCwd = fs.realpathSync.native(cwd);
    // Canonical, because the walk compares it against ancestors of a canonical cwd. A
    // home that cannot be canonicalized falls back to no cap — the stricter direction.
    let canonicalHome: string | undefined;
    if (home !== undefined) {
      try {
        canonicalHome = fs.realpathSync.native(home);
      } catch {
        canonicalHome = undefined;
      }
    }
    const projectRoot = projectBoundary(canonicalCwd, canonicalHome);
    const canonicalRequiredRoot =
      requiredRoot === undefined
        ? undefined
        : fs.realpathSync.native(requiredRoot);
    if (
      isNodeModulesBin(canonicalBinary) ||
      (canonicalRequiredRoot !== undefined &&
        !pathIsInside(canonicalBinary, canonicalRequiredRoot, path)) ||
      (projectRoot !== null && pathIsInside(canonicalBinary, projectRoot, path))
    ) {
      return null;
    }
    return canonicalBinary;
  } catch {
    // A lookup result that cannot be canonicalized is not safe to execute with a
    // credential, even if command -v reported it successfully.
    return null;
  }
}

// cmd.exe metacharacters used only when rendering a manual command for display.
const CMD_META = /[()\][%!^"`<>&|;, *?\t\n\v\r]/;

export interface FindClaudeBinaryOptions {
  platform?: string;
  // `null` means "known unavailable" — what a failed os.userInfo() lookup produces.
  // Distinct from `undefined` (= resolve it here), so a test can drive the
  // no-home-directory path without mocking os.userInfo across module boundaries.
  homedir?: string | null;
  appdata?: string;
  cwd?: string;
}

// Locate the Claude Code CLI binary across common install locations and PATH.
// Claude Code is the only client here detected by locating its executable rather
// than by an existing config file. `command -v` remains the POSIX fallback.
// Windows intentionally has no executable-lookup fallback: both the implicit
// current-directory search and npm/npx's project-local PATH entries can resolve a
// repository-supplied executable, and even a bare `where.exe` can itself be
// shadowed. The documented native and global-npm locations cover the standard
// Windows installs without executing anything discovered from the project.
// Exported for tests: the platform decisions are pure, so both branches can be
// exercised on any host without spawning anything or faking process.platform.
export function findClaudeBinary(
  options: FindClaudeBinaryOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  let homedir = options.homedir;
  if (homedir === undefined) {
    try {
      // os.homedir() honors HOME/USERPROFILE environment overrides. userInfo()
      // asks the OS for the account profile instead, so a launching project cannot
      // redirect an automatic credential-bearing candidate through those variables.
      homedir = os.userInfo().homedir;
    } catch {
      // No passwd entry for the process UID (arbitrary-UID containers, some CI
      // sandboxes). NOT os.homedir(): its answer is exactly the env-redirectable one
      // userInfo() exists to avoid. Home-anchored candidates are skipped, but the
      // POSIX PATH lookup below needs no homedir — returning here regressed those
      // environments from working (on main, via `command -v`) to undetectable.
      homedir = null;
    }
  }
  const appdata = options.appdata ?? process.env.APPDATA;
  const cwd = options.cwd ?? process.cwd();

  const candidates =
    homedir == null ? [] : claudeCandidates(platform, homedir, appdata);
  for (const candidate of candidates) {
    // Absolute only. `exists()` resolves a relative candidate against the CURRENT
    // DIRECTORY, and candidates are probed before the POSIX PATH lookup — so a
    // relative one would win outright and receive the live API key.
    if (
      !path.isAbsolute(candidate.path) &&
      !path.win32.isAbsolute(candidate.path)
    )
      continue;
    if (exists(candidate.path)) {
      // `?? undefined` only for the type: candidates is empty when homedir is null.
      const trusted = trustedClaudeBinary(
        candidate.path,
        cwd,
        homedir ?? undefined,
        candidate.trustedRoot
      );
      if (trusted !== null) return trusted;
    }
  }

  try {
    // Do not fall back to PATH on Windows. A repository can influence PATH and the
    // current-directory executable search, including shadowing the lookup program
    // itself. The standard native and global-npm locations above cover issue #56.
    if (platform === 'win32') return null;

    const out = execSync('command -v claude', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    // `pickClaudeBinary` still rejects relative and node_modules/.bin results. Do
    // not pass cwd here: an unmarked cwd might be $HOME, with a legitimate
    // nvm/asdf/Volta executable beneath it. The canonical check below rejects a
    // result inside cwd whenever cwd is actually part of a marked project.
    const binary = pickClaudeBinary(out, platform);
    return binary === null
      ? null
      : trustedClaudeBinary(binary, cwd, homedir ?? undefined);
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
  // Quote on cmd.exe metacharacters, not just whitespace. This function renders the
  // command printed when the wizard REFUSES to spawn something because an argument
  // holds a metacharacter — so quoting on whitespace alone handed the user a command
  // broken by the very character that triggered the refusal: with a URL override, a
  // bare `?a=1&b=2` makes cmd.exe split `&b=2` into a second command.
  const quote = (s: string) =>
    /\s/.test(s) || CMD_META.test(s) ? `"${s}"` : s;
  return [binary, ...args].map(quote).join(' ');
}

// Placeholder substituted for the key when a command is printed for the user.
// No cmd.exe metacharacters: this string is printed for a user to paste into
// cmd.exe, and `<`/`>` would be parsed as redirection — turning the wizard's own
// remediation command into an error.
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
 * A Windows npm-global `claude.cmd` is never executed. Its package manifest names
 * the real entrypoint. Current releases point at a native `bin/claude.exe`; older
 * releases may point at a JavaScript entrypoint. The target is canonicalized inside
 * the installed package, then spawned directly (native) or through this
 * already-running Node process (JavaScript). This avoids cmd.exe, COMSPEC, PATH
 * lookup, `%*` re-parsing, and command-line escaping entirely.
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
  if (!secret) return text;
  return text.split(secret).join(KEY_PLACEHOLDER);
}

function sanitizedClaudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      ['path', 'comspec', 'pathext', 'node_options', 'node_path'].includes(
        key.toLowerCase()
      )
    ) {
      delete env[key];
    }
  }
  if (process.platform === 'win32') {
    env.Path = path.dirname(process.execPath);
  } else {
    env.PATH = [
      path.dirname(process.execPath),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
    ].join(path.delimiter);
  }
  return env;
}

interface WindowsNpmClaudeTarget {
  command: string;
  argsPrefix: string[];
}

function windowsNpmClaudeTarget(binary: string): WindowsNpmClaudeTarget | null {
  if (process.platform !== 'win32' || !binary.toLowerCase().endsWith('.cmd')) {
    return null;
  }
  try {
    const npmRoot = fs.realpathSync.native(path.dirname(binary));
    const packageRoot = fs.realpathSync.native(
      path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code')
    );
    if (!pathIsInside(packageRoot, npmRoot, path)) return null;

    const manifestPath = fs.realpathSync.native(
      path.join(packageRoot, 'package.json')
    );
    if (!pathIsInside(manifestPath, packageRoot, path)) return null;
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8')
    ) as unknown;
    if (manifest === null || typeof manifest !== 'object') return null;
    const bin = (manifest as { bin?: unknown }).bin;
    const target =
      typeof bin === 'string'
        ? bin
        : bin !== null && typeof bin === 'object'
          ? (bin as Record<string, unknown>).claude
          : undefined;
    if (typeof target !== 'string' || target.trim() === '') return null;

    const entrypoint = fs.realpathSync.native(
      path.resolve(packageRoot, target)
    );
    if (!pathIsInside(entrypoint, packageRoot, path)) return null;
    if (/\.(?:exe|com)$/i.test(entrypoint)) {
      return { command: entrypoint, argsPrefix: [] };
    }
    if (/\.(?:c?js|mjs)$/i.test(entrypoint)) {
      return { command: process.execPath, argsPrefix: [entrypoint] };
    }
    return null;
  } catch {
    return null;
  }
}

export function runClaude(
  binary: string,
  args: string[],
  secret?: string
): RunResult {
  const isWindowsCmd =
    process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd');
  const npmTarget = windowsNpmClaudeTarget(binary);
  if (isWindowsCmd && npmTarget === null) {
    return {
      success: false,
      refused: true,
      message: `could not locate a trusted Claude Code npm entrypoint beside ${binary}. Run the shim yourself, substituting your key:\n    ${describeCommandRedacted(binary, args)}`,
    };
  }
  const command = npmTarget?.command ?? binary;
  const commandArgs = [...(npmTarget?.argsPrefix ?? []), ...args];
  const result = spawnSync(command, commandArgs, {
    stdio: 'pipe',
    encoding: 'utf8',
    env: sanitizedClaudeEnv(),
  });
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
  if (stdio.includes('already exists')) {
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
      stdio.trim() ||
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
//
// VERSION COUPLING: that storage location is a claim about claude 2.1.x. If a future
// Claude Code moves user-scope entries elsewhere, this reader will report "absent"
// after every successful add — turning each one into a false "Nothing was configured"
// failure in interpretAddResult. If that starts happening on a new CLI version, check
// where `--scope user` writes before suspecting the wizard.
export interface ClaudeConfigState {
  // The file this state was read from. Carried so a message names the file actually
  // consulted — the reader is injectable, so `claudeUserConfigPath()` is not
  // necessarily it.
  configPath: string;
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

/**
 * An environment-provided directory, or the fallback when it is unusable.
 *
 * Unusable means unset, empty, or relative. The XDG spec says exactly this for its own
 * variables ("must be treated as unset", "relative paths should be considered invalid
 * and ignored"), and the same reasoning applies to APPDATA: a relative directory resolves
 * against the process's cwd, and every path built from these either stores a plaintext
 * API key or gets executed.
 *
 * NOT for CLAUDE_CONFIG_DIR — see claudeUserConfigPath. That names a file the Claude Code
 * CLI owns and resolves relatively itself, so ignoring a relative value there would point
 * this code at a file the CLI never touched.
 */
export function absoluteEnvDir(
  value: string | undefined,
  fallback: () => string
): string {
  if (!value || !value.trim()) return fallback();
  // Check with both flavours: a Windows path is not absolute under path.posix and vice
  // versa, and this module deliberately computes win32 paths on any host for testing.
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value))
    return fallback();
  return value;
}

export function claudeUserConfigPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  // Deliberately NOT absoluteEnvDir, unlike XDG_CONFIG_HOME and APPDATA. Those name
  // paths this wizard invents, where a relative value can only mean writing a credential
  // into the current directory — so refusing it is right. This one names a file another
  // program owns, and that program resolves a relative value against its own cwd:
  // verified with claude 2.1.220, `CLAUDE_CONFIG_DIR=relcfg claude mcp add … --scope
  // user` prints `File modified: relcfg/.claude.json` and creates ./relcfg. Treating it
  // as unset would point this at $HOME/.claude.json — a file the CLI never touched — and
  // then report a DEFINITE verdict about it, which is precisely how a false success gets
  // built. So resolve it the way the CLI does. Only a truly empty value is unset, which
  // the CLI also falls back to $HOME for (verified).
  return path.join(
    configured ? path.resolve(configured) : os.homedir(),
    '.claude.json'
  );
}

export function readClaudeConfigState(configPath: string): ClaudeConfigState {
  const unknown: ClaudeConfigState = {
    configPath,
    userScope: undefined,
    localScopeDirs: [],
  };
  // Belt and braces on top of claudeUserConfigPath's own resolution: a relative path
  // is never the file the CLI would use, so answering "absent" from it would be a
  // guess. Say unknown.
  if (!path.isAbsolute(configPath)) return unknown;

  let raw: string;
  try {
    if (!fs.existsSync(configPath)) {
      // No config at all is a definite "no user-scope entry", not an unknown.
      return { configPath, userScope: false, localScopeDirs: [] };
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

  // Own-property, so a config with a `__proto__` key cannot conjure an mcpServers map.
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(parsed, key)
      ? (parsed as Record<string, unknown>)[key]
      : undefined;

  const projects = own('projects');
  // A plain object only: an array would yield index keys ("0", "1") that then get
  // printed to the user as directories to cd into.
  const localScopeDirs =
    typeof projects === 'object' &&
    projects !== null &&
    !Array.isArray(projects)
      ? Object.entries(projects as Record<string, { mcpServers?: unknown }>)
          .filter(([, project]) => has(project?.mcpServers))
          .map(([dir]) => dir)
      : [];

  return { configPath, userScope: has(own('mcpServers')), localScopeDirs };
}
// Lists directories without dumping twenty paths into one line.
function describeDirs(dirs: string[]): string {
  if (dirs.length === 1) return dirs[0];
  return `${dirs.length} project directories (${dirs.slice(0, 3).join(', ')}${dirs.length > 3 ? ', …' : ''})`;
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
      ? ` A separate local-scope ${SERVER_NAME} entry (which may carry its own API key) also exists in ${describeDirs(state.localScopeDirs)} — this wizard does not touch those. Remove with \`${describeCommand(binary, ['mcp', 'remove', SERVER_NAME, '--scope', 'local'])}\` from each.`
      : '';

  if (state.userScope === true) {
    // Cause (1): the CLI reported whatever it reported, and the entry is still there.
    return {
      success: false,
      message: `the ${SERVER_NAME} entry is STILL in Claude Code's user config (${state.configPath}), so your API key is still on disk. ${
        result.success
          ? 'Most likely that file is not writable — the CLI reports success anyway.'
          : `The removal command itself failed: ${result.message ?? 'no output'}`
      }${alsoElsewhere}`,
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
      message: `removal reported success, but ${state.configPath} could not be read to confirm it`,
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
  state: ClaudeConfigState,
  // Threaded through for the same reason interpretRemoveResult takes it: the
  // remediation command has to name the binary that was actually found. A bare
  // `claude` fails for exactly the not-on-PATH installs the candidate paths exist
  // to serve.
  binary: string
): AddResult {
  if (result.refused || !result.success) return result;

  if (state.userScope === false) {
    return {
      success: false,
      message: `Claude Code reported success but no ${SERVER_NAME} entry is in its user config afterwards (${state.configPath}) — that file is most likely not writable. Nothing was configured.`,
    };
  }

  if (state.userScope === true && state.localScopeDirs.length > 0) {
    // Local scope SHADOWS user scope, so in these directories the entry just written is
    // inert and Claude Code keeps using the local one, with its own possibly stale key.
    // That shadowing is the entire reason this reader exists, and the add path was
    // dropping the fact while the remove path reported it. The "already exists" caveat
    // cannot cover it: `mcp add --scope user` exits 0 when a local entry is present,
    // because the collision is per-scope.
    return {
      success: true,
      message: `${result.message ? `${result.message}; ` : ''}note a local-scope ${SERVER_NAME} entry also exists in ${describeDirs(state.localScopeDirs)} and takes precedence over the user config there, so Claude Code will keep using it in those projects — remove it with \`${describeCommand(binary, ['mcp', 'remove', SERVER_NAME, '--scope', 'local'])}\` run from each`,
    };
  }

  if (state.userScope === undefined) {
    // Accepted — failing closed would break every user whose config this cannot parse,
    // for a problem that may not exist — but not reported as a clean success, or the
    // user has no way to know the write went unconfirmed.
    return {
      success: true,
      message: `${result.message ? `${result.message}; ` : ''}could not read ${state.configPath} to confirm the entry landed`,
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
      const binary = resolveBinary();
      if (!binary) {
        // Automatic detection deliberately covers only the standard install
        // locations (see findClaudeBinary) — a custom npm prefix or redirected
        // profile still works, the user just registers it themselves from their own
        // shell, where their own PATH applies and this wizard's trust rules do not.
        return Promise.resolve({
          success: false,
          message: `claude CLI not found in the standard install locations. If Claude Code is installed somewhere custom, register it yourself${mode.kind === 'local' ? ', substituting your key' : ''}:\n    ${describeCommandRedacted('claude', args)}`,
        });
      }
      // The key is passed in only so any message built from the CLI's output can have
      // it stripped — see redactSecret.
      const result = runClaude(
        binary,
        args,
        mode.kind === 'local' ? mode.apiKey : undefined
      );
      // interpretAddResult passes failures and refusals through verbatim, so only a
      // success needs the config read to confirm it.
      if (!result.success) return Promise.resolve(result);
      // Verified against the config, not the exit code — see interpretAddResult.
      return Promise.resolve(interpretAddResult(result, readState(), binary));
    },
    remove: () => {
      const binary = resolveBinary();
      if (!binary) {
        return Promise.resolve({
          success: false,
          message: `claude CLI not found in the standard install locations. If Claude Code is installed somewhere custom, remove the entry yourself:\n    ${describeCommand('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user'])}`,
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
      // A refusal ran nothing, so there is nothing to verify — and reading the config
      // anyway would let interpretRemoveResult convert an unexecuted removal into
      // "nothing to remove".
      if (result.refused) return Promise.resolve(result);
      return Promise.resolve(
        interpretRemoveResult(result, readState(), binary)
      );
    },
    describeTarget: () => 'Claude Code user config (via `claude mcp` CLI)',
  };
}

const claudeCodeClient = createClaudeCodeClient(findClaudeBinary);

const home = os.homedir();
// `absoluteEnvDir` rather than `??`: an empty OR relative value must be treated as
// unset. `path.join('', 'Claude', …)` yields a RELATIVE path, and every consumer here
// either writes a plaintext API key to it or spawns it — so a relative value means
// writing the key into whatever directory the wizard was launched from, or executing a
// file out of it. This is the same defect three env vars have now produced
// (CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME, APPDATA), so it is resolved in one place.
// A function, not a module-level const: read at call time so a test can exercise the
// guard at all. As an import-time const, a test mutating process.env.APPDATA proved
// nothing — reverting the guard to `??` left the entire suite green.
function appDataDir(): string {
  return absoluteEnvDir(process.env.APPDATA, () =>
    path.join(home, 'AppData', 'Roaming')
  );
}

// Claude Desktop stores its config in an OS-specific location.
export function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(appDataDir(), 'Claude', 'claude_desktop_config.json');
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
  return path.join(
    absoluteEnvDir(process.env.XDG_CONFIG_HOME, () =>
      path.join(home, '.config')
    ),
    'Claude',
    'claude_desktop_config.json'
  );
}

// VS Code uses a `servers` property (not `mcpServers`) in a per-user mcp.json.
export function vsCodeConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(appDataDir(), 'Code', 'User', 'mcp.json');
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
  // Honours XDG_CONFIG_HOME like the Claude Desktop path does. Hardcoding ~/.config
  // meant an XDG user got `✓ Visual Studio Code configured` for a file VS Code does not
  // read — the same defect this PR fixed for Claude Desktop on Linux.
  return path.join(
    absoluteEnvDir(process.env.XDG_CONFIG_HOME, () =>
      path.join(home, '.config')
    ),
    'Code',
    'User',
    'mcp.json'
  );
}

export const CLIENTS: McpClient[] = [
  claudeCodeClient,
  jsonClient({
    id: 'cursor',
    name: 'Cursor',
    // A VS Code fork, and its MCP reader keeps VS Code's tolerance — comments and
    // trailing commas both parse. Read out of the shipped bundle, not assumed from
    // "Electron app"; see ConfigDialect.
    dialect: 'jsonc',
    configPath: () => path.join(home, '.cursor', 'mcp.json'),
  }),
  jsonClient({
    id: 'windsurf',
    name: 'Windsurf',
    // Not installed on any machine this was checked on, so its parser was never read.
    // Lenient-and-disclosed rather than a guess in either direction.
    dialect: 'unverified',
    // Windsurf is stdio-only, so it reaches the hosted server via mcp-remote.
    hostedStrategy: 'mcp-remote',
    configPath: () =>
      path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  }),
  jsonClient({
    id: 'claude-desktop',
    name: 'Claude Desktop',
    // Genuinely strict: its reader is a bare `JSON.parse(readFileSync(...))` with no
    // preprocessing and no retry, so a comment or trailing comma is fatal.
    dialect: 'json',
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
    // The one client that genuinely reads JSONC — comments and trailing commas in
    // mcp.json are supported and common.
    dialect: 'jsonc',
    configPath: vsCodeConfigPath,
    detectPaths: () => [path.dirname(vsCodeConfigPath())],
  }),
];
