import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseWizardArgs } from '#src/install/args';
import {
  CLIENTS,
  opencodeConfigPath,
  piMcpConfigPath,
} from '#src/install/clients';
import { runWizard } from '#src/install/wizard';

const IDS = CLIENTS.map((c) => c.id);

describe('parseWizardArgs', () => {
  it('reads comma-separated and repeated --client values, deduplicated, in order', () => {
    const args = parseWizardArgs(
      ['--client', 'opencode,pi', '-c', 'cursor', '--client=pi'],
      IDS
    );
    assert.deepEqual(args.errors, []);
    assert.deepEqual(args.clients, ['opencode', 'pi', 'cursor']);
  });

  it('rejects unknown clients, unknown options and a missing value', () => {
    assert.match(
      parseWizardArgs(['--client', 'nope'], IDS).errors[0],
      /unknown client "nope"/
    );
    assert.match(
      parseWizardArgs(['--yes'], IDS).errors[0],
      /unknown option "--yes"/
    );
    assert.match(
      parseWizardArgs(['--client', '--hosted'], IDS).errors[0],
      /needs a value/
    );
    assert.match(parseWizardArgs(['--client'], IDS).errors[0], /needs a value/);
  });

  it('refuses --hosted together with --local', () => {
    assert.match(
      parseWizardArgs(['--hosted', '--local'], IDS).errors[0],
      /cannot be combined/
    );
  });

  it('takes no API key from argv: there is no flag for one', () => {
    // A key on the command line lands in shell history and process listings.
    assert.match(
      parseWizardArgs(['--api-key', 'rpa_x'], IDS).errors[0],
      /unknown option/
    );
  });
});

describe('the wizard without a terminal', () => {
  const saved = {
    log: console.log,
    error: console.error,
  };
  let out: string[] = [];
  let err: string[] = [];
  before(() => {
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    console.error = (...a: unknown[]) => void err.push(a.join(' '));
  });
  after(() => {
    console.log = saved.log;
    console.error = saved.error;
  });

  it('fails with exit 2 instead of exiting 0 having written nothing', async () => {
    out = [];
    err = [];
    const code = await runWizard('add', [], false);
    assert.equal(code, 2);
    assert.match(err.join('\n'), /needs an interactive terminal/);
    assert.match(err.join('\n'), /Nothing was configured/);
    assert.match(err.join('\n'), /--client <ids>/);
  });

  it('answers --help with usage and exit 0', async () => {
    out = [];
    const code = await runWizard('add', ['--help'], false);
    assert.equal(code, 0);
    assert.match(out.join('\n'), /--client <ids>/);
  });

  it('exits 2 on bad usage', async () => {
    err = [];
    assert.equal(await runWizard('add', ['--client', 'nope'], false), 2);
    assert.match(err.join('\n'), /unknown client/);
  });

  it('--local without RUNPOD_API_KEY exits 2 and writes nothing', async () => {
    const savedKey = process.env.RUNPOD_API_KEY;
    const savedDir = process.env.PI_CODING_AGENT_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-'));
    delete process.env.RUNPOD_API_KEY;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      err = [];
      assert.equal(
        await runWizard('add', ['--client', 'pi', '--local'], false),
        2
      );
      assert.match(err.join('\n'), /RUNPOD_API_KEY/);
      assert.equal(fs.existsSync(path.join(dir, 'mcp.json')), false);
    } finally {
      if (savedKey === undefined) delete process.env.RUNPOD_API_KEY;
      else process.env.RUNPOD_API_KEY = savedKey;
      if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('configures and removes opencode and Pi with no prompts', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedDir = process.env.PI_CODING_AGENT_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-'));
    process.env.XDG_CONFIG_HOME = path.join(root, 'config');
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi');
    try {
      out = [];
      assert.equal(
        await runWizard('add', ['--client', 'opencode,pi'], false),
        0
      );
      const opencode = JSON.parse(
        fs.readFileSync(
          path.join(root, 'config', 'opencode', 'opencode.json'),
          'utf8'
        )
      );
      assert.deepEqual(opencode.mcp.runpod, {
        type: 'remote',
        url: 'https://mcp.runpod.io/',
        enabled: true,
      });
      const pi = JSON.parse(
        fs.readFileSync(path.join(root, 'pi', 'mcp.json'), 'utf8')
      );
      assert.deepEqual(pi.mcpServers.runpod, {
        url: 'https://mcp.runpod.io/',
      });
      assert.match(out.join('\n'), /opencode mcp auth runpod/);
      assert.match(out.join('\n'), /pi mcp login runpod/);

      assert.equal(
        await runWizard('remove', ['--client', 'opencode,pi'], false),
        0
      );
      const after = JSON.parse(
        fs.readFileSync(path.join(root, 'pi', 'mcp.json'), 'utf8')
      );
      assert.equal(after.mcpServers?.runpod, undefined);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('opencode and Pi config wiring', () => {
  const client = (id: string) => CLIENTS.find((c) => c.id === id)!;

  it('states the dialect each one was observed to parse', () => {
    // opencode 1.19.0 loaded a commented, trailing-comma opencode.json; Pi 1.2.0
    // refused a single comment. See ConfigDialect.
    assert.equal(client('opencode').dialect, 'jsonc');
    assert.equal(client('pi').dialect, 'json');
  });

  it('edits an existing opencode.jsonc in place, keeping its comments', async () => {
    const saved = process.env.XDG_CONFIG_HOME;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
    process.env.XDG_CONFIG_HOME = root;
    const file = path.join(root, 'opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '{\n  // keep me\n  "model": "x",\n  "mcp": { "other": { "type": "remote", "url": "https://o/" } },\n}\n'
    );
    try {
      assert.equal(opencodeConfigPath(), file);
      const result = await client('opencode').add({
        kind: 'local',
        apiKey: 'rpa_test',
      });
      assert.equal(result.success, true, result.message);
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /\/\/ keep me/);
      assert.match(text, /"other"/);
      assert.match(text, /"type": "local"/);
      assert.match(text, /"environment"/);
      assert.match(text, /"@runpod\/mcp-server@latest"/);
      assert.equal(
        fs.existsSync(path.join(root, 'opencode', 'opencode.json')),
        false
      );
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves PI_CODING_AGENT_DIR the way Pi does, and never against the cwd', async () => {
    const saved = process.env.PI_CODING_AGENT_DIR;
    try {
      delete process.env.PI_CODING_AGENT_DIR;
      assert.equal(
        piMcpConfigPath(),
        path.join(os.homedir(), '.pi', 'agent', 'mcp.json')
      );
      process.env.PI_CODING_AGENT_DIR = '~/elsewhere';
      assert.equal(
        piMcpConfigPath(),
        path.join(os.homedir(), 'elsewhere', 'mcp.json')
      );
      // A relative value is left relative so the write is refused, rather than a key
      // landing in whatever directory the installer ran from.
      process.env.PI_CODING_AGENT_DIR = 'relative-dir';
      const result = await client('pi').add({
        kind: 'local',
        apiKey: 'rpa_MUSTNOTLAND',
      });
      assert.equal(result.success, false);
      assert.match(result.message ?? '', /absolute path/);
      assert.equal(fs.existsSync('relative-dir'), false);
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });
});
