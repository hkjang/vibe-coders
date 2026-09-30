import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

const scenarios = new Set([
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
  "AUTH-LIVE-011",
]);
const sourceFiles = new Set(["auth-live.spec.ts", "access-live.spec.ts", "recovery-live.spec.ts"]);
const testStatuses = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);
const runStatuses = new Set(["passed", "failed", "timedout", "interrupted"]);

function sourceLine(file: unknown, line: unknown): number | undefined {
  // Split both platform separators without accepting filename suffixes or a
  // trailing separator. No portion of the source path is ever serialized.
  const name = typeof file === "string" ? file.split(/[\\/]/u).at(-1) : undefined;
  return name && sourceFiles.has(name) && typeof line === "number" && Number.isSafeInteger(line) && line > 0
    ? line
    : undefined;
}

function failureSourceLine(stack: unknown): number | undefined {
  if (typeof stack !== "string") return undefined;
  for (const frame of stack.split("\n")) {
    const location = /^\s*at (?:.+ \()?(.+):([1-9]\d*):([1-9]\d*)\)?$/u.exec(frame);
    if (!location) continue;
    const line = sourceLine(location[1], Number(location[2]));
    const column = Number(location[3]);
    if (line !== undefined && Number.isSafeInteger(column)) return line;
  }
  return undefined;
}

/** No error text, steps, URLs, request bodies, attachments, or authentication
 * values are written. The harness also suppresses child stdout and stderr. */
export default class SafeAuthReporter implements Reporter {
  private results: {
    scenario: string;
    status: TestResult["status"];
    durationMs: number;
    lastSourceLine?: number;
    failureSourceLine?: number;
  }[] = [];
  private sourceLines = new Map<string, number>();

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    const line = sourceLine(step.location?.file, step.location?.line);
    if (line !== undefined) this.sourceLines.set(test.id, line);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const candidate = typeof test.title === "string" ? test.title.split(" ")[0] : undefined;
    const scenario = candidate && scenarios.has(candidate) ? candidate : "UNKNOWN";
    const duration = result.duration;
    this.results.push({
      scenario,
      status: testStatuses.has(result.status) ? result.status : "failed",
      durationMs:
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration >= 0 &&
        duration <= Number.MAX_SAFE_INTEGER
          ? duration
          : 0,
      lastSourceLine: this.sourceLines.get(test.id),
      failureSourceLine: failureSourceLine(result.error?.stack),
    });
    this.sourceLines.delete(test.id);
  }

  async onEnd(result: FullResult): Promise<void> {
    const directory = resolve("test-results");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "auth-live-summary.json"),
      JSON.stringify(
        { status: runStatuses.has(result.status) ? result.status : "failed", tests: this.results },
        null,
        2,
      ) + "\n",
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
