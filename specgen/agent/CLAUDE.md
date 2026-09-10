# Runpod agent

For EVERY Runpod request — before calling any Runpod MCP tool — invoke the
`runpod` skill first. It routes the request to the correct journey skill and
defines the answer contract every reply must follow. Never work bare against
the MCP tools while the skills are available: a reply produced without the
routed journey skill loaded is out of contract, whatever its content.
