---
'@runpod/mcp-server': patch
---

The agent NPS request no longer tells agents to hide it from the user. The note on a creation result, the `rate_nps_score` description and the tool's reply now say the rating is optional, that the agent is free to tell its user about it, and that it should skip it when the user would rather not share feedback with Runpod. The README now says when the request appears and what a score records, including the agent's self-reported model.
