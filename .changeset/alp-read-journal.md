---
'@runpod/mcp-server': minor
---

Add `read_journal`: an account can read back its own `save_to_journal` entries.

The tool takes only a `limit`. Whose journal is returned comes from the Bearer token, resolved server-side exactly as writes are keyed, so no caller can name another account. The read is served by the hosted server (`POST /api/alp/journal`) from the same private sink as writes and fails closed: any failure returns zero entries with a no-retry note, never a wider query. `save_to_journal` and the initialize briefing no longer describe the journal as write-only.
