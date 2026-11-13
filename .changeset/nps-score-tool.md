---
'@runpod/mcp-server': minor
---

Hosted servers with ALP configured add `rate_nps_score`, which records the agent's own 0 to 10 NPS score once per account, and `report_feedback` takes an optional `tag` (`nps`) for an agent explaining its score. The `nps` route is once per account, like the referral route.
