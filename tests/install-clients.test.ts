import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeCandidatePaths,
  claudeLookupCommand,
  pickClaudeBinary,
  needsCmdShell,
  argsSafeForCmdShell,
  describeCommand,
  describeCommandRedacted,
  interpretRemoveResult,
  interpretAddResult,
  redactSecret,
  runClaude,
  createClaudeCodeClient,
  readClaudeConfigState,
  claudeUserConfigPath,
  absoluteEnvDir,
  claudeDesktopConfigPath,
  vsCodeConfigPath,
  upsertJsonServer,
} from '../src/install/clients.js';

// A stand-in for the user config path in state literals. Never read: these suites
// exercise the interpretation, and the reader has its own suite.
const TEST_CONFIG_PATH = '/home/dev/.claude.json';

// Regression coverage for issue #56 — the install wizard never detected Claude Code
// on Windows. The platform-dependent decisions are pure functions, so both branches
// run on any host with no spawning and no faking of process.platform.
//
// The spawn itself cannot be faked that way, so the last suite here actually runs a
// `.cmd` shim from a directory whose name contains a space — the exact combination
// Node's docs call out as unlaunchable via execFile. It is skipped off Windows and
// runs on the windows-latest CI leg.

describe('claudeLookupCommand', () => {
  it('uses where.exe on Windows, not the POSIX shell builtin', () => {
    // `command -v` is a shell builtin; execSync on Windows goes through cmd.exe,
    // which has no such builtin, so it exited non-zero whether or not Claude Code
    // was installed. That is the whole bug.
    assert.equal(claudeLookupCommand('win32'), 'where.exe claude');
  });

  it('keeps command -v on POSIX platforms', () => {
    for (const platform of ['darwin', 'linux', 'freebsd']) {
      assert.equal(claudeLookupCommand(platform), 'command -v claude');
    }
  });
});

describe('claudeCandidatePaths', () => {
  it('returns exactly the documented Windows locations, win32-shaped', () => {
    // Asserted as a whole array rather than by predicate: a check like "no
    // candidate starts with /" passes for any C:-prefixed junk. Built with
    // path.win32 internally, so this is the shape real Windows sees rather than a
    // host-mangled hybrid with forward slashes.
    assert.deepEqual(
      claudeCandidatePaths(
        'win32',
        'C:\\Users\\John Doe',
        'C:\\Users\\John Doe\\AppData\\Roaming'
      ),
      [
        // Native installer — a real .exe, so cross-spawn launches it with no shell.
        // First on purpose; it also covers installs whose PATH entry is missing,
        // which the lookup could never find.
        'C:\\Users\\John Doe\\.local\\bin\\claude.exe',
        // npm -g shim. Runnable, but only via cmd.exe, so it stays last.
        'C:\\Users\\John Doe\\AppData\\Roaming\\npm\\claude.cmd',
      ]
    );
  });

  it('never emits a POSIX-only path on Windows', () => {
    // The original bug was probing /usr/local/bin/claude on Windows.
    for (const p of claudeCandidatePaths('win32', 'C:\\Users\\dev')) {
      assert.equal(p.includes('/'), false, `forward slash in ${p}`);
    }
  });

  it('derives an AppData path when APPDATA is unset', () => {
    const paths = claudeCandidatePaths('win32', 'C:\\Users\\dev', undefined);
    assert.ok(
      paths.some((p) => p.endsWith('AppData\\Roaming\\npm\\claude.cmd')),
      JSON.stringify(paths)
    );
  });

  it('keeps the original POSIX candidates unchanged', () => {
    assert.deepEqual(claudeCandidatePaths('darwin', '/Users/dev'), [
      '/Users/dev/.claude/local/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ]);
  });
});

describe('pickClaudeBinary', () => {
  it('prefers a .exe over a .cmd shim', () => {
    // Both are runnable now. The .exe is still preferred because cross-spawn can
    // launch it with no shell at all, where the .cmd costs a cmd.exe hop.
    const stdout =
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd\r\n' +
      'C:\\Users\\dev\\.local\\bin\\claude.exe\r\n';
    assert.equal(
      pickClaudeBinary(stdout, 'win32'),
      'C:\\Users\\dev\\.local\\bin\\claude.exe'
    );
  });

  it('prefers a .cmd over the extensionless sh shim npm writes beside it', () => {
    // npm's cmd-shim writes THREE files per bin: an extensionless `#!/bin/sh` shim,
    // a .cmd and a .ps1. `where.exe` lists the exact-name match first, so taking the
    // first hit picks the sh shim — which Windows cannot run at all (cross-spawn
    // reads the shebang and tries to spawn /bin/sh). The .cmd is the runnable one.
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude\r\nC:\\bin\\claude.cmd\r\n', 'win32'),
      'C:\\bin\\claude.cmd'
    );
  });

  it('ranks .exe above .cmd above anything else', () => {
    assert.equal(
      pickClaudeBinary(
        'C:\\bin\\claude.ps1\r\nC:\\bin\\claude\r\nC:\\bin\\claude.cmd\r\nC:\\bin\\claude.exe\r\n',
        'win32'
      ),
      'C:\\bin\\claude.exe'
    );
  });

  it('deprioritises a hit in the current directory', () => {
    // `where.exe` searches the current directory BEFORE PATH. Running the wizard
    // from a folder containing a file named claude.cmd would otherwise hand that
    // file the user's API key.
    assert.equal(
      pickClaudeBinary(
        'C:\\work\\project\\claude.cmd\r\nC:\\bin\\claude.cmd\r\n',
        'win32',
        'C:\\work\\project'
      ),
      'C:\\bin\\claude.cmd'
    );
  });

  it('still uses a cwd hit when it is the only one', () => {
    // Deprioritised, not excluded: someone may legitimately be running the wizard
    // from the directory their claude install lives in.
    assert.equal(
      pickClaudeBinary('C:\\work\\claude.cmd\r\n', 'win32', 'C:\\work'),
      'C:\\work\\claude.cmd'
    );
  });

  it('handles CRLF line endings', () => {
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude.exe\r\n', 'win32'),
      'C:\\bin\\claude.exe'
    );
  });

  it('falls back to a .cmd when that is the only hit', () => {
    // The npm-global install. cross-spawn runs it through cmd.exe.
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude.cmd\r\n', 'win32'),
      'C:\\bin\\claude.cmd'
    );
  });

  it('returns null on Windows for empty output', () => {
    // A bare 'claude' would be a guess: PATHEXT decides what it resolves to, and
    // the point of the lookup is to know which file was found.
    assert.equal(pickClaudeBinary('', 'win32'), null);
    assert.equal(pickClaudeBinary('\r\n  \r\n', 'win32'), null);
  });

  it('returns the resolved POSIX path from command -v', () => {
    assert.equal(
      pickClaudeBinary('/opt/homebrew/bin/claude\n', 'darwin'),
      '/opt/homebrew/bin/claude'
    );
  });

  it("keeps the historic bare 'claude' fallback on POSIX", () => {
    // command -v normally prints a path, but a successful exit with no output
    // still means "found" on POSIX, where the spawn resolves the name via PATH.
    assert.equal(pickClaudeBinary('', 'darwin'), 'claude');
  });
});

