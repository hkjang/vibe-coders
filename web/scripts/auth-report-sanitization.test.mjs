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
  "vc_sk_SYNTHETIC_PRIVATE_API_KEY_6e58_DO_NOT_USE",
  "SYNTHETIC_PRIVATE_KEY_HASH_8f49",
  "SYNTHETIC_PRIVATE_REQUEST_BODY_1a32",
  "SYNTHETIC_PRIVATE_RESPONSE_BODY_3b21",
  "SYNTHETIC_PRIVATE_ERROR_4c10",
  "SYNTHETIC_PRIVATE_TITLE_5d09",
  "SYNTHETIC_PRIVATE_STDOUT_6e98",
  "SYNTHETIC_PRIVATE_STDERR_7f87",
];
const sensitive = markers.join(" ");
const allowedScenarios = [
  "AUTH-LIVE-001",
  "AUTH-LIVE-002",
  "AUTH-LIVE-003",
  "AUTH-LIVE-004",
  "AUTH-LIVE-005",
  "AUTH-LIVE-006",
  "AUTH-LIVE-007",
  "AUTH-LIVE-008",
  "AUTH-LIVE-009",
  "AUTH-LIVE-010",
];

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
    // JSON cannot carry non-finite numbers; restore them only in the test runner.
    if (row.nonFiniteDuration) row.result.duration = Number(row.nonFiniteDuration);
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
      request: { url: markers[2], body: { api_key: markers[4], key_hash: markers[5], input: sensitive } },
      response: {
        body: { secret: markers[4], key_hash: markers[5], output: sensitive, error: markers[8] },
        headers: { "Set-Cookie": sensitive },
      },
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
    assert.equal(["passed", "failed", "timedout", "interrupted"].includes(summary.status), true);
    for (const entry of summary.tests) {
      assert.equal([...allowedScenarios, "UNKNOWN"].includes(entry.scenario), true);
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

test("auth reporter rejects non-allowlisted title IDs and ignores helper or unrelated source locations", async () => {
  const fixtures = [
    "AUTH-LIVE-000",
    "AUTH-LIVE-011",
    "AUTH-LIVE-999",
    "AUTH-LIVE-01",
    "AUTH-LIVE-001suffix",
    "prefix-AUTH-LIVE-002",
    "AUTH-LIVE-001\nforged-title",
    " AUTH-LIVE-001",
    markers[0],
  ].map((id) =>
    row(id, "skipped", [
      { title: sensitive, location: { file: "/fixture/auth-live.spec.ts", line: 0, column: 1 } },
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

test("auth reporter allows only the ten fixed scenarios and numeric lines from both exact spec basenames", async () => {
  const fixtures = allowedScenarios.map((id, index) => {
    const filename = index < 5 ? "auth-live.spec.ts" : "access-live.spec.ts";
    const file = index % 2 === 0 ? `/private/${sensitive}/${filename}` : `C:\\private\\${filename}`;
    const fixture = row(id, "passed", [{ title: sensitive, location: { file, line: index + 1, column: 1 } }]);
    fixture.result.error.stack = `Error: ${sensitive}\n    at test (${file}:${index + 21}:2)`;
    return fixture;
  });
  assert.deepEqual(await report(fixtures, "passed"), {
    status: "passed",
    tests: allowedScenarios.map((scenario, index) => ({
      scenario,
      status: "passed",
      durationMs: 123,
      lastSourceLine: index + 1,
      failureSourceLine: index + 21,
    })),
  });
});

test("auth reporter rejects prefixed, suffixed, malformed and unrelated source filenames in steps and stacks", async () => {
  const filenames = [
    "not-auth-live.spec.ts",
    "prefix-access-live.spec.ts",
    "auth-live.spec.ts.bak",
    "access-live.spec.tsx",
    "access-live.spec.ts/",
    "auth-live.spec.ts\\",
    "auth-live.spec.ts:12",
    `access-live.spec.ts?api_key=${markers[4]}`,
    `auth-live.spec.ts#key_hash=${markers[5]}`,
    `access-live.spec.ts-${markers[9]}`,
    "helpers.ts",
  ];
  const fixtures = filenames.map((filename) => {
    const file = `/fixture/${filename}`;
    const fixture = row("AUTH-LIVE-007", "failed", [
      { title: sensitive, location: { file, line: 73, column: 1 } },
    ]);
    fixture.result.error.stack = `Error: ${sensitive}\n    at test (${file}:85:2)`;
    return fixture;
  });
  const messageOnly = row("AUTH-LIVE-007");
  messageOnly.result.error.stack = `Error: ${sensitive} /fixture/access-live.spec.ts:999:1`;
  fixtures.push(messageOnly);
  assert.deepEqual(await report(fixtures), {
    status: "failed",
    tests: fixtures.map(() => ({ scenario: "AUTH-LIVE-007", status: "failed", durationMs: 123 })),
  });
});

test("auth reporter rejects nonnumeric, nonpositive and unsafe source lines and malformed stack columns", async () => {
  const invalidLines = [0, -1, 1.5, "73", null, true, { key_hash: markers[5] }, Number.MAX_SAFE_INTEGER + 1];
  const fixtures = invalidLines.map((line) =>
    row("AUTH-LIVE-009", "failed", [
      { title: sensitive, location: { file: "/fixture/access-live.spec.ts", line, column: 1 } },
    ]),
  );
  for (const position of [
    "0:1",
    "-1:1",
    "1.5:1",
    "1e3:1",
    "01:1",
    "9007199254740992:1",
    "25:0",
    "25:-1",
    "25:1.5",
    "25:01",
    "25:9007199254740992",
    `25:${markers[5]}`,
  ]) {
    const fixture = row("AUTH-LIVE-009");
    fixture.result.error.stack = `Error: ${sensitive}\n    at test (/fixture/access-live.spec.ts:${position})`;
    fixtures.push(fixture);
  }
  assert.deepEqual(await report(fixtures), {
    status: "failed",
    tests: fixtures.map(() => ({ scenario: "AUTH-LIVE-009", status: "failed", durationMs: 123 })),
  });
});

test("auth reporter validates status and duration without serializing attacker-controlled scalar fields", async () => {
  const invalidDurations = [markers[6], "123", null, { body: sensitive }, -1, Number.MAX_SAFE_INTEGER + 1];
  const fixtures = invalidDurations.map((duration) => {
    const fixture = row("AUTH-LIVE-010", "failed");
    fixture.result.duration = duration;
    return fixture;
  });
  for (const value of ["NaN", "Infinity", "-Infinity"]) {
    const fixture = row("AUTH-LIVE-010", "failed");
    fixture.nonFiniteDuration = value;
    fixtures.push(fixture);
  }
  for (const status of [markers[8], "PASSED", "timedout", null, { error: sensitive }]) {
    const fixture = row("AUTH-LIVE-010", status);
    fixture.result.duration = 0;
    fixtures.push(fixture);
  }
  assert.deepEqual(await report(fixtures, markers[8]), {
    status: "failed",
    tests: fixtures.map(() => ({ scenario: "AUTH-LIVE-010", status: "failed", durationMs: 0 })),
  });

  const validDurations = [0, 12.5, Number.MAX_SAFE_INTEGER];
  const valid = validDurations.map((duration) => {
    const fixture = row("AUTH-LIVE-006", "passed");
    fixture.result.duration = duration;
    return fixture;
  });
  assert.deepEqual(await report(valid, "timedout"), {
    status: "timedout",
    tests: validDurations.map((durationMs) => ({ scenario: "AUTH-LIVE-006", status: "passed", durationMs })),
  });
});

test("auth reporter rejects malformed title and stack values and clears lines between attempts of the same test", async () => {
  const first = row("AUTH-LIVE-008", "failed", [
    { title: sensitive, location: { file: "access-live.spec.ts", line: 39, column: 1 } },
  ]);
  first.result.error.stack = `Error: ${sensitive}\n    at access-live.spec.ts:40:2`;
  const repeated = row("AUTH-LIVE-008", "passed");
  repeated.result.error.stack = { api_key: markers[4], key_hash: markers[5] };
  const malformed = row("AUTH-LIVE-008", "skipped");
  malformed.test.title = { title: markers[9] };
  malformed.result.error.stack = null;
  assert.deepEqual(await report([first, repeated, malformed], null), {
    status: "failed",
    tests: [
      {
        scenario: "AUTH-LIVE-008",
        status: "failed",
        durationMs: 123,
        lastSourceLine: 39,
        failureSourceLine: 40,
      },
      { scenario: "AUTH-LIVE-008", status: "passed", durationMs: 123 },
      { scenario: "UNKNOWN", status: "skipped", durationMs: 123 },
    ],
  });
});
