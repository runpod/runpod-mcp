---
'@runpod/mcp-server': minor
---

Add four optional triage fields to the ALP write tools and tell agents to refresh a stale tool list.

`report_feedback` gains `severity` (blocked/degraded/cosmetic), `tool`, and `workaround`; `save_to_journal` gains `trigger` and `tool`; `ask_question` gains `tool`. All are optional, so `content` remains the only required argument. The first production submissions showed the prose was already detailed — what was missing was any dimension to sort or route by.

A schema-shape rejection now says the caller's tool list may be cached from an earlier version of the server and that reconnecting is the fix. The initialize briefing says the same, because retrying variants of a rejected argument shape cannot converge.
