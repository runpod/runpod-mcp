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
  CLIENTS,
} from '../src/install/clients.js';

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
      const out = interpretRemoveResult(run, true, '/usr/bin/claude');
      assert.equal(out.success, false, JSON.stringify(run));
      assert.match(out.message ?? '', /still on disk/);
      // Actionable: names both causes and how to check.
      assert.match(out.message ?? '', /scope/);
      assert.match(out.message ?? '', /mcp get runpod/);
    }
  });

  it('is a success only when the entry is verifiably gone', () => {
    assert.deepEqual(interpretRemoveResult({ success: true }, false), {
      success: true,
      message: undefined,
    });
    // Nothing in user scope AND nothing anywhere else — the desired end state.
    assert.deepEqual(
      interpretRemoveResult(
        {
          success: false,
          message: 'No MCP server named "runpod" in user scope',
        },
        false
      ),
      { success: true, message: 'nothing to remove' }
    );
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
        interpretRemoveResult({ success: false, message }, undefined),
        { success: false, message },
        message
      );
    }
  });

  it('flags an unverifiable success rather than claiming a clean one', () => {
    const out = interpretRemoveResult({ success: true }, undefined);
    assert.equal(out.success, true);
    assert.match(out.message ?? '', /could not be verified/);
  });

  it('keeps a refusal a failure and never claims to have verified it', () => {
    const refusal = {
      success: false,
      refused: true,
      message: 'running claude.cmd means going through cmd.exe …',
    };
    assert.deepEqual(interpretRemoveResult(refusal, undefined), refusal);
  });
});

describe('interpretAddResult', () => {
  // Same root cause as the removal case: with an unwritable config the CLI prints
  // "Added stdio MCP server runpod …" and exits 0 having written nothing (observed,
  // claude 2.1.220). A bare exit code reports a configuration that does not exist.
  it('fails when nothing is registered afterwards, despite a zero exit', () => {
    const out = interpretAddResult({ success: true }, false);
    assert.equal(out.success, false);
    assert.match(out.message ?? '', /not writable/);
    assert.match(out.message ?? '', /Nothing was configured/);
  });

  it('passes a verified success through, caveat and all', () => {
    assert.deepEqual(
      interpretAddResult(
        { success: true, message: 'already configured' },
        true
      ),
      { success: true, message: 'already configured' }
    );
  });

  it('does not upgrade a failure or a refusal', () => {
    const failure = { success: false, message: 'boom' };
    assert.deepEqual(interpretAddResult(failure, true), failure);
    const refusal = { success: false, refused: true, message: 'declined' };
    assert.deepEqual(interpretAddResult(refusal, undefined), refusal);
  });

  it('accepts an unverifiable success rather than failing a working install', () => {
    // Failing closed here would break every user whose probe cannot answer, for a
    // problem that may not exist. Direction chosen deliberately.
    assert.deepEqual(interpretAddResult({ success: true }, undefined), {
      success: true,
      message: undefined,
    });
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
// So this drives the real code path against a fake `claude` on PATH: candidate paths
// do not exist, `command -v claude` resolves to the fake, and both the operation and
// the verification probe hit it. POSIX-only — Windows resolution goes through
// where.exe and PATHEXT, which a shell script cannot stand in for.
describe(
  'claudeCodeClient wiring (fake claude on PATH)',
  { skip: process.platform === 'win32' ? 'POSIX-only harness' : false },
  () => {
    const dirs: string[] = [];
    const originalPath = process.env.PATH;
    after(() => {
      process.env.PATH = originalPath;
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    // `behaviour` is a sh case body keyed on "$1 $2" (e.g. "mcp remove").
    function fakeClaude(behaviour: string): void {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-fake-claude-'));
      dirs.push(dir);
      const bin = path.join(dir, 'claude');
      fs.writeFileSync(bin, `#!/bin/sh\ncase "$1 $2" in\n${behaviour}\nesac\n`);
      fs.chmodSync(bin, 0o755);
      process.env.PATH = `${dir}:${originalPath ?? ''}`;
    }

    function claudeCode() {
      const client = CLIENTS.find((c) => c.id === 'claude-code');
      assert.ok(client, 'claude-code client must be registered');
      return client;
    }

    it('reports a failure when the entry survives the removal', async () => {
      // The read-only-config case: the CLI says it removed the entry and exits 0,
      // and the probe then finds it still registered.
      fakeClaude(
        `'mcp remove') echo 'Removed MCP server runpod from user config'; exit 0;;\n` +
          `'mcp get') echo 'runpod:'; exit 0;;\n` +
          `*) exit 1;;`
      );
      const result = await claudeCode().remove();
      assert.equal(result.success, false, JSON.stringify(result));
      assert.match(result.message ?? '', /still on disk/);
    });

    it('reports a failure when the entry lives in another scope', async () => {
      // `claude mcp add` defaults to LOCAL scope; this removes from USER scope. The
      // CLI's "not in user scope" is true and useless — the key is still there.
      fakeClaude(
        `'mcp remove') echo 'No MCP server named \\"runpod\\" in user scope' 1>&2; exit 1;;\n` +
          `'mcp get') echo 'runpod:'; exit 0;;\n` +
          `*) exit 1;;`
      );
      const result = await claudeCode().remove();
      assert.equal(result.success, false, JSON.stringify(result));
      assert.match(result.message ?? '', /scope/);
    });

    it('succeeds when the entry is verifiably gone', async () => {
      fakeClaude(
        `'mcp remove') echo 'Removed MCP server runpod from user config'; exit 0;;\n` +
          `'mcp get') echo 'No MCP server named \\"runpod\\"' 1>&2; exit 1;;\n` +
          `*) exit 1;;`
      );
      const result = await claudeCode().remove();
      assert.equal(result.success, true, JSON.stringify(result));
    });

    it('treats nothing-to-remove as success only when nothing is registered', async () => {
      fakeClaude(
        `'mcp remove') echo 'No MCP server named \\"runpod\\" in user scope' 1>&2; exit 1;;\n` +
          `'mcp get') echo 'No MCP server named \\"runpod\\"' 1>&2; exit 1;;\n` +
          `*) exit 1;;`
      );
      const result = await claudeCode().remove();
      assert.deepEqual(result, {
        success: true,
        message: 'nothing to remove',
      });
    });

    it('fails an add whose entry is absent afterwards', async () => {
      // The unwritable-config case for add: exit 0, nothing written.
      fakeClaude(
        `'mcp add') echo 'Added stdio MCP server runpod'; exit 0;;\n` +
          `'mcp get') echo 'No MCP server named \\"runpod\\"' 1>&2; exit 1;;\n` +
          `*) exit 1;;`
      );
      const result = await claudeCode().add({
        kind: 'local',
        apiKey: 'rpa_TESTKEY123456',
      });
      assert.equal(result.success, false, JSON.stringify(result));
      assert.match(result.message ?? '', /not writable/);
    });

    it('never echoes the API key in a failure message', async () => {
      // The CLI does echo -e tokens back on some errors; the message a user sees must
      // not carry the key regardless of what the child printed.
      fakeClaude(
        `'mcp add') echo "Invalid environment variable format: RUNPOD_API_KEY=rpa_TESTKEY123456" 1>&2; exit 1;;\n` +
          `*) exit 1;;`
      );
      const result = await claudeCode().add({
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
