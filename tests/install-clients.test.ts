import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crossSpawn from 'cross-spawn';

import {
  claudeCandidatePaths,
  claudeLookupCommand,
  pickClaudeBinary,
  needsCmdShell,
  argsSafeForCmdShell,
  describeCommand,
  runClaude,
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

  it('falls back to the first hit when none is a .exe', () => {
    // Neither an extensionless path nor a .cmd avoids cmd.exe, so there is nothing
    // to prefer and the lookup's own order wins.
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude\r\nC:\\bin\\claude.cmd\r\n', 'win32'),
      'C:\\bin\\claude'
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
  // Mirrors cross-spawn's own rule (lib/parse.js `isExecutableRegExp`): on Windows
  // it spawns directly only for .com/.exe and wraps everything else in cmd.exe. If
  // this drifts from that, the guard below fires on the wrong cases.
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

  it('leaves a metacharacter-bearing key intact rather than mangling it', () => {
    // This is the refusal path's output: the value argsSafeForCmdShell rejected,
    // shown verbatim so the user can paste it into their own shell.
    assert.match(
      describeCommand('claude.cmd', ['-e', 'RUNPOD_API_KEY=rpa_x&whoami']),
      /RUNPOD_API_KEY=rpa_x&whoami/
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
    function shimDir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod mcp '));
      fs.writeFileSync(
        path.join(dir, 'print-argv.js'),
        'console.log(JSON.stringify(process.argv.slice(2)));\n'
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

    it('launches a .cmd from a path with a space and round-trips argv', () => {
      const dir = shimDir();
      const shim = writeShim(
        dir,
        `"${process.execPath}" "%~dp0print-argv.js" %*`
      );
      const args = ['mcp', 'add', 'runpod', '--scope', 'user'];
      const result = runClaude(shim, args);
      assert.equal(result.success, true, result.message);
      // runClaude swallows stdout, so re-run to inspect what the shim received.
      const echoed = crossSpawn.sync(shim, args, { encoding: 'utf8' });
      assert.deepEqual(JSON.parse(echoed.stdout.trim()), args);
    });

    it('treats "already exists" on a non-zero exit as success', () => {
      const dir = shimDir();
      const shim = writeShim(
        dir,
        'echo MCP server runpod already exists in user config 1>&2\r\nexit /b 1'
      );
      const result = runClaude(shim, ['mcp', 'add', 'runpod']);
      assert.deepEqual(result, {
        success: true,
        message: 'already configured',
      });
    });

    it('reports a genuine non-zero exit as a failure', () => {
      const dir = shimDir();
      const shim = writeShim(dir, 'echo boom 1>&2\r\nexit /b 3');
      const result = runClaude(shim, ['mcp', 'remove', 'runpod']);
      assert.equal(result.success, false);
      assert.match(result.message ?? '', /boom/);
    });

    it('refuses a metacharacter-bearing argument instead of escaping it', () => {
      const dir = shimDir();
      const shim = writeShim(
        dir,
        `"${process.execPath}" "%~dp0print-argv.js" %*`
      );
      const result = runClaude(shim, ['-e', 'RUNPOD_API_KEY=rpa_x&whoami']);
      assert.equal(result.success, false);
      assert.equal(result.refused, true);
      assert.match(result.message ?? '', /rpa_x&whoami/);
    });
  }
);
