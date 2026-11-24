---
'@runpod/mcp-server': major
---

Tool results are now compact JSON instead of JSON indented by two spaces. A result under its size cap costs about 13 to 19% fewer tokens on Claude Haiku 5.5 (measured on two results; see the PR for the full breakdown). A list page that reaches the 24,000-byte budget, which measures the text as sent, holds more rows instead: about a fifth more on flat lists such as `list-guides`, more on nested rows such as Pods, so walking a long list takes fewer calls. Set `MCP_PRETTY_RESPONSES=true` to switch back to indented JSON.

One change keeps agents paging correctly on compact results: `pagination.nextCursor` is now masked, so decoding it shows no readable fields; some models had rebuilt readable cursors instead of copying them. The connect instructions say to pass `nextCursor` exactly as returned. Text results such as READMEs are unchanged.

Breaking: a `nextCursor` issued before this update is rejected with `invalid_cursor` (the error's hint says to omit `cursor` and start from the first page) — a one-time break for any walk in flight across the upgrade, including on the hosted server while old and new instances run side by side during a deploy.
