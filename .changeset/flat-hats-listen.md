---
"@runpod/mcp-server": patch
---

Stop prompting agents for Runpod referrals and NPS scores. The referral instructions in the server briefing and the NPS note appended to creation results are gone, so a creation result carries only its own payload; the `report_how_user_found_runpod` and `rate_nps_score` tools stay registered for voluntary use.
