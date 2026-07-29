import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
  claudeCandidatePaths,
  claudeLookupCommand,
  pickClaudeBinary,
  needsManualWindowsSetup,
} from '../src/install/clients.js';

// Regression coverage for issue #56: the install wizard never detected Claude
// Code on Windows. The platform-dependent decisions are pure functions so both
// branches run on any host — no spawning, no faking process.platform.

describe('claudeLookupCommand', () => {
  it('uses where.exe on Windows, not the POSIX shell builtin', () => {
    // `command -v` is a shell builtin; execSync on Windows goes through cmd.exe,
    // which has no such builtin, so it exited non-zero whether or not Claude Code
    // was installed. That is the whole bug.
    assert.equal(claudeLookupCommand('win32'), 'where.exe claude');
  });

  it('uses `where.exe`, never bare `where`', () => {
    // PowerShell aliases `where` to Where-Object, which would hang or misbehave.
    assert.match(claudeLookupCommand('win32'), /where\.exe/);
  });

  it('keeps command -v on POSIX platforms', () => {
    for (const platform of ['darwin', 'linux', 'freebsd']) {
      assert.equal(claudeLookupCommand(platform), 'command -v claude');
    }
  });
});

describe('claudeCandidatePaths', () => {
  it('probes Windows locations on win32, none of them POSIX absolute paths', () => {
    const paths = claudeCandidatePaths(
      'win32',
      'C:\\Users\\dev',
      'C:\\Users\\dev\\AppData\\Roaming'
    );
    assert.ok(paths.length > 0);
    // The old list was /usr/local/bin/claude etc., which can never exist on
    // Windows — every candidate must be rooted in the user's profile/APPDATA.
    for (const p of paths) {
      assert.equal(
        p.startsWith('/'),
        false,
        `POSIX path leaked into the Windows candidates: ${p}`
      );
    }
  });

  it('includes the npm global .cmd shim from APPDATA', () => {
    const paths = claudeCandidatePaths(
      'win32',
      'C:\\Users\\dev',
      'C:\\Users\\dev\\AppData\\Roaming'
    );
    assert.ok(
      paths.some((p) => p.endsWith(path.join('npm', 'claude.cmd'))),
      `expected an npm/claude.cmd candidate, got ${JSON.stringify(paths)}`
    );
  });

  it('falls back to a derived AppData path when APPDATA is unset', () => {
    const paths = claudeCandidatePaths('win32', 'C:\\Users\\dev', undefined);
    assert.ok(
      paths.some((p) => p.includes('AppData') && p.endsWith('claude.cmd'))
    );
  });

  it('keeps the original POSIX candidates unchanged', () => {
    const paths = claudeCandidatePaths('darwin', '/Users/dev');
    assert.deepEqual(paths, [
      '/Users/dev/.claude/local/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ]);
  });
});

describe('pickClaudeBinary', () => {
  it('prefers the .cmd shim when where.exe returns several hits', () => {
    // execFileSync cannot spawn the extensionless file on Windows — only the
    // .cmd shim is executable — so the order where.exe prints them in matters.
    const stdout =
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude\r\n' +
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd\r\n';
    assert.equal(
      pickClaudeBinary(stdout, 'win32'),
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd'
    );
  });

  it('matches .CMD case-insensitively', () => {
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude\r\nC:\\bin\\CLAUDE.CMD\r\n', 'win32'),
      'C:\\bin\\CLAUDE.CMD'
    );
  });

  it('handles CRLF line endings', () => {
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude.cmd\r\n', 'win32'),
      'C:\\bin\\claude.cmd'
    );
  });

  it('falls back to the first hit when no .cmd is present', () => {
    assert.equal(
      pickClaudeBinary('C:\\bin\\claude.exe\r\n', 'win32'),
      'C:\\bin\\claude.exe'
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
    // still means "found" on POSIX, where execFileSync can resolve via PATH.
    assert.equal(pickClaudeBinary('', 'darwin'), 'claude');
  });
});

describe('needsManualWindowsSetup', () => {
  // The API key travels in argv. Going through cmd.exe (required to spawn a .cmd)
  // reintroduces two characters that quoting does not neutralise, so refuse
  // rather than write a mangled key into the user's config.
  it('flags % and ^, which cmd.exe alters even inside quotes', () => {
    assert.equal(needsManualWindowsSetup(['RUNPOD_API_KEY=ab%PATH%cd']), true);
    assert.equal(needsManualWindowsSetup(['RUNPOD_API_KEY=ab^cd']), true);
  });

  it('accepts characters that are inert once quoted', () => {
    for (const key of ['ab&cd', 'ab|cd', 'ab<cd', 'ab>cd', 'a b']) {
      assert.equal(
        needsManualWindowsSetup([`RUNPOD_API_KEY=${key}`]),
        false,
        `should not have flagged ${key}`
      );
    }
  });

  it('accepts a normal Runpod key and the surrounding argv', () => {
    assert.equal(
      needsManualWindowsSetup([
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
      false
    );
  });
});
