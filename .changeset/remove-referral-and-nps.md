---
'@runpod/mcp-server': minor
---

Remove the referral and NPS asks from the hosted server. `report_how_user_found_runpod` and `rate_nps_score` are no longer served, the `initialize` instructions no longer ask agents how their user found Runpod, and creation results carry only their own payload: no rating note, no creation count and no survey response sent to PostHog. `report_feedback`, `save_to_journal`, `ask_question` and `read_journal` are unchanged and stay voluntary.

For integrators of `@runpod/mcp-server/hosted`: the `hasAnswered` and `recordCreation` options of `handleMcpRequest`, and the `promptReferral` and `nps` options of the server, are gone. The `@runpod/mcp-server/alp` exports are unchanged.