describe('needsCmdShell', () => {
  // Approximates cross-spawn's rule (lib/parse.js `isExecutableRegExp`): on Windows
  // it spawns directly only for .com/.exe and wraps everything else in cmd.exe.
  // Approximates, because cross-spawn tests the file it resolved via PATHEXT while
  // this tests the string as given — so the two can disagree. The bias is toward
  // saying "yes, shell", which costs at most an unnecessary refusal; the opposite
  // error would let an unescaped argument through.
  it('is false for .com and .exe on Windows', () => {
    for (const p of [
      'C:\\Users\\dev\\.local\\bin\\claude.exe',
      'C:\\bin\\claude.EXE',
      'C:\\bin\\claude.com',
    ]) {
      assert.equal(needsCmdShell(p, 'win32'), false, p);
    }
  });

  it('is true for .cmd, .bat and extensionless paths on Windows', () => {
    for (const p of [
      'C:\\npm\\claude.cmd',
      'C:\\npm\\claude.CMD',
      'C:\\npm\\claude.bat',
      'C:\\bin\\claude',
    ]) {
      assert.equal(needsCmdShell(p, 'win32'), true, p);
    }
  });

  it('is always false off Windows', () => {
    // A POSIX file called claude.cmd is just a file; execvp runs it if it is
    // executable. No cmd.exe exists to route through.
    for (const platform of ['darwin', 'linux']) {
      assert.equal(needsCmdShell('/opt/bin/claude', platform), false);
      assert.equal(needsCmdShell('/opt/bin/claude.cmd', platform), false);
    }
  });

  it('is not fooled by an extension appearing mid-path', () => {
    assert.equal(needsCmdShell('C:\\cmd\\tools\\claude.exe', 'win32'), false);
  });
});

describe('argsSafeForCmdShell', () => {
  // cross-spawn escapes correctly for one cmd.exe parse, but an npm-global shim
  // re-expands its arguments via `%*`. cross-spawn double-escapes only for shims it
  // recognises (node_modules/.bin), which a global shim is not — so a metacharacter
  // in an argument bound for one is refused rather than escaped by hand.
  it('accepts the arguments the wizard actually sends', () => {
    // If a future arg introduces a metacharacter, this fails here rather than
    // silently turning into a refusal on Windows only.
    assert.equal(
      argsSafeForCmdShell([
        'mcp',
        'add',
        'runpod',
        '--scope',
        'user',
        '-e',
        'RUNPOD_API_KEY=rpa_ABC123def456',
        '--',
        'npx',
        '-y',
        '@runpod/mcp-server@latest',
      ]),
      true
    );
    assert.equal(
      argsSafeForCmdShell([
        'mcp',
        'add',
        '--transport',
        'http',
        '--scope',
        'user',
        'runpod',
        'https://mcp.getrunpod.io/',
      ]),
      true
    );
  });

  it('rejects the metacharacters that split a cmd command line', () => {
    for (const arg of [
      'RUNPOD_API_KEY=rpa_x&whoami',
      'RUNPOD_API_KEY=rpa_x|whoami',
      'RUNPOD_API_KEY=rpa_x>out.txt',
      'RUNPOD_API_KEY=%PATH%',
      'RUNPOD_API_KEY=rpa_x^y',
      'RUNPOD_API_KEY=rpa_"x',
    ]) {
      assert.equal(argsSafeForCmdShell(['-e', arg]), false, arg);
    }
  });

  it('rejects an embedded newline', () => {
    // A key sourced from a shell profile or .env can carry one. Its behaviour on a
    // re-parsed cmd command line is not worth discovering with a live credential —
    // and npm's own escaper treats newlines as needing quotes too.
    assert.equal(argsSafeForCmdShell(['-e', 'RUNPOD_API_KEY=rpa_x\n']), false);
    assert.equal(
      argsSafeForCmdShell(['-e', 'RUNPOD_API_KEY=rpa_x\r\n']),
      false
    );
  });
});

