import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const reporterUrl = new URL("../tests/provider-connection-live/safe-reporter.ts", import.meta.url).href;
const markers = [
  "SYNTHETIC_PROVIDER_TITLE_11",
  "SYNTHETIC_PROVIDER_ERROR_22",
  "https://private.invalid/?api_key=SYNTHETIC_PROVIDER_URL_33",
  "SYNTHETIC_PROVIDER_REQUEST_BODY_44",
  "SYNTHETIC_PROVIDER_RESPONSE_BODY_55",
  "Bearer SYNTHETIC_PROVIDER_AUTHORIZATION_66",
  "SYNTHETIC_PROVIDER_STDOUT_77",
  "SYNTHETIC_PROVIDER_STDERR_88",
  "SYNTHETIC_PROVIDER_ATTACHMENT_99",
  "vc_sk_SYNTHETIC_PROVIDER_DRAFT_KEY_DO_NOT_USE",
];
const sensitive = markers.join(" ");

// Exercise the actual reporter through native Node type stripping. Capture the
// child's streams; neither a reporter bug nor a thrown error may print canaries.
const runner = `
  import { readFileSync } from "node:fs";
  const input = JSON.parse(readFileSync(0, "utf8"));
  try {
    const { default: SafeProviderReporter } = await import(process.argv[1]);
    const reporter = new SafeProviderReporter();
    if (reporter.printsToStdio() !== false) process.exit(2);
    reporter.onBegin?.(input.config, input.suite);
    for (const row of input.rows) {
      reporter.onTestBegin?.(row.test, row.result);
      reporter.onStdOut?.(Buffer.from(input.sensitive), row.test, row.result);
      reporter.onStdErr?.(Buffer.from(input.sensitive), row.test, row.result);
      for (const step of row.steps) {
        if (step.nonFiniteLine) step.location.line = Number(step.nonFiniteLine);
        reporter.onStepBegin?.(row.test, row.result, step);
        reporter.onStepEnd?.(row.test, row.result, step);
      }
      reporter.onTestEnd(row.test, row.result);
    }
    reporter.onError?.({ message: input.sensitive, stack: input.sensitive });
    await reporter.onEnd(input.fullResult);
    await reporter.onExit?.();
  } catch {
    // Do not serialize even the rejection error or its potentially private path.
    process.exitCode = 3;
  }
`;

function row(status = "passed", retry = 0, steps = []) {
  return {
    test: {
      id: sensitive,
      title: sensitive,
      location: { file: `/private/${sensitive}/provider-connection.spec.ts`, line: 50, column: 1 },
      annotations: [{ type: sensitive, description: sensitive }],
      tags: [sensitive],
    },
    result: {
      status,
      retry,
      duration: sensitive,
      error: { message: sensitive, stack: sensitive },
      errors: [{ message: sensitive, stack: sensitive }],
      attachments: [{ name: sensitive, contentType: sensitive, path: sensitive, body: sensitive }],
      stdout: [sensitive],
      stderr: [sensitive],
      headers: { Authorization: markers[5], "Set-Cookie": sensitive },
      request: { url: markers[2], body: markers[3], api_key: markers[9] },
      response: { body: markers[4], headers: { "Set-Cookie": sensitive } },
    },
    steps,
  };
}

function step(line, file = `/private/${sensitive}/provider-connection.spec.ts`) {
  return { title: sensitive, error: { message: sensitive }, location: { file, line, column: 1 } };
}

function assertSafeSummary(raw) {
  for (const marker of markers)
    assert.equal(raw.includes(marker), false, "The summary must omit every synthetic secret");
  const summary = JSON.parse(raw);
  assert.deepEqual(Object.keys(summary).sort(), ["passed", "source_line", "test_count"]);
  assert.equal(typeof summary.passed, "boolean");
  assert.equal(Number.isSafeInteger(summary.test_count) && summary.test_count >= 0, true);
  assert.equal(
    Number.isSafeInteger(summary.source_line) && summary.source_line >= 0 && summary.source_line <= 10000,
    true,
  );
  return summary;
}

