// Runs a dependency's bin (tsc, vite, …) from a package.json script while tolerating the
// generic `--silent`/`--quiet` flags that package managers forward differently:
// `npm run typecheck --silent` consumes the flag itself, but `pnpm run typecheck --silent`
// appends it to the script line, and tsc (TS5072) and vite (CACError) reject it as an
// unknown option. Automated runners lean on that npm convention, so the scripts accept it.
//
// Usage: node scripts/run-tool.mjs <package>[:<bin>] [args…]
//   node scripts/run-tool.mjs typescript:tsc -b --pretty false
//   node scripts/run-tool.mjs vite build
//
// Only *trailing* quiet flags are dropped — that is where a package manager appends them —
// so a flag written deliberately in the middle of a script still reaches the tool. They are
// dropped rather than translated: tsc has no quiet mode, and vite's `--logLevel silent`
// would also hide the build error a verification run exists to surface.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const forwardedQuietFlags = new Set(["--silent", "-s", "--quiet", "-q"]);
const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${webDirectory}/`);

export function stripForwardedFlags(args) {
  const kept = [...args];
  while (kept.length > 0 && forwardedQuietFlags.has(kept[kept.length - 1])) kept.pop();
  return kept;
}

// Resolves through the package's own package.json rather than node_modules/.bin so the
// entry is a plain JS file that `node` can run on every platform (no .cmd shims) and so
// packages that lock down `exports` (vite does) still resolve.
export function resolveBin(spec) {
  const [packageName, binName = packageName] = spec.split(":");
  if (!packageName) throw new Error(`run-tool: empty package spec "${spec}"`);
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = require(manifestPath);
  const bin = typeof manifest.bin === "string" ? { [packageName]: manifest.bin } : manifest.bin;
  const entry = bin?.[binName];
  if (typeof entry !== "string") {
    throw new Error(`run-tool: package "${packageName}" does not provide a "${binName}" bin`);
  }
  return resolve(dirname(manifestPath), entry);
}

export function runTool(argv) {
  const [spec, ...rest] = argv;
  if (!spec) throw new Error("run-tool: usage: node scripts/run-tool.mjs <package>[:<bin>] [args…]");
  const result = spawnSync(process.execPath, [resolveBin(spec), ...stripForwardedFlags(rest)], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTool(process.argv.slice(2));
}
