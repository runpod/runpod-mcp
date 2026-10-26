# Directory policy

The hosted server serves a second tool surface at `/directory` for app directories: Anthropic's connector directory and OpenAI's plugin directory. This file is the rule set for what goes on it. It is written for whoever adds a tool, person or agent, and for the agent step in `.github/workflows/spec-update.yml` that classifies new tools after a spec regeneration.

Sources:

- Anthropic Software Directory Policy: https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- OpenAI plugin guidelines: https://developers.openai.com/plugins/plugin-guidelines

The default surface (`/`) is not affected by anything here.

## Where decisions live

| What                                     | Where                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Include or exclude a tool, with a reason | `DIRECTORY_TOOLS` in `src/specgen/profile.ts`                                                                |
| Hide one argument from the directory     | `omitInputs` on the tool's `DIRECTORY_TOOLS` entry                                                           |
| Directory description, generated tool    | `directoryDescriptions` in `specgen/generator-config.yaml`, keyed by operationId, then `pnpm generate:tools` |
| Directory description, curated tool      | `directoryDescription` on the tool in `src/specgen/tools/`                                                   |

Every tool needs a `DIRECTORY_TOOLS` entry. `tests/specgen-directory.test.ts` fails on a tool without one, so nothing reaches the directory by default. `pnpm directory:unclassified` lists the tools that still need a decision.

The `/directory` initialize briefing may link the official REST API reference as a factual pointer for users whose requested operation is outside this tool list. It does not ask for credentials or tell an agent to read client credential stores or make direct API calls. Directory clients may have no shell, so this link is informational rather than an executable fallback.

## Exclude the tool when

1. **It takes a credential as input.** A password, secret value, API key, access token or private key (OpenAI: no access credentials as input). If only one optional argument is a credential and the tool is useful without it, include the tool and put that argument in `omitInputs` instead. Example: `run-endpoint` omits `s3Config`.
   Tools that manage stored credentials (secrets, registry credentials) are excluded too, even read and delete: OpenAI rejected the plugin for handling access credentials. The directory profile also drops any schema example that names or holds a credential (for example `{"JUPYTER_PASSWORD": "hunter2"}`).
2. **It collects conversation data beyond its job.** Feedback, journals, surveys, attribution or analytics about the user or the chat, even for logging (Anthropic 1.D).
3. **It serves instructions for the model.** Playbooks, guides, prompts or anything else that tells the model how to behave or pulls instructions from an external source (Anthropic 2.A, 2.B, 2.F).
4. **It fetches schemas or other tools' definitions.** A generic executor or schema lookup (OpenAI: no schema fetching). The directory lists every schema in full.
5. **It generates images, video or audio with AI**, unless Anthropic has permitted it in writing (Anthropic 4.B). Deploying or running a customer's own endpoint is not generation by us; a tool whose purpose is generating media is.
6. **It moves money or starts a purchase.** Payments, credit top-ups, transfers or plan changes (OpenAI: no checkout or transaction flows; Anthropic restricts financial transactions).

Write the reason as one sentence naming the rule. Reuse the shared reason constants in `profile.ts` where one fits.

## Include the tool otherwise

Reads, creates, updates and deletes of the user's own Runpod resources are the point of the connector. Billable and destructive tools are fine. Their annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) and title carry the risk to the host, and those are derived for generated tools.

## Directory descriptions

An included tool is served with its `directoryDescription` when it has one, and its normal description otherwise. It needs a directory description when the normal one breaks any of these (Anthropic 2.A, 2.B, 2.D, 5.B):

- It tells the model what to do: "only after", "before creating", "state the price", "prefer", "important", "verify".
- It names another tool.
- It points at a guide, playbook or external instructions.

A directory description says what the tool does and what is true about it, nothing else. State facts where the default description gives orders: "Billable: the Pod accrues its hourly price until it is deleted", not "State the hourly price before creating". Keep it short. `tests/specgen-directory.test.ts` rejects directive phrasing and tool names in every directory description, including the fallback to the normal one.

## Done when

```bash
pnpm directory:unclassified   # prints nothing
pnpm generate:check
node --import tsx --test tests/specgen-directory.test.ts
```
