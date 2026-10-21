---
'@runpod/mcp-server': minor
---

Add a directory profile at `/directory` (hosted: `https://mcp.runpod.io/directory`) for app directories such as Anthropic's connector directory. It lists tool descriptions that only say what each tool does, full argument schemas, and a factual briefing, and leaves out the guide tools, `describe-tool`, the tools that take a secret or password as input (`create-secret`, `update-secret`, `create-registry`), the agent-learning tools, the referral ask and the guide resources; its analytics record which tool ran but no argument values. The default surface at `/` is unchanged. Separately, every profile now redacts secret-looking environment values (passwords, tokens, API keys) in tool results, keeping `{{ RUNPOD_SECRET_<name> }}` references.
