import { readFileSync } from "node:fs";

const requiredMarkers = [
  ["server/src/adapters/http/execute.ts", "[status-lock]"],
  ["server/src/adapters/http/execute.ts", "[auto-disposition]"],
  ["server/src/services/recovery/service.ts", "terminal_state_guard"],
  ["server/src/services/issues.ts", "MAX_AGENT_CHILD_ISSUES_PER_RUN"],
  ["server/src/services/issues.ts", "MAX_AGENT_CHILD_ISSUES_PER_ROLLING_DAY"],
  ["server/src/services/issues.ts", "assertAgentChildIssueCreationWithinSwarmCaps"],
];

const missing = [];
for (const [file, marker] of requiredMarkers) {
  const body = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  if (!body.includes(marker)) missing.push({ file, marker });
}

if (missing.length > 0) {
  for (const entry of missing) {
    console.error(`MISSING_MARKER ${entry.file} :: ${entry.marker}`);
  }
  process.exit(1);
}

console.log("post-upgrade patch verification passed");
