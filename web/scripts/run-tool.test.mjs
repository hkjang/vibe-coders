import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBin, stripForwardedFlags } from "./run-tool.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runTool = join(scriptDirectory, "run-tool.mjs");

function run(...args) {
  const result = spawnSync(process.execPath, [runTool, ...args], {
    cwd: resolve(scriptDirectory, ".."),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("stripForwardedFlags drops only the quiet flags a package manager appends", () => {
  assert.deepEqual(stripForwardedFlags(["-b", "--pretty", "false", "--silent"]), ["-b", "--pretty", "false"]);
  assert.deepEqual(stripForwardedFlags(["build", "--silent", "-s", "--quiet", "-q"]), ["build"]);
  assert.deepEqual(stripForwardedFlags(["--silent"]), []);
  assert.deepEqual(stripForwardedFlags([]), []);
  // A flag written deliberately before other arguments is not touched.
  assert.deepEqual(stripForwardedFlags(["-b", "--silent", "--pretty", "false"]), [
    "-b",
    "--silent",
    "--pretty",
    "false",
  ]);
});

test("resolveBin finds bins through the package manifest", () => {
  assert.equal(resolveBin("typescript:tsc").split(sep).slice(-3).join("/"), "typescript/bin/tsc");
  assert.equal(resolveBin("vite").split(sep).slice(-3).join("/"), "vite/bin/vite.js");
  assert.throws(() => resolveBin("typescript:not-a-bin"), /does not provide a "not-a-bin" bin/u);
  assert.throws(() => resolveBin(""), /empty package spec/u);
});

test("tsc and vite run with a forwarded --silent instead of rejecting it", () => {
  const tsc = run("typescript:tsc", "--version", "--silent");
  assert.equal(tsc.status, 0, tsc.stderr);
  assert.match(tsc.stdout, /^Version \d+\./u);

  const vite = run("vite", "--version", "--silent");
  assert.equal(vite.status, 0, vite.stderr);
  assert.match(vite.stdout, /^vite\/\d+\./u);
});

test("the tool's own exit status and output are preserved", () => {
  const failing = run("typescript:tsc", "--no-such-option");
  assert.notEqual(failing.status, 0);
  assert.match(failing.stdout + failing.stderr, /TS5023|Unknown compiler option/u);
});