describe('interpretRemoveResult', () => {
  // Three earlier revisions reported EVERY removal as a success — from a bare catch,
  // then by discarding result.success, then by asserting "nothing to remove" from a
  // scope-pinned probe. Each time the user saw a green tick while their API key stayed
  // on disk. The exit code CANNOT decide this, which is why a presence probe is the
  // deciding input. Every case is pinned here.
  it('reports a failure when the entry is verifiably still there, whatever the exit code said', () => {
    // The case the exit code gets wrong in BOTH directions, observed with claude
    // 2.1.220: (a) with an unwritable config `mcp remove` prints "Removed … File
    // modified" and exits 0 without writing anything; (b) `mcp add` defaults to LOCAL
    // scope while this wizard removes from USER scope, so a hand-added entry reports
    // `No MCP server named … in user scope` and exits 1 while the key sits in
    // ~/.claude.json.
    for (const run of [
      { success: true },
      { success: false, message: 'No MCP server named "runpod" in user scope' },
    ]) {
      const out = interpretRemoveResult(
        run,
        { configPath: TEST_CONFIG_PATH, userScope: true, localScopeDirs: [] },
        '/usr/bin/claude'
      );
      assert.equal(out.success, false, JSON.stringify(run));
      assert.match(out.message ?? '', /still on disk/);
      // Actionable: names the file and the likely cause.
      assert.match(out.message ?? '', /user config/);
      assert.match(out.message ?? '', /not writable/);
    }
  });

  it('is a success when nothing is visible, but never claims the key is gone', () => {
    // `mcp get` is cwd-pinned, so "not found" only rules out user scope and this
    // directory — a local-scope entry added elsewhere is invisible. Saying "removed"
    // flat out is what left a plaintext key behind.
    for (const run of [
      { success: true },
      { success: false, message: 'No MCP server named "runpod" in user scope' },
    ]) {
      const out = interpretRemoveResult(run, {
        configPath: TEST_CONFIG_PATH,
        userScope: false,
        localScopeDirs: [],
      });
      assert.equal(out.success, true, JSON.stringify(run));
      // Scoped to what was actually established: the user config was read and has no
      // entry. No claim about project-scope .mcp.json files, which this never touches.
      assert.match(out.message ?? '', /your user config/);
    }
  });

  it('is a success that names the other scope when one remains there', () => {
    // The user-scope removal did happen, so this is not a failure — but the key is not
    // gone, and only naming the scope makes that actionable.
    const out = interpretRemoveResult(
      { success: true },
      {
        configPath: TEST_CONFIG_PATH,
        userScope: false,
        localScopeDirs: ['/home/dev/projA'],
      },
      '/usr/bin/claude'
    );
    assert.equal(out.success, true);
    assert.match(out.message ?? '', /local-scope/);
    assert.match(out.message ?? '', /--scope local/);
  });

  it('reports a genuine failure as a failure', () => {
    // A permissions error, a crash, a missing binary — none of these removed
    // anything, and an inconclusive probe must not upgrade them to success.
    for (const message of [
      'EACCES: permission denied, open ~/.claude.json',
      'claude exited with code 3',
      'killed by SIGKILL',
      'spawnSync claude ENOENT',
    ]) {
      assert.deepEqual(
        interpretRemoveResult(
          { success: false, message },
          {
            configPath: TEST_CONFIG_PATH,
            userScope: undefined,
            localScopeDirs: [],
          }
        ),
        { success: false, message },
        message
      );
    }
  });

  it('flags an unverifiable success rather than claiming a clean one', () => {
    const out = interpretRemoveResult(
      { success: true },
      { configPath: TEST_CONFIG_PATH, userScope: undefined, localScopeDirs: [] }
    );
    assert.equal(out.success, true);
    assert.match(out.message ?? '', /could not be read to confirm it/);
  });

  it('keeps a refusal a failure and never claims to have verified it', () => {
    const refusal = {
      success: false,
      refused: true,
      message: 'running claude.cmd means going through cmd.exe …',
    };
    assert.deepEqual(
      interpretRemoveResult(refusal, {
        configPath: TEST_CONFIG_PATH,
        userScope: undefined,
        localScopeDirs: [],
      }),
      refusal
    );
  });
});

describe('interpretAddResult', () => {
  // Same root cause as the removal case: with an unwritable config the CLI prints
  // "Added stdio MCP server runpod …" and exits 0 having written nothing (observed,
  // claude 2.1.220). A bare exit code reports a configuration that does not exist.
  it('fails when nothing is registered afterwards, despite a zero exit', () => {
    const out = interpretAddResult(
      { success: true },
      { configPath: TEST_CONFIG_PATH, userScope: false, localScopeDirs: [] }
    );
    assert.equal(out.success, false);
    assert.match(out.message ?? '', /not writable/);
    assert.match(out.message ?? '', /Nothing was configured/);
  });

  it('does not fail an add just because a local-scope entry also exists', () => {
    // The mirror of the round-6 blocker. `claude mcp get` reports only the WINNING
    // scope and local shadows user, so keying off it announced "nothing was configured"
    // for a key that HAD just been written — for anyone who had ever run plain
    // `claude mcp add runpod` in that directory. The user scope is the only thing that
    // answers whether OUR write landed.
    const out = interpretAddResult(
      { success: true },
      {
        configPath: TEST_CONFIG_PATH,
        userScope: true,
        localScopeDirs: ['/home/dev/projA'],
      }
    );
    assert.equal(out.success, true, out.message);
  });

  it('passes a verified success through, caveat and all', () => {
    assert.deepEqual(
      interpretAddResult(
        { success: true, message: 'already configured' },
        { configPath: TEST_CONFIG_PATH, userScope: true, localScopeDirs: [] }
      ),
      { success: true, message: 'already configured' }
    );
  });

  it('does not upgrade a failure or a refusal', () => {
    const failure = { success: false, message: 'boom' };
    assert.deepEqual(
      interpretAddResult(failure, {
        configPath: TEST_CONFIG_PATH,
        userScope: true,
        localScopeDirs: [],
      }),
      failure
    );
    const refusal = { success: false, refused: true, message: 'declined' };
    assert.deepEqual(
      interpretAddResult(refusal, {
        configPath: TEST_CONFIG_PATH,
        userScope: undefined,
        localScopeDirs: [],
      }),
      refusal
    );
  });

  it('accepts an unverifiable success but says it is unconfirmed', () => {
    // Failing closed would break every user whose config cannot be parsed, for a
    // problem that may not exist — but a bare success leaves them no way to know the
    // write went unconfirmed. The remove path says so, and the changeset claims both
    // paths do, so both must.
    const out = interpretAddResult(
      { success: true },
      { configPath: TEST_CONFIG_PATH, userScope: undefined, localScopeDirs: [] }
    );
    assert.equal(out.success, true);
    assert.match(out.message ?? '', /could not read/);
    assert.match(out.message ?? '', /confirm the entry landed/);
  });
});

