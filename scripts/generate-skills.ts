// Embeds specgen/skills/*/SKILL.md into src/specgen/generated/skills.gen.ts so
// the hosted bundle can serve them as MCP resources without filesystem access
// at runtime (Vercel bundles only imported modules). Run: pnpm generate:skills
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'specgen/skills';
const skills = readdirSync(ROOT)
  .filter((d) => {
    try {
      readFileSync(join(ROOT, d, 'SKILL.md'));
      return true;
    } catch {
      return false;
    }
  })
  .sort()
  .map((dir) => {
    const text = readFileSync(join(ROOT, dir, 'SKILL.md'), 'utf8');
    // description: from the YAML frontmatter (block scalar or single line).
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const desc = /description:\s*(?:>-?\n)?([\s\S]*?)(?=\n[a-z]+:|$)/.exec(fm)?.[1] ?? '';
    return {
      name: dir,
      description: desc.replace(/\s+/g, ' ').trim(),
      text,
    };
  });

const header = `// Code generated from specgen/skills by scripts/generate-skills.ts; DO NOT EDIT.

export interface SkillDoc {
  name: string;
  description: string;
  text: string;
}

export const skillDocs: SkillDoc[] = `;
writeFileSync(
  'src/specgen/generated/skills.gen.ts',
  header + JSON.stringify(skills, null, 2) + ';\n'
);
console.log(`embedded ${skills.length} skills`);
