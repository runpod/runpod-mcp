// Human-readable tool titles (tools/list `title`). Hosts show the title in
// place of the machine name, and directory reviews require one on every tool.
// A generated tool's title is derived from its name unless the generator
// config overrides it; a curated tool declares its own.

// Words a title spells differently from the tool name: product proper nouns
// and acronyms. Everything else is sentence case.
const WORDS: Record<string, string> = {
  cpu: 'CPU',
  gpu: 'GPU',
  gpus: 'GPUs',
  hub: 'Hub',
  pod: 'Pod',
  pods: 'Pods',
  runpod: 'Runpod',
  serverless: 'Serverless',
  ssh: 'SSH',
};

/** `list-gpu-types` -> `List GPU types`; `save_to_journal` -> `Save to journal`. */
export function titleFromName(name: string): string {
  const words = name.split(/[-_]/).filter(Boolean);
  return words
    .map((word, i) => {
      const fixed = WORDS[word];
      if (fixed) return fixed;
      return i === 0 ? word[0].toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}
