import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  claudeCandidatePaths,
  claudeLookupCommand,
  pickClaudeBinary,
  isDirectlySpawnable,
  describeCommand,
} from '../src/install/clients.js';

// Regression coverage for issue #56 — the install wizard never detected Claude Code
// on Windows. The platform-dependent decisions are pure functions, so both branches
// run on any host with no spawning and no faking of process.platform.
//
// Caveat worth knowing: these cover the *decisions*, not the spawn. `runClaude`
// itself is only meaningfully testable on a Windows runner, which CI does not have.

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
        // Native installer — a real .exe, spawnable with no shell. First on
        // purpose; it also covers installs whose PATH entry is missing, which the
        // lookup could never find.
        'C:\\Users\\John Doe\\.local\\bin\\claude.exe',
        // npm -g shim. Last: a .cmd needs a shell, which runClaude refuses to use.
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
  it('prefers a directly-spawnable .exe over a .cmd shim', () => {
    // The .exe launches with no shell. Preferring the .cmd would force the shell
    // path for no reason — and `remove` can only spawn the .exe.
    const stdout =
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd\r\n' +
      'C:\\Users\\dev\\.local\\bin\\claude.exe\r\n';
    assert.equal(
      pickClaudeBinary(stdout, 'win32'),
      'C:\\Users\\dev\\.local\\bin\\claude.exe'
    );
  });

  it('treats the extensionless hit as spawnable and prefers it over .cmd', () => {
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
    // Still returned, so detection reports "installed"; runClaude then declines to
    // shell out and prints the command instead.
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude.cmd\r\n', 'win32'),
      'C:\\bin\\claude.cmd'
    );
  });

  it('returns null on Windows for empty output', () => {
    // A bare 'claude' would be useless there: execFileSync has no shell to
    // resolve it against.
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
    // still means "found" on POSIX, where execFileSync resolves via PATH.
    assert.equal(pickClaudeBinary('', 'darwin'), 'claude');
  });
});

describe('isDirectlySpawnable', () => {
  // The load-bearing distinction: Node's execFile uses no shell, so a .cmd/.bat
  // cannot be launched at all. Everything else can, with argv preserved exactly —
  // which is what keeps the API key out of a parsed command line.
  it('rejects .cmd and .bat, case-insensitively', () => {
    for (const p of [
      'C:\\npm\\claude.cmd',
      'C:\\npm\\claude.CMD',
      'C:\\npm\\claude.bat',
    ]) {
      assert.equal(isDirectlySpawnable(p), false, p);
    }
  });

  it('accepts .exe, extensionless, and POSIX paths', () => {
    for (const p of [
      'C:\\Users\\dev\\.local\\bin\\claude.exe',
      'C:\\bin\\claude',
      '/opt/homebrew/bin/claude',
      'claude',
    ]) {
      assert.equal(isDirectlySpawnable(p), true, p);
    }
  });

  it('is not fooled by cmd appearing elsewhere in the path', () => {
    assert.equal(isDirectlySpawnable('C:\\cmd\\tools\\claude.exe'), true);
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
    // Exactly the value that would have been split into a second command had this
    // been routed through cmd.exe. Here it is only ever printed.
    assert.match(
      describeCommand('claude.cmd', ['-e', 'RUNPOD_API_KEY=rpa_x&whoami']),
      /RUNPOD_API_KEY=rpa_x&whoami/
    );
  });
});