describe('redactSecret', () => {
  // The shape-based redaction cannot cover output produced by another program, and the
  // claude CLI does echo -e tokens back on some errors.
  it('strips every occurrence of the key from CLI output', () => {
    const out = redactSecret(
      'Invalid environment variable format: RUNPOD_API_KEY_rpa_SECRET123456 (rpa_SECRET123456)',
      'rpa_SECRET123456'
    );
    assert.equal(out.includes('rpa_SECRET123456'), false, out);
    assert.match(out, /YOUR_RUNPOD_API_KEY/);
  });

  it('is a no-op without a secret, or for one too short to be a key', () => {
    assert.equal(redactSecret('nothing to do'), 'nothing to do');
    // Guard against a short value turning every message into placeholder soup.
    assert.equal(redactSecret('a b a b', 'a'), 'a b a b');
  });
});

describe('describeCommand', () => {
  // Shown to the user when we decline to shell out for a .cmd. Display only — it is
  // never executed — but it has to be correct enough to paste.
  it('quotes only what needs quoting', () => {
    assert.equal(
      describeCommand('C:\\Program Files\\nodejs\\claude.cmd', [
        'mcp',
        'add',
        'runpod',
      ]),
      '"C:\\Program Files\\nodejs\\claude.cmd" mcp add runpod'
    );
  });

  it('leaves a metacharacter-bearing value intact rather than mangling it', () => {
    // The raw renderer does not redact — describeCommandRedacted is what user-facing
    // messages go through.
    assert.match(
      describeCommand('claude.cmd', ['-e', 'RUNPOD_API_KEY=rpa_x&whoami']),
      /RUNPOD_API_KEY=rpa_x&whoami/
    );
  });
});

describe('describeCommandRedacted', () => {
  // Whatever the wizard prints lands in terminal scrollback, and in a support thread
  // or CI log as soon as someone pastes it. The one thing that must not appear there
  // is the key itself.
  it('replaces the API key with a placeholder', () => {
    const rendered = describeCommandRedacted('C:\\npm\\claude.cmd', [
      'mcp',
      'add',
      'runpod',
      '--scope',
      'user',
      '-e',
      'RUNPOD_API_KEY=rpa_LIVESECRET123',
      '--',
      'npx',
      '-y',
      '@runpod/mcp-server@latest',
    ]);
    assert.equal(rendered.includes('rpa_LIVESECRET123'), false, rendered);
    assert.match(rendered, /-e RUNPOD_API_KEY=YOUR_RUNPOD_API_KEY/);
    // The placeholder must not itself carry cmd.exe metacharacters: this string is
    // printed for a user to paste into cmd.exe, and the old `<your-api-key>` form
    // parsed as stdin redirection. It has to survive the module's own guard.
    assert.equal(/[<>]/.test(rendered), false, rendered);
    assert.equal(
      argsSafeForCmdShell(['RUNPOD_API_KEY=YOUR_RUNPOD_API_KEY']),
      true
    );
    // Everything else still pastes.
    assert.match(rendered, /mcp add runpod --scope user/);
    assert.match(rendered, /-- npx -y @runpod\/mcp-server@latest/);
  });

  it('leaves a hosted-mode command untouched', () => {
    // No key in that flow — OAuth handles auth.
    const args = ['mcp', 'add', '--transport', 'http', 'runpod', 'https://x/'];
    assert.equal(
      describeCommandRedacted('claude', args),
      describeCommand('claude', args)
    );
  });
});

