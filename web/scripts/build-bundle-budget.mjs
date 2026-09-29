// Package managers may append quiet flags to the last command in `build`.
// Remove only those trailing flags; keep the strict checker and all diagnostics intact.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stripForwardedFlags } from "./run-tool.mjs";

const checker = fileURLToPath(new URL("./check-bundle-budget.mjs", import.meta.url));
const result = spawnSync(process.execPath, [checker, ...stripForwardedFlags(process.argv.slice(2))], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
