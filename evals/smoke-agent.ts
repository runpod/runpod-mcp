// A real agent, through the real `claude` CLI, against the built server
// (dist/stdio.mjs) and your own account. Not a compact-vs-pretty comparison
// (see promptfooconfig*.yaml for that) — a sanity check that an actual
// agent can actually use this server end to end, with a model cheap enough
// to run on every PR.
//
//   pnpm build && RUNPOD_API_KEY=… pnpm smoke:agent [model]
//
// Needs the `claude` CLI on PATH, signed in to a Claude account (Claude Code
// subscription or ANTHROPIC_API_KEY); bills to whichever it's signed in
// with, not RUNPOD_API_KEY. Live: reads your own account's real catalog
// data, so answers are current, not fixed to a snapshot.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..', 'dist', 'stdio.mjs');
const key = process.env.RUNPOD_API_KEY;
if (!key) throw new Error('RUNPOD_API_KEY is not set');
const model = process.argv[2] ?? 'haiku';

const cwd = join(here, 'out', 'smoke-agent-empty');
mkdirSync(cwd, { recursive: true });
const cfg = join(here, 'out', 'smoke-agent-mcp.json');
writeFileSync(
  cfg,
  JSON.stringify({
    mcpServers: {
      runpod: {
        command: process.execPath,
        args: [server],
        env: { RUNPOD_API_KEY: '${RUNPOD_API_KEY}' },
      },
    },
  })
);

type Task = { id: string; prompt: string; tool: string };
const tasks: Task[] = [
  {
    id: 'gpu-price',
    prompt:
      "Using the Runpod MCP tools, what is the Secure Cloud price per hour of the GPU type with id 'NVIDIA H100 NVL'? Answer in one sentence.",
    tool: 'get-gpu-type',
  },
  {
    id: 'dc-count',
    prompt:
      'Using the Runpod MCP tools, how many data centers are in the EUROPE region? Answer in one sentence.',
    tool: 'list-data-centers',
  },
  {
    id: 'guides',
    prompt:
      'Using the Runpod MCP tools, list the titles of the golden-path guides. Answer with just the list.',
    tool: 'list-guides',
  },
];

function runTask(
  task: Task
): Promise<{ id: string; ok: boolean; why: string }> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      task.prompt,
      '--model',
      model,
      '--mcp-config',
      cfg,
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--tools',
      '',
      '--no-session-persistence',
      '--allowedTools',
      `mcp__runpod__${task.tool}`,
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    const child = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, RUNPOD_API_KEY: key },
    });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ id: task.id, ok: false, why: `spawn failed: ${err.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      let usedTool = false;
      let toolError = false;
      let unexpectedTool = '';
      let answer = '';
      let runFailed = false;
      for (const line of buf.split('\n')) {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant')
          for (const b of ev.message?.content ?? [])
            if (b.type === 'tool_use') {
              if (String(b.name).includes(task.tool)) usedTool = true;
              else if (!unexpectedTool) unexpectedTool = String(b.name);
            }
        if (ev.type === 'user')
          for (const b of ev.message?.content ?? [])
            if (b.type === 'tool_result' && b.is_error) toolError = true;
        if (ev.type === 'result') {
          answer = (ev.result ?? '').trim();
          runFailed = !!ev.is_error || ev.subtype !== 'success';
        }
      }
      // --allowedTools already scopes the run to task.tool alone; any other call is a scoping bug.
      const ok =
        usedTool &&
        !toolError &&
        !unexpectedTool &&
        !runFailed &&
        answer.length > 0;
      resolve({
        id: task.id,
        ok,
        why: !usedTool
          ? `never called ${task.tool}`
          : unexpectedTool
            ? `called unexpected tool ${unexpectedTool}`
            : toolError
              ? 'a tool call errored'
              : runFailed
                ? 'the run itself failed'
                : !answer
                  ? 'no final answer'
                  : 'ok',
      });
    });
  });
}

const results = await Promise.all(tasks.map(runTask));
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id.padEnd(12)} ${r.why}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