// The claims above about .cmd and spaces are Windows-only behaviour, so this suite
// exercises them for real instead of asserting what Node would do. It runs on the
// windows-latest CI leg and is skipped everywhere else.
describe(
  'runClaude against a real .cmd shim',
  { skip: process.platform === 'win32' ? false : 'Windows-only behaviour' },
  () => {
    // A directory whose name contains a space, because that is the second half of
    // the documented failure: "if the script filename contains spaces it needs to
    // be quoted". Under the previous hand-rolled cmd.exe wrapper this combination
    // failed outright.
    const dirs: string[] = [];
    after(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    function shimDir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod mcp '));
      dirs.push(dir);
      // Records argv to a FILE rather than stdout, because runClaude pipes stdout
      // away. Asserting the round-trip against a second, direct crossSpawn.sync call
      // would test cross-spawn instead of the wrapper: runClaude could drop or
      // reorder every argument and the assertion would still pass.
      fs.writeFileSync(
        path.join(dir, 'record-argv.js'),
        'const fs = require("fs"), path = require("path");\n' +
          'fs.writeFileSync(path.join(__dirname, "argv.json"), JSON.stringify(process.argv.slice(2)));\n'
      );
      return dir;
    }

    // Shaped like npm's generated global shim: a .cmd that re-expands %* into a
    // node invocation. That second expansion is why the metacharacter guard exists.
    function writeShim(dir: string, body: string): string {
      const shim = path.join(dir, 'claude.cmd');
      fs.writeFileSync(shim, `@ECHO off\r\n${body}\r\n`);
      return shim;
    }

    function recordingShim(dir: string): string {
      return writeShim(dir, `"${process.execPath}" "%~dp0record-argv.js" %*`);
    }

    function recordedArgv(dir: string): string[] | null {
      const file = path.join(dir, 'argv.json');
      return fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[])
        : null;
    }

    it('launches a .cmd from a path with a space and round-trips argv', () => {
      const dir = shimDir();
      const shim = recordingShim(dir);
      // The argv the wizard ACTUALLY sends, `-e KEY=value` pair and `--` separator
      // included. A simplified argv would miss a regression mangling exactly the parts
      // at risk in the %* double-parse.
      const args = [
        'mcp',
        'add',
        'runpod',
        '--scope',
        'user',
        '-e',
        'RUNPOD_API_KEY=rpa_ABC123def456',
        '--',
        'npx',
        '-y',
        '@runpod/mcp-server@latest',
      ];
      const result = runClaude(shim, args);
      assert.equal(result.success, true, result.message);
      // What the child actually received, through runClaude and nothing else.
      assert.deepEqual(recordedArgv(dir), args);
    });

    it('treats "already exists" on a non-zero exit as success, with a caveat', () => {
      const dir = shimDir();
      const shim = writeShim(
        dir,
        'echo MCP server runpod already exists in user config 1>&2\r\nexit /b 1'
      );
      const result = runClaude(shim, ['mcp', 'add', 'runpod']);
      assert.equal(result.success, true);
      // The caveat is load-bearing: the CLI does NOT update an existing entry, so a
      // bare success would hide a stale API key after a rotation.
      assert.match(result.message ?? '', /entry left unchanged/);
    });

    it('reports a genuine non-zero exit as a failure', () => {
      const dir = shimDir();
      const shim = writeShim(dir, 'echo boom 1>&2\r\nexit /b 3');
      const result = runClaude(shim, ['mcp', 'remove', 'runpod']);
      assert.equal(result.success, false);
      assert.match(result.message ?? '', /boom/);
    });

    it('refuses a metacharacter-bearing argument without running the shim', () => {
      const dir = shimDir();
      const shim = recordingShim(dir);
      const result = runClaude(shim, ['-e', 'RUNPOD_API_KEY=rpa_x&whoami']);
      assert.equal(result.success, false);
      assert.equal(result.refused, true);
      // The point of the refusal: the child never ran, so nothing was recorded.
      assert.equal(recordedArgv(dir), null);
      // And the printed command names the variable without its value.
      assert.match(result.message ?? '', /RUNPOD_API_KEY=YOUR_RUNPOD_API_KEY/);
      assert.equal(/rpa_x&whoami/.test(result.message ?? ''), false);
      // The whole message is meant to be pasted into cmd.exe, so it must not carry
      // redirection operators of its own — the earlier `<your-api-key>` placeholder
      // did, in the one message that only ever appears on the cmd.exe path.
      assert.equal(/[<>]/.test(result.message ?? ''), false, result.message);
    });
  }
);

