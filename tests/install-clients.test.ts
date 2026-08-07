import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'node:http';

import { verifyApiKey } from '../src/install/verify-key.js';
import {
  claudeCandidatePaths,
  pickClaudeBinary,
  describeCommand,
  describeCommandRedacted,
  interpretRemoveResult,
  interpretAddResult,
  redactSecret,
  runClaude,
  findClaudeBinary,
  createClaudeCodeClient,
  readClaudeConfigState,
  claudeUserConfigPath,
  absoluteEnvDir,
  claudeDesktopConfigPath,
  vsCodeConfigPath,
  upsertJsonServer,
  removeJsonServer,
  CLIENTS,
} from '../src/install/clients.js';

// A stand-in for the user config path in state literals. Never read: these suites
// exercise the interpretation, and the reader has its own suite.
const TEST_CONFIG_PATH = '/home/dev/.claude.json';
// Resolved binary the interpret helpers render remediation commands with. A real
// path, because a bare `claude` is exactly the bug this argument exists to fix.
const TEST_BINARY = '/opt/homebrew/bin/claude';

// Regression coverage for issue #56 — the install wizard never detected Claude Code
// on Windows. The platform-dependent decisions are pure functions, so both branches
// run on any host with no spawning and no faking of process.platform.
//
// The spawn itself cannot be faked that way, so the last suite here actually runs a
// `.cmd` shim from a directory whose name contains a space — the exact combination
// Node's docs call out as unlaunchable via execFile. It is skipped off Windows and
// runs on the windows-latest CI leg.

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
        // Native installer — a real .exe, launched with no shell.
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

  it('probes the POSIX native-installer location first, then the historic ones', () => {
    // ~/.local/bin/claude is where the current native installer puts it (verified on a
    // real install). Without it, POSIX detection relied entirely on PATH — and the same
    // "covers an install whose PATH entry is missing" reasoning already justified the
    // Windows .local\bin entry.
    assert.deepEqual(claudeCandidatePaths('darwin', '/Users/dev'), [
      '/Users/dev/.local/bin/claude',
      '/Users/dev/.claude/local/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ]);
  });
});