async function report(rows, status = "passed", outputCase = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "vibe-provider-report-"));
  const scratch = join(directory, "private");
  const outside = join(directory, "outside");
  try {
    await mkdir(scratch, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    const target = join(scratch, "provider-summary.json");
    const environment = {
      ...process.env,
      TMPDIR: scratch,
      VIBE_PROVIDER_CONNECTION_SUMMARY: target,
    };
    switch (outputCase) {
      case "missing target":
        delete environment.VIBE_PROVIDER_CONNECTION_SUMMARY;
        break;
      case "missing scratch":
        delete environment.TMPDIR;
        break;
      case "outside absolute":
        environment.VIBE_PROVIDER_CONNECTION_SUMMARY = join(outside, "private-summary.json");
        break;
      case "outside relative":
        environment.VIBE_PROVIDER_CONNECTION_SUMMARY = "../outside/private-summary.json";
        break;
      case "outside traversal":
        environment.VIBE_PROVIDER_CONNECTION_SUMMARY = join(scratch, "..", "outside", "summary.json");
        break;
      case "nested target":
        environment.VIBE_PROVIDER_CONNECTION_SUMMARY = join(scratch, "nested", "summary.json");
        break;
    }
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", runner, reporterUrl], {
      cwd: scratch,
      env: environment,
      input: JSON.stringify({
        sensitive,
        rows,
        config: { metadata: { secret: sensitive }, use: { extraHTTPHeaders: { Authorization: sensitive } } },
        suite: { title: sensitive, tests: rows.map((entry) => entry.test) },
        fullResult: { status, startTime: sensitive, duration: sensitive, error: { message: sensitive } },
      }),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
    });
    assert.equal(child.error === undefined, true, "The isolated reporter child must finish");
    assert.equal(child.stdout === "" && child.stderr === "", true, "The reporter must remain silent");
    assert.deepEqual(await readdir(outside), [], "The reporter must not write outside private scratch");
    if (outputCase !== "valid") {
      assert.equal(child.status, 3, "Invalid output configuration must reject without printing errors");
      assert.deepEqual(await readdir(scratch), [], "Rejected output configuration must write nothing");
      return;
    }
    assert.equal(child.status, 0, "The real TS reporter must work without a copied implementation");
    assert.deepEqual(await readdir(scratch), ["provider-summary.json"]);
    assert.equal(
      (await stat(target)).mode & 0o777,
      0o600,
      "The safe report still belongs in private scratch",
    );
    return assertSafeSummary(await readFile(target, "utf8"));
  } finally {
    // This exact temporary directory is owned solely by this synthetic test.
    await rm(directory, { recursive: true, force: true });
  }
}

test("provider reporter emits exactly one boolean and two integers, never raw event fields", async () => {
  assert.deepEqual(await report([row("failed", 0, [step(72)])], "failed"), {
    passed: false,
    test_count: 1,
    source_line: 72,
  });
  assert.deepEqual(await report([row("passed", 0, [step(93)])]), {
    passed: true,
    test_count: 1,
    source_line: 93,
  });
});

test("provider reporter requires exactly one first-attempt successful test and successful run", async () => {
  const cases = [
    [[], "passed"],
    [[row(), row()], "passed"],
    [[row("skipped")], "passed"],
    [[row("failed")], "passed"],
    [[row("timedOut")], "timedout"],
    [[row("interrupted")], "interrupted"],
    [[row("passed", 1)], "passed"],
    [[row("failed", 0), row("passed", 1)], "passed"],
    [[row("passed", "0")], "passed"],
    [[row("passed", null)], "passed"],
    [[row("passed", -1)], "passed"],
    [[row(markers[1])], "passed"],
    [[row()], "failed"],
    [[row()], "timedout"],
    [[row()], "interrupted"],
    [[row()], markers[1]],
  ];
  for (const [rows, status] of cases)
    assert.deepEqual(await report(rows, status), {
      passed: false,
      test_count: rows.length,
      source_line: 0,
    });
});

test("provider reporter allows only bounded integer lines from the exact spec basename", async () => {
  for (const line of [0, -1, 0.5, "73", null, true, {}, 10001, Number.MAX_SAFE_INTEGER + 1])
    assert.deepEqual(await report([row("passed", 0, [step(line)])]), {
      passed: true,
      test_count: 1,
      source_line: 0,
    });
  for (const nonFiniteLine of ["NaN", "Infinity", "-Infinity"])
    assert.deepEqual(await report([row("passed", 0, [{ ...step(1), nonFiniteLine }])]), {
      passed: true,
      test_count: 1,
      source_line: 0,
    });
  for (const filename of [
    "other.spec.ts",
    "not-provider-connection.spec.ts",
    "provider-connection.spec.ts.bak",
    "provider-connection.spec.tsx",
    "provider-connection.spec.ts/",
    "provider-connection.spec.ts\\",
    `provider-connection.spec.ts?key=${markers[9]}`,
    `provider-connection.spec.ts#${markers[9]}`,
  ])
    assert.deepEqual(await report([row("passed", 0, [step(99, `/private/${filename}`)])]), {
      passed: true,
      test_count: 1,
      source_line: 0,
    });
  for (const [line, file] of [
    [1, "provider-connection.spec.ts"],
    [10000, "C:\\private\\provider-connection.spec.ts"],
  ])
    assert.deepEqual(await report([row("passed", 0, [step(line, file)])]), {
      passed: true,
      test_count: 1,
      source_line: line,
    });
});