// ---- the Claude Code client's own add/remove wiring ----
// `interpretRemoveResult` is pinned above, but nothing exercised the CLIENT that calls
// it — and `remove()` is the function that shipped a false success in three
// consecutive revisions (a bare catch, then a discarded flag, then a scope-blind
// "nothing to remove"). A revision that stops routing through the helper, or re-adds a
// catch, would pass every other test in this file.
//
// The binary is INJECTED, not planted on PATH. findClaudeBinary probes
// ~/.claude/local/claude, /usr/local/bin/claude and /opt/homebrew/bin/claude before
// consulting PATH, so a PATH-based harness would run the contributor's REAL claude —
// executing `mcp remove --scope user runpod` against their live config — on any
// machine with a native-installer or Homebrew install. CI could never catch that,
// since clean runner images have none of those paths.
describe(
  'claudeCodeClient wiring (injected fake binary)',
  { skip: process.platform === 'win32' ? 'POSIX-only harness' : false },
  () => {
    const dirs: string[] = [];
    after(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    // `behaviour` is a sh case body keyed on "$1 $2" (e.g. "mcp remove"). The config
    // state is injected rather than scripted through the CLI, for two reasons: the real
    // signal IS the config file, and a test must never read the developer's own.
    function fakeClaude(
      behaviour: string,
      state: {
        configPath: string;
        userScope: boolean | undefined;
        localScopeDirs: string[];
      } = {
        configPath: TEST_CONFIG_PATH,
        userScope: false,
        localScopeDirs: [],
      }
    ) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-fake-claude-'));
      dirs.push(dir);
      const bin = path.join(dir, 'claude');
      fs.writeFileSync(bin, `#!/bin/sh\ncase "$1 $2" in\n${behaviour}\nesac\n`);
      fs.chmodSync(bin, 0o755);
      return createClaudeCodeClient(
        () => bin,
        () => state
      );
    }

    it('fails a removal the entry survives in user scope', async () => {
      // Unwritable config: the CLI says it removed the entry and exits 0, and the
      // config still has the user-scope entry.
      const client = fakeClaude(
        `'mcp remove') echo 'Removed MCP server runpod from user config'; exit 0;;\n` +
          `*) exit 1;;`,
        { configPath: TEST_CONFIG_PATH, userScope: true, localScopeDirs: [] }
      );
      const result = await client.remove();
      assert.equal(result.success, false, JSON.stringify(result));
      assert.match(result.message ?? '', /still on disk/);
    });

    it('succeeds but names local-scope entries left behind', async () => {
      // `claude mcp add` defaults to LOCAL scope; this removes USER scope. The
      // user-scope removal genuinely happened, so this is NOT a failure — but a
      // local-scope entry elsewhere holds its own key, and reading the config
      // enumerates those across EVERY directory, not just this one.
      const client = fakeClaude(
        `'mcp remove') echo 'Removed MCP server runpod from user config'; exit 0;;\n` +
          `*) exit 1;;`,
        {
          configPath: TEST_CONFIG_PATH,
          userScope: false,
          localScopeDirs: ['/home/dev/projA'],
        }
      );
      const result = await client.remove();
      assert.equal(result.success, true, JSON.stringify(result));
      assert.match(result.message ?? '', /local-scope/);
      assert.match(result.message ?? '', /projA/);
      assert.match(result.message ?? '', /--scope local/);
    });

    it('fails a removal when a user entry is SHADOWED by a local one', async () => {
      // The round-6 blocker. `claude mcp get` reports only the winning scope and local
      // shadows user, so a scope-string probe saw "local" and concluded user scope was
      // clean — announcing "removed from user config" while the key was still there.
      // Reading the config sees both independently.
      const client = fakeClaude(
        `'mcp remove') echo 'Removed MCP server runpod from user config'; exit 0;;\n` +
          `*) exit 1;;`,
        {
          configPath: TEST_CONFIG_PATH,
          userScope: true,
          localScopeDirs: ['/home/dev/projA'],
        }
      );
      const result = await client.remove();
      assert.equal(result.success, false, JSON.stringify(result));
      assert.match(result.message ?? '', /STILL in Claude Code's user config/);
    });

    it('never claims the key is gone, only that nothing is visible from here', async () => {
      // THE round-5 blocker. `mcp get` is cwd-pinned: a local-scope entry added in a
      // DIFFERENT directory is invisible, so exit 1 does not mean the key is off disk.
      // Claiming "nothing to remove" here is what left a plaintext key behind.
      const client = fakeClaude(
        `'mcp remove') echo 'No MCP server named "runpod" in user scope' 1>&2; exit 1;;\n` +
          `*) exit 1;;`,
        { configPath: TEST_CONFIG_PATH, userScope: false, localScopeDirs: [] }
      );
      const result = await client.remove();
      assert.equal(result.success, true, JSON.stringify(result));
      assert.match(
        result.message ?? '',
        /nothing to remove in your user config/
      );
    });

    it('fails an add whose entry is absent afterwards', async () => {
      const client = fakeClaude(
        `'mcp add') echo 'Added stdio MCP server runpod'; exit 0;;\n` +
          `*) exit 1;;`,
        { configPath: TEST_CONFIG_PATH, userScope: false, localScopeDirs: [] }
      );
      const result = await client.add({
        kind: 'local',
        apiKey: 'rpa_TESTKEY123456',
      });
      assert.equal(result.success, false, JSON.stringify(result));
      assert.match(result.message ?? '', /not writable/);
    });

    it('accepts an add even when a local-scope entry also exists', async () => {
      // The mirror of the round-6 blocker: keying off `mcp get`'s winning scope
      // reported "nothing was configured" for a key that HAD just been written,
      // whenever the user had ever run plain `claude mcp add runpod` in that directory.
      const client = fakeClaude(
        `'mcp add') echo 'Added stdio MCP server runpod to user config'; exit 0;;\n` +
          `*) exit 1;;`,
        {
          configPath: TEST_CONFIG_PATH,
          userScope: true,
          localScopeDirs: ['/home/dev/projA'],
        }
      );
      const result = await client.add({
        kind: 'local',
        apiKey: 'rpa_TESTKEY123456',
      });
      assert.equal(result.success, true, JSON.stringify(result));
    });

    it('accepts an add verified in user scope', async () => {
      const client = fakeClaude(
        `'mcp add') echo 'Added stdio MCP server runpod to user config'; exit 0;;\n` +
          `*) exit 1;;`,
        { configPath: TEST_CONFIG_PATH, userScope: true, localScopeDirs: [] }
      );
      const result = await client.add({
        kind: 'local',
        apiKey: 'rpa_TESTKEY123456',
      });
      assert.equal(result.success, true, JSON.stringify(result));
    });

    it('never echoes the API key in a failure message', async () => {
      const client = fakeClaude(
        `'mcp add') echo "Invalid environment variable format: RUNPOD_API_KEY=rpa_TESTKEY123456" 1>&2; exit 1;;\n` +
          `*) exit 1;;`,
        { configPath: TEST_CONFIG_PATH, userScope: false, localScopeDirs: [] }
      );
      const result = await client.add({
        kind: 'local',
        apiKey: 'rpa_TESTKEY123456',
      });
      assert.equal(result.success, false);
      assert.equal(
        result.message?.includes('rpa_TESTKEY123456'),
        false,
        result.message
      );
      assert.match(result.message ?? '', /YOUR_RUNPOD_API_KEY/);
    });
  }
);
describe('readClaudeConfigState', () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function configWith(contents: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-claude-cfg-'));
    dirs.push(dir);
    const file = path.join(dir, '.claude.json');
    if (contents !== null) fs.writeFileSync(file, contents);
    return file;
  }

  it('reads the user scope from top-level mcpServers', () => {
    // `--scope user` writes exactly one place, verified against claude 2.1.220.
    const present = configWith('{"mcpServers":{"runpod":{"command":"npx"}}}');
    assert.deepEqual(readClaudeConfigState(present), {
      configPath: present,
      userScope: true,
      localScopeDirs: [],
    });
    const absent = configWith('{"mcpServers":{"other":{}}}');
    assert.deepEqual(readClaudeConfigState(absent), {
      configPath: absent,
      userScope: false,
      localScopeDirs: [],
    });
  });

  it('sees a user entry even when a local one shadows it', () => {
    // THE round-6 blocker: `claude mcp get` prints only `Scope: Local config` here,
    // while both keys are on disk. Reading the file sees both independently.
    const state = readClaudeConfigState(
      configWith(
        JSON.stringify({
          mcpServers: { runpod: { command: 'npx' } },
          projects: {
            '/home/dev/projA': { mcpServers: { runpod: { command: 'npx' } } },
          },
        })
      )
    );
    assert.equal(state.userScope, true);
    assert.deepEqual(state.localScopeDirs, ['/home/dev/projA']);
  });

  it('enumerates local-scope entries across every directory, not just cwd', () => {
    // The gap the cwd-pinned probe could never close: an entry added in another
    // project is invisible to `mcp get` but plainly present in this file.
    const state = readClaudeConfigState(
      configWith(
        JSON.stringify({
          mcpServers: {},
          projects: {
            '/a': { mcpServers: { runpod: {} } },
            '/b': { mcpServers: { other: {} } },
            '/c': { mcpServers: { runpod: {} } },
            '/d': {},
          },
        })
      )
    );
    assert.equal(state.userScope, false);
    assert.deepEqual(state.localScopeDirs, ['/a', '/c']);
  });

  it('treats a missing config as definitely no user entry', () => {
    const missing = configWith(null);
    assert.deepEqual(readClaudeConfigState(missing), {
      configPath: missing,
      userScope: false,
      localScopeDirs: [],
    });
  });

  it('reports unknown rather than guessing for an unparseable config', () => {
    // Saying "absent" here would let a caller announce a key is gone from a file it
    // could not read. Unknown is the only honest answer.
    for (const contents of ['{"mcpServers": {', 'not json', '']) {
      assert.equal(
        readClaudeConfigState(configWith(contents)).userScope,
        undefined,
        JSON.stringify(contents)
      );
    }
  });

  it('tolerates comments, trailing commas and a BOM', () => {
    // Claude Code's config is JSONC-ish in practice, and Windows editors add BOMs.
    const state = readClaudeConfigState(
      configWith('\uFEFF{\n  // mine\n  "mcpServers": { "runpod": {} },\n}\n')
    );
    assert.equal(state.userScope, true);
  });

  it('does not mistake a non-object mcpServers for an entry', () => {
    assert.equal(
      readClaudeConfigState(configWith('{"mcpServers": "runpod"}')).userScope,
      false
    );
    assert.equal(
      readClaudeConfigState(configWith('[1,2,3]')).userScope,
      undefined
    );
  });
});

