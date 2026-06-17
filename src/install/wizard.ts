import { execSync } from 'child_process';
import * as p from '@clack/prompts';
import { CLIENTS, type McpClient } from './clients.js';

const API_KEYS_URL = 'https://www.runpod.io/console/user/settings';

// Open a URL in the user's default browser. Best-effort and non-fatal.
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start ""'
        : 'xdg-open';
  try {
    execSync(`${command} ${JSON.stringify(url)}`, { stdio: 'ignore' });
  } catch {
    // Ignore — the user can open the URL manually.
  }
}

// Verify the API key works by calling a read-only REST endpoint. Returns true
// on success, false on auth failure, and null when the check itself failed
// (offline, etc.) so we can warn without blocking.
async function verifyApiKey(apiKey: string): Promise<boolean | null> {
  try {
    const response = await fetch('https://rest.runpod.io/v1/pods', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) return true;
    if (response.status === 401 || response.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}

function bail(message = 'Cancelled.'): never {
  p.cancel(message);
  process.exit(0);
}

async function promptForApiKey(): Promise<string> {
  const fromEnv = process.env.RUNPOD_API_KEY;
  if (fromEnv) {
    const useEnv = await p.confirm({
      message: 'Use the RUNPOD_API_KEY from your environment?',
    });
    if (p.isCancel(useEnv)) bail();
    if (useEnv) return fromEnv;
  }

  const create = await p.confirm({
    message: 'Open the Runpod console to create or copy an API key?',
  });
  if (p.isCancel(create)) bail();
  if (create) {
    openBrowser(API_KEYS_URL);
    p.log.info(`Opening ${API_KEYS_URL}`);
  }

  const apiKey = await p.password({
    message: 'Paste your Runpod API key',
    validate: (value) =>
      !value || value.trim().length === 0
        ? 'API key cannot be empty'
        : undefined,
  });
  if (p.isCancel(apiKey)) bail();
  return apiKey.trim();
}

async function selectClients(
  detected: Map<string, boolean>,
  verb: string
): Promise<McpClient[]> {
  const options = CLIENTS.map((client) => ({
    value: client.id,
    label: client.name,
    hint: detected.get(client.id) ? 'detected' : undefined,
  }));

  const selected = await p.multiselect<string>({
    message: `Which agents should we ${verb}?`,
    options,
    // Pre-select detected clients so the common case is a single Enter press.
    initialValues: CLIENTS.filter((c) => detected.get(c.id)).map((c) => c.id),
    required: true,
  });
  if (p.isCancel(selected)) bail();

  return CLIENTS.filter((c) => selected.includes(c.id));
}

async function detectAll(): Promise<Map<string, boolean>> {
  const entries = await Promise.all(
    CLIENTS.map(async (c) => [c.id, await c.detect()] as const)
  );
  return new Map(entries);
}

async function runAdd(): Promise<void> {
  const detected = await detectAll();
  const clients = await selectClients(detected, 'set up');

  const apiKey = await promptForApiKey();

  const verifySpinner = p.spinner();
  verifySpinner.start('Verifying API key');
  const valid = await verifyApiKey(apiKey);
  if (valid === true) {
    verifySpinner.stop('API key verified.');
  } else if (valid === false) {
    verifySpinner.stop('API key rejected by Runpod.');
    const proceed = await p.confirm({
      message: 'The key did not authenticate. Continue anyway?',
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) bail();
  } else {
    verifySpinner.stop('Could not verify the key (offline?). Continuing.');
  }

  const results: string[] = [];
  for (const client of clients) {
    const spinner = p.spinner();
    spinner.start(`Configuring ${client.name}`);
    const result = await client.add(apiKey);
    if (result.success) {
      spinner.stop(`${client.name} configured.`);
      results.push(`✓ ${client.name} — ${client.describeTarget()}`);
    } else {
      spinner.stop(`${client.name} failed.`);
      results.push(`✗ ${client.name} — ${result.message ?? 'unknown error'}`);
    }
  }

  p.note(results.join('\n'), 'Results');
  p.outro('Restart your agent (or reconnect MCP) to load the Runpod tools.');
}

async function runRemove(): Promise<void> {
  const detected = await detectAll();
  const clients = await selectClients(detected, 'remove Runpod from');

  const results: string[] = [];
  for (const client of clients) {
    const spinner = p.spinner();
    spinner.start(`Removing from ${client.name}`);
    const result = await client.remove();
    spinner.stop(
      result.success ? `${client.name} cleaned up.` : `${client.name} failed.`
    );
    results.push(
      `${result.success ? '✓' : '✗'} ${client.name}${
        result.message ? ` — ${result.message}` : ''
      }`
    );
  }

  p.note(results.join('\n'), 'Results');
  p.outro('Done.');
}

// Entry point for `npx @runpod/mcp-server mcp <add|remove>`.
export async function runWizard(subcommand: string): Promise<void> {
  p.intro('Runpod MCP server installer');

  if (subcommand === 'remove') {
    await runRemove();
  } else {
    await runAdd();
  }
}
