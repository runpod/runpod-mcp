---
'@runpod/mcp-server': minor
---

Hosted server: a new optional ALP tool, `report_how_user_found_runpod`, asks
the agent once per account how its user ended up on Runpod: what they
originally asked for and why Runpod came up (`source`: `searched`,
`user_named`, `recommended`, `other`), or that it has no such context
(`noContext`). The ask rides in the `initialize` instructions; on each
`initialize` with a resolved account the server checks the storage sink and
omits the ask once the account has answered (a failed lookup keeps the ask),
and the sink keeps the first answer per account, with the server answering
`already_submitted` to any later one. Answers are stored with the
other ALP submissions under their own `referral` route, capped at 2,000
characters, and scrubbed like every other submission. Absent on local stdio
and whenever the sink is not configured, like the other ALP tools.