describe('upsertJsonServer validity guard', () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function configIn(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-json-cfg-'));
    dirs.push(dir);
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, contents);
    return file;
  }

  const entry = {
    command: 'npx',
    args: ['-y', '@runpod/mcp-server@latest'],
    env: { RUNPOD_API_KEY: 'rpa_GUARDKEY123456' },
  };

  it('accepts a config with a UTF-8 BOM', () => {
    // PowerShell's Set-Content and Notepad both write BOMs by default, on the platform
    // this wizard targets, and the clients strip them happily — but jsonc reports
    // InvalidSymbol at offset 0. Refusing here would be a new hard failure where the
    // previous revision succeeded.
    const file = configIn('\uFEFF{\n  "mcpServers": {}\n}\n');
    const result = upsertJsonServer(file, 'mcpServers', entry);
    assert.equal(result.success, true, result.message);
    const written = fs.readFileSync(file, 'utf8');
    assert.match(written, /rpa_GUARDKEY123456/);
    // The BOM must be GONE from what was written, not merely ignored while checking.
    // JSON.parse throws on a leading BOM, and Cursor / Windsurf / Claude Desktop are
    // Node/Electron apps doing exactly that — so leaving it would report success for a
    // config the client silently never loads.
    assert.equal(written.charCodeAt(0) === 0xfeff, false);
    assert.doesNotThrow(() => JSON.parse(written));
  });

  it('refuses a config that would still not parse afterwards', () => {
    // jsonc best-effort inserts into a broken file and hands back something still
    // unparseable, which the client then silently never loads. Reporting that as
    // configured is the same class of lie as a false success anywhere else here.
    const file = configIn('{"mcpServers": {"other": {},\n');
    const result = upsertJsonServer(file, 'mcpServers', entry);
    assert.equal(result.success, false);
    assert.match(result.message ?? '', /not valid JSON/);
    // The broken file is left exactly as it was — the key is not written into it.
    assert.equal(fs.readFileSync(file, 'utf8').includes('rpa_'), false);
  });

  it('accepts comments and trailing commas, which these configs legitimately carry', () => {
    const file = configIn('{\n  // mine\n  "mcpServers": {},\n}\n');
    assert.equal(upsertJsonServer(file, 'mcpServers', entry).success, true);
  });

  it('creates a new config, 0600 where the platform has POSIX modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-json-new-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'mcp.json');
    // Also covers creating missing parent directories.
    assert.equal(upsertJsonServer(file, 'mcpServers', entry).success, true);
    assert.match(fs.readFileSync(file, 'utf8'), /rpa_GUARDKEY123456/);
    if (process.platform === 'win32') {
      // Windows has no POSIX mode bits — node reports 0666 and only the read-only
      // flag is real, so the mode argument cannot protect the file there. Access is
      // governed by the ACL on the user profile directory instead. Asserting 0600
      // here would be asserting something the platform does not implement.
      return;
    }
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('argsSafeForCmdShell whitespace coverage', () => {
  // CMD_META gained \t and \v alongside \r\n; npm's own escaper quotes on all four.
  it('rejects tab and vertical tab', () => {
    assert.equal(argsSafeForCmdShell(['-e', 'RUNPOD_API_KEY=rpa_a\tb']), false);
    assert.equal(argsSafeForCmdShell(['-e', 'RUNPOD_API_KEY=rpa_a\vb']), false);
  });
});

describe('claudeUserConfigPath env handling', () => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  after(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  });

  it('honours CLAUDE_CONFIG_DIR when set', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'cfgdir');
    assert.equal(
      claudeUserConfigPath(),
      path.join(os.tmpdir(), 'cfgdir', '.claude.json')
    );
  });

  it('treats an EMPTY CLAUDE_CONFIG_DIR as unset, never as a relative path', () => {
    // `??` let '' through and path.join('', '.claude.json') yields the RELATIVE
    // '.claude.json'. Reading that as a definite "no user-scope entry" is how a green
    // tick got printed over a key still on disk — the same false-success class as every
    // other blocker on this branch, arriving through an env var this time. The real CLI
    // treats an empty value as unset, so these must agree.
    process.env.CLAUDE_CONFIG_DIR = '';
    const resolved = claudeUserConfigPath();
    assert.equal(path.isAbsolute(resolved), true, resolved);
    assert.equal(resolved, path.join(os.homedir(), '.claude.json'));
  });

  it('reports unknown for a non-absolute config path rather than "absent"', () => {
    // Defence in depth behind the fix above: whatever produces a relative path, it is
    // never the file the CLI would use, so answering "no entry" from it is a guess.
    assert.equal(readClaudeConfigState('.claude.json').userScope, undefined);
    assert.equal(
      readClaudeConfigState('relative/dir/.claude.json').userScope,
      undefined
    );
  });
});

