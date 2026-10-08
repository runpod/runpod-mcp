// Knowledge tools: the official Runpod plugin's skills, reference docs, golden
// paths and concept graph, served from the @runpod/plugin-knowledge bundle so an
// agent without the plugin installed can read them. Read-only and offline:
// nothing here calls the Runpod API.

import {
  loadKnowledge,
  type Concept,
  type Guide,
  type Rule,
} from '@runpod/plugin-knowledge';
import type { CuratedTool } from '../types.js';
import { bundledRead } from './annotations.js';
import { badRequest, ok } from './util.js';

const knowledge = loadKnowledge();

const GUIDE_KINDS = ['skill', 'reference', 'golden-path'] as const;
const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it my of on or the to what when why with you your'.split(
    ' '
  )
);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));

const guideSummary = ({
  id,
  kind,
  title,
  description,
  lanes,
  mcp,
  needs_shell,
  concepts,
}: Guide) => ({
  id,
  kind,
  title,
  description,
  lanes,
  mcp,
  needs_shell,
  concepts,
});

/** Guides linked to a concept, split into golden-path examples and docs. */
function linkedGuides(conceptId: string) {
  const byId = new Map(knowledge.guides.map((guide) => [guide.id, guide]));
  const seen = new Set<string>();
  const examples: { id: string; title: string; mcp: Guide['mcp'] }[] = [];
  const docs: { id: string; title: string; rules?: string[] }[] = [];
  for (const link of knowledge.links) {
    if (link.to !== conceptId || seen.has(link.from)) continue;
    seen.add(link.from);
    const guide = byId.get(link.from);
    if (!guide) continue;
    if (guide.kind === 'golden-path')
      examples.push({ id: guide.id, title: guide.title, mcp: guide.mcp });
    else
      docs.push({
        id: guide.id,
        title: guide.title,
        ...(link.rules ? { rules: link.rules } : {}),
      });
  }
  return { examples, docs };
}

/** Concept ids by lower-cased id, name and alias. */
const conceptIndex = new Map<string, Concept>();
for (const concept of knowledge.concepts) {
  for (const key of [concept.id, concept.name, ...concept.aliases]) {
    if (!conceptIndex.has(key.toLowerCase()))
      conceptIndex.set(key.toLowerCase(), concept);
  }
}
const ruleIndex = new Map<string, { rule: Rule; concept: Concept }>();
for (const concept of knowledge.concepts) {
  for (const rule of concept.rules) ruleIndex.set(rule.id, { rule, concept });
}

const source = {
  plugin_version: knowledge.version,
  plugin_commit: knowledge.commit,
};

