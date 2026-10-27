---
"@runpod/mcp-server": minor
---

Export the server profile module as `@runpod/mcp-server/profile` (`ServerProfile`, `DIRECTORY_PATH`, `DIRECTORY_TOOLS`, `profileForPath`, `directoryIncludes`, `directoryOmittedInputs`) so an HTTP host can resolve the directory profile from the package instead of reaching into `src/`.