describe('absoluteEnvDir', () => {
  // Three environment variables have now produced the same defect: an empty or relative
  // value yielding a path that resolves against the CURRENT DIRECTORY. Every consumer
  // here either writes a plaintext API key to that path or spawns it, so the rule lives
  // in one function with its own tests rather than being re-derived per variable.
  const fallback = () => '/fallback';

  it('treats unset, empty and whitespace as unset', () => {
    for (const value of [undefined, '', '   ', '\t']) {
      assert.equal(absoluteEnvDir(value, fallback), '/fallback', String(value));
    }
  });

  it('treats a RELATIVE value as unset', () => {
    // The XDG spec says relative values "should be considered invalid and ignored", and
    // the reason generalises: `.config` would put the key under ./config/… wherever the
    // wizard was launched.
    for (const value of ['.', './cfg', 'cfg', 'relative/dir', '..']) {
      assert.equal(absoluteEnvDir(value, fallback), '/fallback', value);
    }
  });

  it('accepts an absolute value in either path flavour', () => {
    assert.equal(absoluteEnvDir('/abs/dir', fallback), '/abs/dir');
    // win32-absolute must be accepted even when running on POSIX, since this module
    // computes Windows paths on any host.
    assert.equal(
      absoluteEnvDir('C:\\Users\\dev\\AppData\\Roaming', fallback),
      'C:\\Users\\dev\\AppData\\Roaming'
    );
    assert.equal(
      absoluteEnvDir('\\\\server\\share', fallback),
      '\\\\server\\share'
    );
  });
});

describe('config paths never resolve against the current directory', () => {
  const saved = {
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('APPDATA="" does not produce a relative Claude Code candidate', () => {
    // `npm\\claude.cmd` is probed BEFORE the PATH lookup and resolved against cwd, so a
    // planted file there would have been spawned with `-e RUNPOD_API_KEY=<live key>`.
    // pickClaudeBinary's cwd-deprioritisation does not cover candidates.
    for (const appdata of ['', '   ', 'npm-relative']) {
      for (const candidate of claudeCandidatePaths(
        'win32',
        'C:\\Users\\dev',
        appdata
      )) {
        assert.equal(
          path.win32.isAbsolute(candidate),
          true,
          `${JSON.stringify(appdata)} -> ${candidate}`
        );
      }
    }
  });

  it('APPDATA="" does not produce a relative Claude Desktop config path', () => {
    // Harm here is a plaintext API key written into ./Claude/ and reported as ✓.
    process.env.APPDATA = '';
    const p = claudeDesktopConfigPath();
    assert.equal(path.isAbsolute(p) || path.win32.isAbsolute(p), true, p);
  });

  it('a relative XDG_CONFIG_HOME does not leak the key into the cwd', () => {
    // `||` fixed empty; a relative value still yielded ./Claude/... until absoluteEnvDir.
    for (const value of ['', '.config', './cfg']) {
      process.env.XDG_CONFIG_HOME = value;
      for (const p of [claudeDesktopConfigPath(), vsCodeConfigPath()]) {
        assert.equal(
          path.isAbsolute(p) || path.win32.isAbsolute(p),
          true,
          `${JSON.stringify(value)} -> ${p}`
        );
      }
    }
  });

  it('refuses to write or delete through a relative config path', () => {
    // The backstop: whatever computed the path, writing a credential to a relative
    // target is never right. This closes the class for every client at once.
    const write = upsertJsonServer(
      'Claude/claude_desktop_config.json',
      'mcpServers',
      {
        env: { RUNPOD_API_KEY: 'rpa_MUSTNOTLAND' },
      }
    );
    assert.equal(write.success, false);
    assert.match(write.message ?? '', /absolute path/);
    assert.equal(fs.existsSync('Claude/claude_desktop_config.json'), false);
  });
});