export const listGuides: CuratedTool = {
  name: 'list-guides',
  annotations: bundledRead,
  description:
    'List the official Runpod guides: skills (how to work with each tool), reference docs (how Runpod works), and golden paths (live-verified end-to-end walkthroughs such as a dev pod, a Whisper endpoint or a fine-tune-to-serverless pipeline). Read one with read-guide. For a golden path, mcp says whether an agent with only these MCP tools can finish it: full (follow it with tool calls), partial (use it for the plan and facts; name the step the user must run in a terminal), none (reference only). Skills and reference docs have mcp null. concepts lists the concept ids it works with (see lookup-concept). Filter with kind, query or concept.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...GUIDE_KINDS],
        description: 'Only this kind of guide.',
      },
      query: {
        type: 'string',
        description: 'Words to match against the id, title and description.',
      },
      concept: {
        type: 'string',
        description:
          'Only guides linked to this concept id, for example "network-volume".',
      },
    },
    additionalProperties: false,
  },
  handler: async (_ctx, args) => {
    const kind = args.kind as Guide['kind'] | undefined;
    const terms = words(String(args.query ?? ''));
    const concept = args.concept ? String(args.concept).trim() : undefined;
    const guides = knowledge.guides
      .filter((guide) => !kind || guide.kind === kind)
      .filter((guide) => !concept || guide.concepts.includes(concept))
      .filter((guide) => {
        if (!terms.length) return true;
        const haystack =
          `${guide.id} ${guide.title} ${guide.description}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      })
      .map(guideSummary);
    return ok({ ...source, count: guides.length, guides });
  },
};

export const readGuide: CuratedTool = {
  name: 'read-guide',
  annotations: bundledRead,
  description:
    'Read one official Runpod guide in full, by the id list-guides returns (for example "runpod-usage/storage" or "golden-path/06-dev-pod").',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The guide id from list-guides.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (_ctx, args) => {
    const id = String(args.id).trim();
    const guide = knowledge.guides.find((candidate) => candidate.id === id);
    if (!guide) {
      const close = knowledge.guides
        .filter(
          (candidate) => candidate.id.includes(id) || id.includes(candidate.id)
        )
        .map((candidate) => candidate.id);
      return {
        ok: false,
        status: 404,
        payload: {
          error: `No guide with id "${id}".`,
          hint: close.length
            ? `Did you mean: ${close.join(', ')}?`
            : 'Call list-guides for the ids.',
        },
      };
    }
    return ok({
      ...source,
      ...guideSummary(guide),
      parent: guide.parent,
      path: guide.path,
      body: guide.body,
    });
  },
};

export const lookupConcept: CuratedTool = {
  name: 'lookup-concept',
  annotations: bundledRead,
  description:
    'Look up one Runpod concept (pod, network volume, machine, worker, template, …) by id, name or alias. Returns its summary, fields, states, relations and rules, each rule with the public source it comes from, the concepts that point at it, and the linked guides: examples (golden paths that use it, with their mcp level) and docs (skills and reference docs that explain it). Use it for exact facts, for example "is a volume disk tied to one machine" or "what happens to a stopped pod\'s GPU".',
  inputSchema: {
    type: 'object',
    properties: {
      concept: {
        type: 'string',
        description:
          'An id, name or alias, such as "pod", "Network volume" or "volume disk".',
      },
    },
    required: ['concept'],
    additionalProperties: false,
  },
  handler: async (_ctx, args) => {
    const ref = String(args.concept).trim().toLowerCase();
    const concept = conceptIndex.get(ref);
    if (!concept) {
      const close = [...conceptIndex.keys()]
        .filter((key) => key.includes(ref))
        .slice(0, 10);
      return {
        ok: false,
        status: 404,
        payload: {
          error: `No concept matches "${args.concept}".`,
          hint: close.length
            ? `Close matches: ${close.join(', ')}.`
            : 'Try search-concepts with a few words instead.',
        },
      };
    }
    const pointedAtBy = knowledge.concepts.flatMap((other) => [
      ...(other.is_a === concept.id
        ? [{ concept: other.id, type: 'is_a' }]
        : []),
      ...(other.part_of === concept.id
        ? [{ concept: other.id, type: 'part_of' }]
        : []),
      ...other.relations
        .filter((relation) => relation.target === concept.id)
        .map((relation) => ({ concept: other.id, type: relation.type })),
    ]);
    const linkedRules = [...new Set(concept.rules.flatMap((rule) => rule.see))]
      .map((id) => ruleIndex.get(id))
      .filter((entry) => entry !== undefined)
      .map(({ rule, concept: owner }) => ({
        concept: owner.id,
        id: rule.id,
        statement: rule.statement.trim(),
      }));
    return ok({
      ...source,
      ...concept,
      pointed_at_by: pointedAtBy,
      linked_rules: linkedRules,
      ...linkedGuides(concept.id),
    });
  },
};

export const searchConcepts: CuratedTool = {
  name: 'search-concepts',
  annotations: bundledRead,
  description:
    'Search the rules of the Runpod concept graph by words, for example "restart stopped pod no gpu" or "network volume data center". Returns the best-matching rules with their concept and public evidence. Follow up with lookup-concept for the full concept.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A few words describing the question.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        description: 'Most rules to return. Default 8.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (_ctx, args) => {
    const terms = words(String(args.query));
    if (!terms.length) return badRequest('query needs at least one word.');
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 25);
    const hits = [...ruleIndex.values()]
      .map(({ rule, concept }) => {
        const statement = words(rule.statement);
        const names = words(
          [concept.id, concept.name, ...concept.aliases].join(' ')
        );
        const ruleId = words(rule.id);
        // Statement matches count once per occurrence; concept names weigh more,
        // since a question usually names the thing it is about.
        const score = terms.reduce(
          (total, term) =>
            total +
            statement.filter((word) => word.startsWith(term)).length +
            (names.includes(term) ? 3 : 0) +
            (ruleId.includes(term) ? 1 : 0),
          0
        );
        const matched = terms.filter(
          (term) =>
            statement.some((word) => word.startsWith(term)) ||
            names.includes(term)
        ).length;
        return { rule, concept, score: score * matched };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ rule, concept }) => ({
        concept: concept.id,
        concept_name: concept.name,
        id: rule.id,
        statement: rule.statement.trim(),
        status: rule.status,
        conflict: rule.conflict,
        evidence: rule.evidence,
      }));
    return ok({ ...source, count: hits.length, rules: hits });
  },
};

export const knowledgeTools: CuratedTool[] = [
  listGuides,
  readGuide,
  lookupConcept,
  searchConcepts,
];

/** The plugin guides as MCP resources, for clients that read resources. */
export const GUIDE_URI_PREFIX = 'runpod://guides/';
export const guideResources = knowledge.guides.map((guide) => ({
  uri: `${GUIDE_URI_PREFIX}${guide.id}`,
  name: guide.id,
  title: guide.title,
  description: guide.description,
  mimeType: 'text/markdown',
  text: guide.body,
}));
