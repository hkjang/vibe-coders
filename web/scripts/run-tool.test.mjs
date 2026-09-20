import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("real tools reject unsupported flags and quiet flags before other arguments", () => {
  for (const args of [
    ["typescript:tsc", "-b", "--silent", "--pretty", "false"],
    ["typescript:tsc", "-b", "--no-such-option", "--silent"],
    ["vite", "build", "--silent", "--mode", "production"],
    ["vite", "build", "--no-such-option", "--silent"],
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, null);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stdout + result.stderr, /Unknown (?:build )?option/u);
  }
});

test("package scripts preserve real type errors and stop the build before Vite", (t) => {
  const webDirectory = resolve(scriptDirectory, "..");
  // Included by tsconfig.app.json; no substitute compiler or execution stub.
  const fixture = mkdtempSync(join(webDirectory, "src", "run-tool-regression-"));
  try {
    writeFileSync(join(fixture, "invalid.ts"), 'export const invalid: number = "not a number";\n');
    for (const script of ["typecheck", "build"]) {
      const result = spawnSync("pnpm", ["run", script, "--silent"], {
        cwd: webDirectory,
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, null);
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, /invalid\.ts.*TS2322/u);
      assert.doesNotMatch(output, /vite v\d|building .* for production|transforming|built in/u);
      t.diagnostic(`${script} --silent: exit ${result.status}; TS2322 preserved`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
