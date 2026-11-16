---
'@runpod/mcp-server': minor
---

Hosted servers with ALP configured add `rate_nps_score`, which records the agent's own 0 to 10 NPS score once per account, and `report_feedback` takes an optional `tag` (`nps`) for an agent explaining its score. The `nps` route is once per account, like the referral route. From an account's third successful `create-pod`, `create-endpoint`, `deploy-hub-repo` or `create-cluster`, counted per account in the ALP sink, the result carries a note asking the agent for its score until the account has given one. A stored score is sent to the PostHog agent NPS survey, with the creation tool the agent passes in the new optional `triggerTool` argument. Clients that send `X-Runpod-Analytics: off` are not counted, asked or captured.
