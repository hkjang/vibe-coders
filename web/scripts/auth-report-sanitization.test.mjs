import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const reporterUrl = new URL("../tests/auth-live/safe-reporter.ts", import.meta.url).href;
const markers = [
  "SYNTHETIC_PRIVATE_TOKEN_7a91",
  "SYNTHETIC_PRIVATE_PASSWORD_2b83",
  "https://private.example.invalid/secret?credential=SYNTHETIC_PRIVATE_URL_4c75",
  "SYNTHETIC_PRIVATE_ATTACHMENT_5d67",
];
const sensitive = markers.join(" ");

// Run the actual TS reporter through Node's native type stripping, not a copied
// implementation. A child process captures console/stream output without
// interfering with the parent node:test reporter or its TAP output.
const runner = `
  import { readFileSync } from "node:fs";
  const { default: SafeAuthReporter } = await import(process.argv[1]);
  const input = JSON.parse(readFileSync(0, "utf8"));
  const reporter = new SafeAuthReporter();
  if (reporter.printsToStdio() !== false) process.exit(2);
  reporter.onBegin?.(input.config, input.suite);
  for (const row of input.rows) {
    reporter.onTestBegin?.(row.test, row.result);
    reporter.onStdOut?.(Buffer.from(input.sensitive), row.test, row.result);
    reporter.onStdErr?.(Buffer.from(input.sensitive), row.test, row.result);
    for (const step of row.steps) {
      reporter.onStepBegin?.(row.test, row.result, step);
      reporter.onStepEnd?.(row.test, row.result, step);
    }
    reporter.onTestEnd(row.test, row.result);
  }
  reporter.onError?.({ message: input.sensitive, stack: input.sensitive });
  await reporter.onEnd(input.fullResult);
  await reporter.onExit?.();
`;

function row(id, status = "failed", steps = []) {
  return {
    test: {
      id: `${id}-${sensitive}`,
      title: `${id} ${sensitive}`,
      location: { file: `/private/${sensitive}/auth-live.spec.ts`, line: 50, column: 1 },
      annotations: [{ type: sensitive, description: sensitive }],
      tags: [sensitive],
    },
    result: {
      status,
      duration: 123,
      error: { message: sensitive, stack: `Error: ${sensitive}\n    at private.ts:900:2` },
      errors: [{ message: sensitive, stack: sensitive }],
      attachments: [{ name: sensitive, contentType: "text/plain", path: sensitive, body: sensitive }],
      steps: [{ title: sensitive, error: { message: sensitive } }],
      stdout: [sensitive],
      stderr: [sensitive],
      headers: { Authorization: `Bearer ${markers[0]}`, "X-Password": markers[1] },
      request: { url: markers[2], body: sensitive },
    },
    steps,
  };
}