describe('pickClaudeBinary', () => {
  it('never trusts Windows lookup output', () => {
    // Windows detection probes only documented user-level install locations.
    // PATH is project-influenced under npm/npx, and even the lookup executable
    // itself can be shadowed from cwd.
    assert.equal(
      pickClaudeBinary(
        'C:\\bin\\claude.exe\r\nC:\\npm\\claude.cmd\r\n',
        'win32'
      ),
      null
    );
  });

  it('returns the resolved POSIX path from command -v', () => {
    assert.equal(
      pickClaudeBinary('/opt/homebrew/bin/claude\n', 'darwin'),
      '/opt/homebrew/bin/claude'
    );
  });

  it('does not turn an empty lookup into a second unverified PATH resolution', () => {
    assert.equal(pickClaudeBinary('', 'darwin'), null);
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
      assert.match(out.message ?? '', /user config/);
      // The diagnosis must match what actually happened: "the CLI reports success
      // anyway" is only true when the run DID report success. With a failed run it used
      // to print that sentence anyway and swallow the real error — an ENOENT on the
      // binary was reported as an unwritable config.
      if (run.success) {
        assert.match(out.message ?? '', /not writable/);
      } else {
        assert.match(out.message ?? '', /removal command itself failed/);
        assert.match(out.message ?? '', new RegExp(run.message ?? ''));
      }
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
      { configPath: TEST_CONFIG_PATH, userScope: false, localScopeDirs: [] },
      TEST_BINARY
    );
    assert.equal(out.success, false);
    assert.match(out.message ?? '', /not writable/);
    assert.match(out.message ?? '', /Nothing was configured/);
  });

  it('names a local-scope entry that will shadow the write', () => {
    // THE round-8 blocker. Local scope takes precedence over user scope, so in those
    // directories the entry just written is INERT and Claude Code keeps using the local
    // one — with its own, possibly revoked, key. The reader collects localScopeDirs
    // precisely because of that shadowing, and the add path ignored it while the remove
    // path reported it. The `already exists` caveat cannot cover this: `mcp add --scope
    // user` exits 0 when a local entry is present, because the collision is per-scope.
    const out = interpretAddResult(
      { success: true },
      {
        configPath: TEST_CONFIG_PATH,
        userScope: true,
        localScopeDirs: ['/home/dev/projA'],
      },
      TEST_BINARY
    );
    // Still a success — the user-scope write did land.
    assert.equal(out.success, true);
    assert.match(out.message ?? '', /takes precedence/);
    assert.match(out.message ?? '', /projA/);
    assert.match(out.message ?? '', /--scope local/);
    // Names the binary that was actually found, not a bare `claude`. The candidate
    // paths exist precisely for installs that are not on PATH, so remediation advice
    // that assumes PATH fails for exactly the users the lookup was added to serve —
    // and this newest branch was the one hardcoding it.
    assert.match(out.message ?? '', /\/opt\/homebrew\/bin\/claude mcp remove/);
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
      },
      TEST_BINARY
    );
    assert.equal(out.success, true, out.message);
  });

  it('passes a verified success through, caveat and all', () => {
    assert.deepEqual(
      interpretAddResult(
        { success: true, message: 'already configured' },
        { configPath: TEST_CONFIG_PATH, userScope: true, localScopeDirs: [] },
        TEST_BINARY
      ),
      { success: true, message: 'already configured' }
    );
  });

  it('does not upgrade a failure or a refusal', () => {
    const failure = { success: false, message: 'boom' };
    assert.deepEqual(
      interpretAddResult(
        failure,
        { configPath: TEST_CONFIG_PATH, userScope: true, localScopeDirs: [] },
        TEST_BINARY
      ),
      failure
    );
    const refusal = { success: false, refused: true, message: 'declined' };
    assert.deepEqual(
      interpretAddResult(
        refusal,
        {
          configPath: TEST_CONFIG_PATH,
          userScope: undefined,
          localScopeDirs: [],
        },
        TEST_BINARY
      ),
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
      {
        configPath: TEST_CONFIG_PATH,
        userScope: undefined,
        localScopeDirs: [],
      },
      TEST_BINARY
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

  it('is a no-op without a secret', () => {
    assert.equal(redactSecret('nothing to do'), 'nothing to do');
  });

  it('redacts even a short rejected value', () => {
    // The wizard permits a user to continue with any non-empty rejected input.
    // Length is therefore not a safe proxy for whether output may reveal a secret.
    assert.equal(
      redactSecret('invalid value x appeared twice: x', 'x'),
      'invalid value YOUR_RUNPOD_API_KEY appeared twice: YOUR_RUNPOD_API_KEY'
    );
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
    // parsed as stdin redirection.
    assert.equal(/[<>]/.test(rendered), false, rendered);
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

// Windows npm registration bypasses claude.cmd and invokes the entrypoint declared by
// the installed package. Current Claude Code releases declare bin/claude.exe, which
// postinstall replaces with the platform-native binary. This suite models that exact
// manifest/layout on windows-latest, including a space-containing npm root and
// poisoned shell variables.
describe(
  'runClaude against a Windows npm-global install',
  { skip: process.platform === 'win32' ? false : 'Windows-only behaviour' },
  () => {
    const dirs: string[] = [];
    after(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    function installDir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod mcp '));
      dirs.push(dir);
      return dir;
    }

    function writeInstall(dir: string, source?: string): string {
      const packageDir = path.join(
        dir,
        'node_modules',
        '@anthropic-ai',
        'claude-code'
      );
      const binDir = path.join(packageDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@anthropic-ai/claude-code',
          version: '2.1.212',
          bin: { claude: 'bin/claude.exe' },
        })
      );
      const nativeBinary = path.join(binDir, 'claude.exe');
      try {
        fs.linkSync(process.execPath, nativeBinary);
      } catch {
        fs.copyFileSync(process.execPath, nativeBinary);
      }
      const argvFile = path.join(dir, 'argv.json');
      fs.writeFileSync(
        path.join(dir, 'mcp'),
        source ??
          `const fs = require("fs"); const path = require("path"); fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify([path.basename(process.argv[1]), ...process.argv.slice(2)]));\n`
      );
      const shim = path.join(dir, 'claude.cmd');
      fs.writeFileSync(
        shim,
        `@ECHO off\r\nECHO shim-ran>"${path.join(dir, 'shim-ran')}"\r\n`
      );
      return shim;
    }

    async function inInstallDir<T>(
      dir: string,
      action: () => T | Promise<T>
    ): Promise<T> {
      const previous = process.cwd();
      process.chdir(dir);
      try {
        return await action();
      } finally {
        process.chdir(previous);
      }
    }

    function recordedArgv(dir: string): string[] | null {
      const file = path.join(dir, 'argv.json');
      return fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[])
        : null;
    }

    it('discovers the standard npm-global install and registers with it', async () => {
      const home = installDir();
      const appdata = path.join(home, 'AppData', 'Roaming');
      const npmDir = path.join(appdata, 'npm');
      fs.mkdirSync(npmDir, { recursive: true });
      const shim = writeInstall(npmDir);
      const safeCwd = installDir();
      const binary = findClaudeBinary({ homedir: home, appdata, cwd: safeCwd });
      // Windows temp paths may arrive in 8.3 short form (`RUNNER~1`) while the
      // production trust check intentionally returns the canonical long path.
      assert.equal(binary, fs.realpathSync.native(shim));

      const client = createClaudeCodeClient(
        () => binary,
        () => ({
          configPath: 'C:\\Users\\dev\\.claude.json',
          userScope: true,
          localScopeDirs: [],
        })
      );
      const result = await inInstallDir(npmDir, () =>
        client.add({
          kind: 'local',
          apiKey: 'rpa_ABC123def456',
        })
      );
      assert.equal(result.success, true, result.message);
      assert.deepEqual(recordedArgv(npmDir), [
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
      ]);
      assert.equal(fs.existsSync(path.join(npmDir, 'shim-ran')), false);
    });

    it('ignores project PATH, COMSPEC, and Node injection variables', async () => {
      const npmDir = installDir();
      const shim = writeInstall(npmDir);
      const poisonDir = installDir();
      const nodeOptionsMarker = path.join(poisonDir, 'node-options-ran');
      const hook = path.join(poisonDir, 'hook.cjs');
      fs.writeFileSync(
        hook,
        `require("fs").writeFileSync(${JSON.stringify(nodeOptionsMarker)}, "poisoned");\n`
      );
      const saved = {
        PATH: process.env.PATH,
        comspec: process.env.comspec,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        NODE_PATH: process.env.NODE_PATH,
      };
      process.env.PATH = poisonDir;
      process.env.comspec = path.join(poisonDir, 'fake-comspec.exe');
      process.env.NODE_OPTIONS = `--require=${hook}`;
      process.env.NODE_PATH = poisonDir;
      try {
        const args = ['mcp', 'add', 'runpod', '-e', 'RUNPOD_API_KEY=rpa_x&y'];
        const result = await inInstallDir(npmDir, () => runClaude(shim, args));
        assert.equal(result.success, true, result.message);
        assert.deepEqual(recordedArgv(npmDir), args);
        assert.equal(fs.existsSync(path.join(npmDir, 'shim-ran')), false);
        assert.equal(fs.existsSync(nodeOptionsMarker), false);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it('does not detect a project-local PATH shim', () => {
      const project = installDir();
      const localBin = path.join(project, 'node_modules', '.bin');
      fs.mkdirSync(localBin, { recursive: true });
      const shim = writeInstall(localBin);
      const originalPath = process.env.PATH;
      process.env.PATH = localBin;
      try {
        const binary = findClaudeBinary({
          homedir: path.join(project, 'empty-home'),
          appdata: path.join(project, 'empty-appdata'),
          cwd: project,
        });
        assert.equal(binary, null);
        assert.equal(
          fs.existsSync(path.join(path.dirname(shim), 'shim-ran')),
          false
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it('detects the npm install when %USERPROFILE% itself carries project markers', async () => {
      // A stray package.json in the profile directory — one accidental `npm install`
      // in home — must not turn %USERPROFILE% into a "project" that rejects both
      // standard candidates, which live beneath it.
      const home = installDir();
      fs.writeFileSync(path.join(home, 'package.json'), '{}\n');
      const appdata = path.join(home, 'AppData', 'Roaming');
      const npmDir = path.join(appdata, 'npm');
      fs.mkdirSync(npmDir, { recursive: true });
      const shim = writeInstall(npmDir);
      const binary = findClaudeBinary({ homedir: home, appdata, cwd: home });
      assert.equal(binary, fs.realpathSync.native(shim));
    });

    it('rejects redirected APPDATA and a standard-path junction outside the profile', () => {
      const home = installDir();
      const safeCwd = installDir();
      const redirectedAppdata = installDir();
      const redirectedNpm = path.join(redirectedAppdata, 'npm');
      fs.mkdirSync(redirectedNpm);
      writeInstall(redirectedNpm);
      assert.equal(
        findClaudeBinary({
          homedir: home,
          appdata: redirectedAppdata,
          cwd: safeCwd,
        }),
        null
      );

      const defaultAppdata = path.join(home, 'AppData', 'Roaming');
      fs.mkdirSync(defaultAppdata, { recursive: true });
      const outsideNpm = installDir();
      writeInstall(outsideNpm);
      fs.symlinkSync(outsideNpm, path.join(defaultAppdata, 'npm'), 'junction');
      assert.equal(
        findClaudeBinary({
          homedir: home,
          appdata: defaultAppdata,
          cwd: safeCwd,
        }),
        null
      );
    });

    it('requires the installed package entrypoint beside the shim', () => {
      const dir = installDir();
      const shim = path.join(dir, 'claude.cmd');
      fs.writeFileSync(shim, '@ECHO off\r\n');
      const result = runClaude(shim, ['mcp', 'add', 'runpod']);
      assert.equal(result.success, false);
      assert.equal(result.refused, true);
      assert.match(result.message ?? '', /trusted Claude Code npm entrypoint/);
    });

    it('keeps the existing-entry caveat and real failures', async () => {
      const existingDir = installDir();
      const existing = writeInstall(
        existingDir,
        'console.error("MCP server runpod already exists in user config"); process.exit(1);\n'
      );
      const existingResult = await inInstallDir(existingDir, () =>
        runClaude(existing, ['mcp', 'add', 'runpod'])
      );
      assert.equal(existingResult.success, true);
      assert.match(existingResult.message ?? '', /entry left unchanged/);

      const failingDir = installDir();
      const failing = writeInstall(
        failingDir,
        'console.error("boom"); process.exit(3);\n'
      );
      const failingResult = await inInstallDir(failingDir, () =>
        runClaude(failing, ['mcp', 'remove', 'runpod'])
      );
      assert.equal(failingResult.success, false);
      assert.match(failingResult.message ?? '', /boom/);
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
    // Checked as a STRICT client, which is where a surviving BOM is actually fatal.
    const result = upsertJsonServer(file, 'mcpServers', entry, 'json');
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
    const result = upsertJsonServer(file, 'mcpServers', entry, 'jsonc');
    assert.equal(result.success, false);
    assert.match(result.message ?? '', /could not be parsed/);
    // Says it was already broken, because that changes the advice.
    assert.match(result.message ?? '', /before this change either/);
    // The broken file is left exactly as it was — the key is not written into it.
    assert.equal(fs.readFileSync(file, 'utf8').includes('rpa_'), false);
  });

  it('refuses comments and trailing commas for a JSON.parse client', () => {
    // Claude Desktop reads its config with a bare JSON.parse and no retry, so a comment
    // or trailing comma is fatal there. Validating as JSONC reported "✓ configured" for
    // a file it silently never loads — the same defect the BOM had, in this same
    // function. (NOT true of Cursor, which despite being an Electron app keeps its
    // VS Code parent's tolerance — see the per-client wiring suite.)
    for (const contents of [
      '{\n  // mine\n  "mcpServers": {}\n}\n',
      '{\n  "mcpServers": {},\n}\n',
      '{\n  /* block */\n  "mcpServers": {}\n}\n',
    ]) {
      const file = configIn(contents);
      const result = upsertJsonServer(file, 'mcpServers', entry, 'json');
      assert.equal(result.success, false, contents);
      assert.equal(fs.readFileSync(file, 'utf8').includes('rpa_'), false);
    }
  });

  it('accepts comments and trailing commas for the one client that reads JSONC', () => {
    // VS Code's mcp.json genuinely is JSONC, and refusing there would be a new hard
    // failure for a config it loads fine.
    const file = configIn('{\n  // mine\n  "servers": {},\n}\n');
    const result = upsertJsonServer(file, 'servers', entry, 'jsonc');
    assert.equal(result.success, true, result.message);
    assert.match(fs.readFileSync(file, 'utf8'), /rpa_GUARDKEY123456/);
  });

  it('writes a config every client can parse when it started clean', () => {
    const file = configIn('{ "mcpServers": {} }');
    assert.equal(
      upsertJsonServer(file, 'mcpServers', entry, 'json').success,
      true
    );
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  });

  it('creates a new config, 0600 where the platform has POSIX modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-json-new-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'mcp.json');
    // Also covers creating missing parent directories.
    assert.equal(
      upsertJsonServer(file, 'mcpServers', entry, 'json').success,
      true
    );
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

describe('pickClaudeBinary rejects relative POSIX hits', () => {
  it('never returns a cwd-relative path from the PATH lookup', () => {
    // Whatever this returns is spawned with `-e RUNPOD_API_KEY=<live key>`, so a
    // relative path hands the key to whatever file sits in the current directory. The
    // candidate loop guards against exactly this and says so; the POSIX branch returned
    // hits[0] unchecked.
    //
    // Reachable: with `.` on PATH, `command -v claude` prints `./claude` under dash,
    // bash and zsh — and on Linux /bin/sh IS dash, the shell execSync uses. Verified:
    //   PATH=".:/usr/bin" dash -c 'command -v claude'  ->  ./claude
    // macOS /bin/sh absolutises it, which is why this reads as unreachable on a Mac.
    assert.equal(pickClaudeBinary('./claude\n', 'linux', '/work'), null);
    assert.equal(pickClaudeBinary('claude\n', 'linux', '/work'), null);
    // An absolute hit later in the list is preferred over a relative one first.
    assert.equal(
      pickClaudeBinary('./claude\n/usr/local/bin/claude\n', 'linux', '/work'),
      '/usr/local/bin/claude'
    );
    // The ordinary case is unchanged.
    assert.equal(
      pickClaudeBinary('/usr/local/bin/claude\n', 'linux', '/work'),
      '/usr/local/bin/claude'
    );
  });

  it('rejects cwd descendants and node_modules bins', () => {
    assert.equal(
      pickClaudeBinary(
        '/work/project/tools/claude\n/usr/local/bin/claude\n',
        'linux',
        '/work/project'
      ),
      '/usr/local/bin/claude'
    );
    assert.equal(
      pickClaudeBinary(
        '/work/project/node_modules/.bin/claude\n',
        'linux',
        '/work/project/packages/app'
      ),
      null
    );
  });
});

describe(
  'findClaudeBinary POSIX trust boundary',
  { skip: process.platform === 'win32' ? 'POSIX-only behaviour' : false },
  () => {
    const dirs: string[] = [];
    after(() => {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a repository tool reached through an outside symlink', () => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-project-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-alias-'));
      dirs.push(project, outside);
      fs.mkdirSync(path.join(project, '.git'));
      const app = path.join(project, 'packages', 'app');
      const tools = path.join(project, 'tools');
      const emptyHome = path.join(outside, 'empty-home');
      fs.mkdirSync(app, { recursive: true });
      fs.mkdirSync(tools, { recursive: true });
      fs.mkdirSync(emptyHome);
      const projectClaude = path.join(tools, 'claude');
      fs.writeFileSync(projectClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.symlinkSync(projectClaude, path.join(outside, 'claude'));

      const originalPath = process.env.PATH;
      process.env.PATH = [outside, '/usr/bin', '/bin'].join(path.delimiter);
      try {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: emptyHome,
            cwd: app,
          }),
          null
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it('rejects a direct user-level candidate symlinked into the project', () => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-project-'));
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-home-'));
      dirs.push(project, fakeHome);
      fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
      const app = path.join(project, 'packages', 'app');
      const tools = path.join(project, 'tools');
      const userBin = path.join(fakeHome, '.local', 'bin');
      fs.mkdirSync(app, { recursive: true });
      fs.mkdirSync(tools, { recursive: true });
      fs.mkdirSync(userBin, { recursive: true });
      const projectClaude = path.join(tools, 'claude');
      fs.writeFileSync(projectClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.symlinkSync(projectClaude, path.join(userBin, 'claude'));

      const originalPath = process.env.PATH;
      process.env.PATH = ['/usr/bin', '/bin'].join(path.delimiter);
      try {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: fakeHome,
            cwd: app,
          }),
          null
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it('rejects a sibling PATH tool in a source archive without .git', () => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-archive-'));
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-home-'));
      dirs.push(project, emptyHome);
      fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
      const app = path.join(project, 'packages', 'app');
      const bin = path.join(project, 'bin');
      fs.mkdirSync(app, { recursive: true });
      fs.mkdirSync(bin);
      const projectClaude = path.join(bin, 'claude');
      fs.writeFileSync(projectClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const originalPath = process.env.PATH;
      process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
      try {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: emptyHome,
            cwd: app,
          }),
          null
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it('still detects the native install when $HOME itself carries project markers', () => {
      // $HOME is routinely "marked": a stray package.json from an accidental
      // `npm install` in home, or a dotfiles .git. Treating home as a project boundary
      // rejected every candidate beneath it — including ~/.local/bin/claude itself —
      // so the wizard reported Claude Code not found on exactly the standard installs
      // it probes for, from any cwd under home. Same class as #56, opposite direction.
      const markedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-home-'));
      dirs.push(markedHome);
      fs.writeFileSync(path.join(markedHome, 'package.json'), '{}\n');
      fs.mkdirSync(path.join(markedHome, '.git'));
      const userBin = path.join(markedHome, '.local', 'bin');
      fs.mkdirSync(userBin, { recursive: true });
      const claude = path.join(userBin, 'claude');
      fs.writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // From $HOME itself, and from an unmarked directory beneath it.
      const sub = path.join(markedHome, 'notes', 'scratch');
      fs.mkdirSync(sub, { recursive: true });
      for (const cwd of [markedHome, sub]) {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: markedHome,
            cwd,
          }),
          fs.realpathSync.native(claude),
          `cwd=${cwd}`
        );
      }
    });

    it('still rejects a project symlink when the project sits under a marked $HOME', () => {
      // The cap must remove only the home-level false boundary, not the guard: a
      // marked project BELOW home is still a boundary, so a user-level candidate that
      // canonically resolves into it stays untrusted.
      const markedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-home-'));
      dirs.push(markedHome);
      fs.mkdirSync(path.join(markedHome, '.git'));
      const project = path.join(markedHome, 'Desktop', 'proj');
      fs.mkdirSync(path.join(project, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
      const projectClaude = path.join(project, 'tools', 'claude');
      fs.writeFileSync(projectClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const userBin = path.join(markedHome, '.local', 'bin');
      fs.mkdirSync(userBin, { recursive: true });
      fs.symlinkSync(projectClaude, path.join(userBin, 'claude'));

      const originalPath = process.env.PATH;
      process.env.PATH = ['/usr/bin', '/bin'].join(path.delimiter);
      try {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: markedHome,
            cwd: project,
          }),
          null
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it('accepts a version-manager PATH hit from a marked $HOME', () => {
      // nvm/asdf/Volta live under home. With home treated as a boundary, the PATH
      // fallback rejected them whenever the wizard ran from home — the exact case the
      // "unmarked cwd is not a project root" rule was written to keep working.
      const markedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-home-'));
      dirs.push(markedHome);
      fs.writeFileSync(path.join(markedHome, 'package.json'), '{}\n');
      const nvmBin = path.join(markedHome, '.nvm', 'current', 'bin');
      fs.mkdirSync(nvmBin, { recursive: true });
      const claude = path.join(nvmBin, 'claude');
      fs.writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const originalPath = process.env.PATH;
      process.env.PATH = [nvmBin, '/usr/bin', '/bin'].join(path.delimiter);
      try {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: markedHome,
            cwd: markedHome,
          }),
          fs.realpathSync.native(claude)
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it('falls through to the PATH lookup when no home directory is resolvable', () => {
      // os.userInfo() throws for a process UID with no passwd entry
      // (arbitrary-UID containers, some CI sandboxes). That only makes the
      // home-anchored candidates unavailable — the `command -v` fallback needs no
      // homedir, and returning early instead regressed those environments from
      // working (on main) to undetectable. homedir: null is the sentinel that catch
      // produces.
      const globalRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'runpod-global-')
      );
      dirs.push(globalRoot);
      const bin = path.join(globalRoot, 'bin');
      fs.mkdirSync(bin);
      const globalClaude = path.join(bin, 'claude');
      fs.writeFileSync(globalClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const originalPath = process.env.PATH;
      process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
      try {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: null,
            cwd: globalRoot,
          }),
          fs.realpathSync.native(globalClaude)
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it('accepts a canonical global PATH hit when no project boundary exists', () => {
      const workspace = fs.mkdtempSync(
        path.join(os.tmpdir(), 'runpod-unmarked-')
      );
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-home-'));
      const globalRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'runpod-global-')
      );
      const app = path.join(workspace, 'packages', 'app');
      const bin = path.join(globalRoot, 'bin');
      dirs.push(workspace, emptyHome, globalRoot);
      fs.mkdirSync(app, { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      const globalClaude = path.join(bin, 'claude');
      fs.writeFileSync(globalClaude, '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });

      const originalPath = process.env.PATH;
      process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
      try {
        assert.equal(
          findClaudeBinary({
            platform: process.platform,
            homedir: emptyHome,
            cwd: app,
          }),
          fs.realpathSync.native(globalClaude)
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });
  }
);

describe('describeCommand quoting', () => {
  it('quotes cmd.exe metacharacters, not just whitespace', () => {
    // This renders the command printed when the wizard REFUSES to spawn because an
    // argument holds a metacharacter. Quoting on whitespace alone handed the user a
    // command broken by that same character: cmd.exe splits `&b=2` into a second
    // command, so the remediation for an unsafe argument was itself unsafe.
    const rendered = describeCommand('C:\\npm\\claude.cmd', [
      'mcp',
      'add',
      'runpod',
      'https://mcp.example/?a=1&b=2',
    ]);
    assert.match(rendered, /"https:\/\/mcp\.example\/\?a=1&b=2"/);
    // Plain arguments stay unquoted, so the common case still reads cleanly.
    assert.match(rendered, /claude\.cmd mcp add runpod /);
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

  it('resolves a RELATIVE CLAUDE_CONFIG_DIR the way the CLI does', () => {
    // Not treated as unset, unlike the empty value above, and deliberately NOT routed
    // through absoluteEnvDir: the CLI honours a relative value, resolved against the
    // cwd. Verified live — `CLAUDE_CONFIG_DIR=relcfg claude mcp add … --scope user`
    // prints `File modified: relcfg/.claude.json` and creates ./relcfg. Reading
    // $HOME/.claude.json instead would report a definite verdict about a file the CLI
    // never touched.
    //
    // Round 9: mutating `path.resolve(configured)` to `configured` left the suite green,
    // because the only test supplied an already-absolute path, where resolve is a no-op.
    process.env.CLAUDE_CONFIG_DIR = 'relcfg';
    const resolved = claudeUserConfigPath();
    assert.equal(path.isAbsolute(resolved), true, resolved);
    assert.equal(resolved, path.resolve('relcfg', '.claude.json'));
  });

  it('reports unknown for a non-absolute config path rather than "absent"', () => {
    // Defence in depth behind the fix above. A relative path CAN be the one the CLI
    // uses (see the resolve test above), so the reader cannot know which file it names
    // — and answering "no entry" from a path it cannot place is a guess either way.
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
    // `npm\\claude.cmd` is a direct Windows candidate. If it were relative, a planted
    // file in cwd would receive the live API key before any safe fallback decision.
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
      { env: { RUNPOD_API_KEY: 'rpa_MUSTNOTLAND' } },
      'json'
    );
    assert.equal(write.success, false);
    assert.match(write.message ?? '', /absolute path/);
    assert.equal(fs.existsSync('Claude/claude_desktop_config.json'), false);
  });
});

// Every finding below was live on a pushed, fully green, four-leg-CI revision. Each
// mutation named is one that survived the suite as it then stood.
describe('per-client config dialect wiring', () => {
  const dialectOf = (id: string) => CLIENTS.find((c) => c.id === id)?.dialect;

  // THE round-9 blocker, pointed the opposite way to every earlier one: not a failure
  // reported as success, but a WORKING config reported as broken. Cursor inherited a
  // shared `?? 'json'` default on the belief that "Electron app ⇒ JSON.parse". It is a
  // VS Code fork and its MCP reader keeps VS Code's tolerance:
  //   parseMcpServersFromFile → t$t(content)
  //   t$t = stripComments → JSON.parse, and on throw
  //         .replace(/,\s*([}\]])/g,'$1') → JSON.parse again
  // (Cursor.app workbench.desktop.main.js). So one comment in ~/.cursor/mcp.json made
  // the wizard refuse to write, tell the user their healthy config was unparseable and
  // that "this client would not load the entry", and leave Cursor unconfigured — where
  // the previous revision configured it. A regression, and the false premise was
  // asserted as verified fact in the changeset and the PR body, which a squash merge
  // writes into main's history.
  //
  // Asserted per client because that is the layer that was wrong. Mutating the wiring
  // back to a shared default left all 73 tests green: upsertJsonServer was only ever
  // called with an explicit dialect, so the mapping itself had zero coverage.
  it('classifies Cursor as lenient, because its shipped reader is', () => {
    assert.equal(dialectOf('cursor'), 'jsonc');
  });

  it('classifies Claude Desktop as strict, because its shipped reader is', () => {
    // wxr(): `JSON.parse(Et.readFileSync(t,'utf8'))` — no preprocessing, no retry
    // (Claude.app app.asar). Refusing a commented config here is correct.
    assert.equal(dialectOf('claude-desktop'), 'json');
  });

  it('classifies VS Code as lenient', () => {
    assert.equal(dialectOf('vscode'), 'jsonc');
  });

  it('does not claim to know how Windsurf parses', () => {
    // Not installed on any machine this was checked on, so its parser was never read.
    // Guessing is precisely what produced the Cursor blocker, and both guesses break a
    // user: too strict refuses a healthy config, too lenient reports success for a file
    // the client never loads. 'unverified' validates leniently — so a probably-fine
    // config is never refused — and discloses the reliance instead of asserting it.
    assert.equal(dialectOf('windsurf'), 'unverified');
  });

  it('gives every JSON-config client an explicit dialect', () => {
    // The default is what did the damage, so there is no longer one. This fails if a
    // client is added without stating how its config is parsed.
    for (const client of CLIENTS.filter((c) => c.id !== 'claude-code')) {
      assert.ok(client.dialect, `${client.id} has no dialect`);
    }
  });
});

describe('config edits land where the client actually reads', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const configIn = (contents: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-readback-'));
    dirs.push(dir);
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, contents);
    return file;
  };
  const entry = { command: 'npx', env: { RUNPOD_API_KEY: 'rpa_READBACK1' } };

  it('refuses when a duplicate key would send the write somewhere unread', () => {
    // Duplicate keys are legal JSON, so the validity check passes — but `jsonc.modify`
    // edits the FIRST occurrence and every parser here keeps the LAST. The entry landed
    // in a block nothing reads: a plaintext API key on disk, reported as configured,
    // with the client never seeing it.
    const file = configIn(
      '{"mcpServers":{"foo":{}},"mcpServers":{"bar":{}}}\n'
    );
    const result = upsertJsonServer(file, 'mcpServers', entry, 'json');
    assert.equal(result.success, false, result.message);
    assert.match(result.message ?? '', /does not read it/);
    assert.match(result.message ?? '', /more than once/);
    // And nothing was written — no stray key in an unread block.
    assert.equal(fs.readFileSync(file, 'utf8').includes('rpa_'), false);
  });

  it('does not report "nothing to remove" over an entry still on disk', () => {
    // The zero-edits path assumed absence. With a duplicate key the edit targets the
    // block WITHOUT the entry, producing zero edits while the block the client reads
    // still holds the key — mechanism #3's exact shape, on the cleanup path.
    const file = configIn(
      '{"mcpServers":{"other":{}},"mcpServers":{"runpod":{"command":"npx"}}}\n'
    );
    const result = removeJsonServer(file, 'mcpServers', 'json');
    assert.equal(result.success, false, result.message);
    assert.match(result.message ?? '', /still present/);
    assert.match(result.message ?? '', /by hand/);
  });

  it('leaves the original untouched when a surgical removal would corrupt it', () => {
    // A surgical delete leaves `{ , }` here. Verified taking a clean VS Code mcp.json to
    // one with a parse error while printing "✓ cleaned up". VS Code and Cursor both
    // happen to recover, but a strict client would stop loading every OTHER server in
    // the file — so it cannot be left behind.
    const file = configIn('{\n  "servers": {\n    "runpod": {},\n  }\n}\n');
    const original = fs.readFileSync(file, 'utf8');
    const before = removeJsonServer(file, 'servers', 'jsonc');
    assert.equal(before.success, false, before.message);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, original);
    assert.match(before.message ?? '', /left unchanged/);
    assert.match(before.message ?? '', /by hand/);
  });

  it('leaves an already malformed config untouched', () => {
    const file = configIn('{"mcpServers":{"runpod":{}}');
    const original = fs.readFileSync(file, 'utf8');
    const result = removeJsonServer(file, 'mcpServers', 'jsonc');
    assert.equal(result.success, false, result.message);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.match(result.message ?? '', /existing config is not valid/);
    assert.match(result.message ?? '', /left unchanged/);
  });

  it('leaves a comment-bearing config untouched when no repair is needed', () => {
    // The ordinary surgical edit must preserve unrelated comments.
    const file = configIn(
      '{\n  // keep me\n  "mcpServers": {\n    "runpod": {},\n    "other": {}\n  }\n}\n'
    );
    const result = removeJsonServer(file, 'mcpServers', 'jsonc');
    assert.equal(result.success, true, result.message);
    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /\/\/ keep me/);
    assert.equal(result.message, undefined);
  });

  it('discloses, rather than asserts, leniency for an unverified client', () => {
    // Windsurf: the entry is written (refusing would leave a probably-fine client
    // unconfigured) but the tick is qualified, because whether it accepts comments is
    // genuinely unknown.
    const file = configIn('{\n  // mine\n  "mcpServers": {}\n}\n');
    const result = upsertJsonServer(file, 'mcpServers', entry, 'unverified');
    assert.equal(result.success, true, result.message);
    assert.match(fs.readFileSync(file, 'utf8'), /rpa_READBACK1/);
    assert.match(result.message ?? '', /unverified/);
  });

  it('does not qualify a success for an unverified client with a plain config', () => {
    // The caveat must be earned by the file, not printed at every Windsurf user.
    const file = configIn('{\n  "mcpServers": {}\n}\n');
    const result = upsertJsonServer(file, 'mcpServers', entry, 'unverified');
    assert.equal(result.success, true, result.message);
    assert.equal(result.message, undefined);
  });

  it('refuses to delete through a relative config path', () => {
    // Round 9: mutating this guard to `if (false)` left the suite green. The existing
    // test was titled "write OR DELETE" but only ever exercised the write half —
    // removeJsonServer was not exported, so it had no coverage at all.
    const result = removeJsonServer('Claude/mcp.json', 'mcpServers', 'json');
    assert.equal(result.success, false);
    assert.match(result.message ?? '', /not an absolute path/);
  });
});

// ============== install wizard: key verification deadline ==============
// The wizard's own fetch, which does not go through createHttpClient and so
// needed its own deadline. Interactive code with no other test surface: the
// failure mode is a spinner that never resolves and no way out but ^C.
describe('verifyApiKey deadline', () => {
  // Bounded: without the deadline this hangs rather than fails, and node:test
  // has no default timeout.
  it(
    'reports a stalled host as "check failed" instead of hanging',
    { timeout: 5_000 },
    async (t) => {
      const stalled: http.ServerResponse[] = [];
      const server = http.createServer((_req, res) => {
        // Accept and go quiet — the shape node-fetch has no answer for.
        stalled.push(res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve())
      );
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const previous = process.env.RUNPOD_REST_API_URL;
      process.env.RUNPOD_REST_API_URL = `http://127.0.0.1:${address.port}/v1`;
      t.after(async () => {
        if (previous === undefined) delete process.env.RUNPOD_REST_API_URL;
        else process.env.RUNPOD_REST_API_URL = previous;
        for (const res of stalled) res.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      });

      const startedAt = Date.now();
      // null is the wizard's "could not check" verdict — it warns and lets the
      // user continue, which is right for a host that never answered.
      assert.equal(await verifyApiKey('rpa_test', 100), null);
      assert.ok(
        Date.now() - startedAt < 5_000,
        'the deadline did not end the stalled verification'
      );
    }
  );
});