test("provider reporter rejects missing, nested and outside-scratch targets without writing", async () => {
  for (const target of [
    "missing target",
    "missing scratch",
    "outside absolute",
    "outside relative",
    "outside traversal",
    "nested target",
  ])
    await report([row()], "passed", target);
});

async function artifactFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, "Private artifacts must not redirect outside scratch");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await artifactFiles(path)));
    else {
      assert.equal(entry.isFile(), true);
      files.push(path);
    }
  }
  return files;
}

test(
  "real provider browser forced failure keeps its DOM canary out of reports and private artifacts",
  {
    skip:
      process.env.VIBE_PROVIDER_BROWSER_ARTIFACT_TEST !== "1"
        ? "Set VIBE_PROVIDER_BROWSER_ARTIFACT_TEST=1 in the pinned Playwright image"
        : false,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibe-provider-artifact-"));
    const fixture = join(directory, "fixture");
    const scratch = join(directory, "scratch");
    const cwd = join(directory, "runner");
    const canary = `SYNTHETIC_PROVIDER_DOM_CANARY_${randomUUID()}`;
    try {
      for (const path of [fixture, scratch, cwd]) await mkdir(path, { mode: 0o700 });
      const summaryPath = join(scratch, "provider-summary.json");
      const configPath = join(fixture, "playwright.artifact.config.ts");
      const source = `import { test, expect } from ${JSON.stringify(import.meta.resolve("@playwright/test"))};
test("synthetic provider artifact failure", async ({ page }) => {
  const canary = process.env.VIBE_PROVIDER_ARTIFACT_CANARY ?? "";
  expect(canary.length > 0).toBe(true);
  await page.setContent(\`<main><h1>Provider draft</h1><code>\${canary}</code><label>API key<input value="\${canary}"></label></main>\`);
  expect(await page.evaluate((value) => document.querySelector("code")?.textContent === value && document.querySelector("input")?.value === value, canary)).toBe(true);
  expect(false, "intentional synthetic provider artifact boundary failure").toBe(true);
});
`;
      const failureLine = source.split("\n").findIndex((line) => line.includes("expect(false,")) + 1;
      await writeFile(join(fixture, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
      await writeFile(join(fixture, "provider-connection.spec.ts"), source, { mode: 0o600 });
      await writeFile(
        configPath,
        `import liveConfig from ${JSON.stringify(new URL("../playwright.provider-connection.config.ts", import.meta.url).href)};
export default { ...liveConfig, testDir: ${JSON.stringify(fixture)}, reporter: [[${JSON.stringify(fileURLToPath(reporterUrl))}]], preserveOutput: "always" };
`,
        { mode: 0o600 },
      );
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test", "--config", configPath],
        {
          cwd,
          env: {
            ...process.env,
            APP_BASE_URL: "http://127.0.0.1:1",
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
            PLAYWRIGHT_NO_COPY_PROMPT: "",
            VIBE_PROVIDER_CONNECTION_BROWSER_TEST: "1",
            VIBE_PROVIDER_CONNECTION_SUMMARY: summaryPath,
            VIBE_PROVIDER_ARTIFACT_CANARY: canary,
          },
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 1_000_000,
        },
      );
      // Never print raw runner output, even if this synthetic regression fails.
      assert.equal(
        child.error === undefined && child.status === 1,
        true,
        "The forced assertion must fail normally",
      );
      const summary = assertSafeSummary(await readFile(summaryPath, "utf8"));
      assert.deepEqual(summary, { passed: false, test_count: 1, source_line: failureLine });
      assert.deepEqual(await readdir(cwd), [], "The runner must not retain public artifacts");
      assert.equal(!child.stdout.includes(canary) && !child.stderr.includes(canary), true);
      const files = await artifactFiles(join(scratch, "provider-connection-private"));
      assert.equal(
        files.some((path) => path.endsWith("/error-context.md")),
        true,
      );
      for (const path of files) {
        assert.equal(/\.(?:png|jpe?g|webm|mp4|zip|har)$/iu.test(path), false);
        const raw = await readFile(path);
        assert.equal(raw.includes(Buffer.from(canary)), false, "Private artifacts must omit the DOM canary");
        if (path.endsWith("/error-context.md"))
          assert.equal(
            raw.includes(Buffer.from("# Page snapshot")),
            false,
            "Snapshot suppression must work before cleanup",
          );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