async function report(rows, status = "failed") {
  const originalCwd = process.cwd();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "vibe-auth-report-sanitization-"));
  try {
    process.chdir(temporaryDirectory);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", runner, reporterUrl], {
      cwd: temporaryDirectory,
      input: JSON.stringify({
        sensitive,
        rows,
        config: { metadata: { secret: sensitive }, use: { extraHTTPHeaders: { Authorization: sensitive } } },
        suite: { title: sensitive, tests: rows.map((entry) => entry.test) },
        fullResult: { status, startTime: sensitive, duration: 456, error: { message: sensitive } },
      }),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
    });
    assert.equal(child.error, undefined, "The isolated reporter process must start and finish");
    assert.equal(child.status, 0, "The original TS reporter must run without a transpiler");
    assert.equal(child.stdout.length, 0, "The reporter must not write to stdout");
    assert.equal(child.stderr.length, 0, "The reporter must not write to stderr");
    assert.deepEqual(await readdir(temporaryDirectory), ["test-results"]);
    assert.deepEqual(await readdir(join(temporaryDirectory, "test-results")), ["auth-live-summary.json"]);
    const raw = await readFile(join(temporaryDirectory, "test-results", "auth-live-summary.json"), "utf8");
    for (const marker of markers) {
      assert.equal(raw.includes(marker), false, "The JSON report must omit every synthetic secret marker");
    }
    const summary = JSON.parse(raw);
    assert.deepEqual(Object.keys(summary).sort(), ["status", "tests"]);
    for (const entry of summary.tests) {
      assert.equal(/^(?:AUTH-LIVE-\d{3}|UNKNOWN)$/u.test(entry.scenario), true);
      assert.equal(["passed", "failed", "timedOut", "skipped", "interrupted"].includes(entry.status), true);
      assert.equal(Number.isFinite(entry.durationMs) && entry.durationMs >= 0, true);
      for (const key of Object.keys(entry)) {
        assert.equal(
          ["scenario", "status", "durationMs", "lastSourceLine", "failureSourceLine"].includes(key),
          true,
          "Only the explicit safe result fields may be emitted",
        );
      }
      for (const key of ["lastSourceLine", "failureSourceLine"]) {
        if (key in entry) assert.equal(Number.isSafeInteger(entry[key]) && entry[key] > 0, true);
      }
    }
    return summary;
  } finally {
    // Restore first: even a failed assertion must not leave the process inside a
    // removed directory. This is the one directory this test created and owns.
    process.chdir(originalCwd);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test("auth reporter emits only safe ID, status, duration and numeric source lines", async () => {
  const fixture = row("AUTH-LIVE-001", "failed", [
    { title: sensitive, location: { file: `/private/${sensitive}/auth-live.spec.ts`, line: 123, column: 5 } },
    { title: sensitive, location: { file: `/private/${sensitive}/auth-live.spec.ts`, line: 141, column: 9 } },
    { title: sensitive, location: { file: `/private/${sensitive}/other.spec.ts`, line: 555, column: 1 } },
  ]);
  fixture.result.error.stack = `Error: ${sensitive}\n    at test (/private/${sensitive}/auth-live.spec.ts:167:11)`;
  assert.deepEqual(await report([fixture]), {
    status: "failed",
    tests: [
      {
        scenario: "AUTH-LIVE-001",
        status: "failed",
        durationMs: 123,
        lastSourceLine: 141,
        failureSourceLine: 167,
      },
    ],
  });
});

test("auth reporter rejects title-derived IDs and ignores helper or unrelated source locations", async () => {
  const fixtures = ["AUTH-LIVE-001suffix", "prefix-AUTH-LIVE-002", markers[0]].map((id) =>
    row(id, "skipped", [
      { title: sensitive, location: { file: "/fixture/auth-live.spec.ts", line: 40, column: 1 } },
      { title: sensitive, location: { file: "/fixture/not-auth-live.spec.ts", line: 88, column: 1 } },
      { title: sensitive },
    ]),
  );
  assert.deepEqual(await report(fixtures, "passed"), {
    status: "passed",
    tests: fixtures.map(() => ({ scenario: "UNKNOWN", status: "skipped", durationMs: 123 })),
  });
});

test("auth reporter isolates source lines between tests and preserves all supported test statuses", async () => {
  const statuses = ["passed", "failed", "timedOut", "skipped", "interrupted"];
  const fixtures = statuses.map((status, index) => row(`AUTH-LIVE-00${index + 1}`, status));
  fixtures[0].steps.push({
    title: sensitive,
    location: { file: "/fixture/auth-live.spec.ts", line: 201, column: 1 },
  });
  assert.deepEqual(await report(fixtures, "interrupted"), {
    status: "interrupted",
    tests: statuses.map((status, index) => ({
      scenario: `AUTH-LIVE-00${index + 1}`,
      status,
      durationMs: 123,
      ...(index === 0 ? { lastSourceLine: 201 } : {}),
    })),
  });
});

test("auth reporter does not serialize a global error when no scenario has finished", async () => {
  assert.deepEqual(await report([], "failed"), { status: "failed", tests: [] });
});
