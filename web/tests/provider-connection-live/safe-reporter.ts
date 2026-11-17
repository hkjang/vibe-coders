import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

// This private report contains only booleans and bounded integers. Never retain
// titles, values, errors, attachments, URLs, response data or browser snapshots.
export default class SafeProviderReporter implements Reporter {
  private passed = true;
  private testCount = 0;
  private sourceLine = 0;
  private firstFailureLine: number | undefined;
  private readonly redteam: boolean;

  constructor(options: { workflow?: "provider" | "redteam" } = {}) {
    if (options.workflow !== undefined && options.workflow !== "provider" && options.workflow !== "redteam")
      throw new Error("Unknown isolated workflow reporter.");
    this.redteam = options.workflow === "redteam";
  }

  onTestBegin(): void {
    this.sourceLine = 0;
  }

  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep): void {
    const location = step.location;
    if (
      location?.file.split(/[\\/]/u).at(-1) ===
        (this.redteam ? "redteam.spec.ts" : "provider-connection.spec.ts") &&
      Number.isSafeInteger(location.line) &&
      location.line > 0 &&
      location.line <= 10000
    ) {
      this.sourceLine = location.line;
    }
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    this.testCount += 1;
    this.passed &&= result.status === "passed" && result.retry === 0;
    if (result.status !== "passed" || result.retry !== 0) this.firstFailureLine ??= this.sourceLine;
  }

  async onEnd(result: FullResult): Promise<void> {
    const target = this.redteam
      ? process.env.VIBE_REDTEAM_BROWSER_SUMMARY
      : process.env.VIBE_PROVIDER_CONNECTION_SUMMARY;
    const scratch = process.env.TMPDIR;
    if (!target || !scratch || dirname(resolve(target)) !== resolve(scratch)) {
      throw new Error("Provider summary requires harness-owned private scratch.");
    }
    await writeFile(
      target,
      JSON.stringify({
        passed: this.passed && result.status === "passed" && this.testCount === (this.redteam ? 11 : 1),
        test_count: this.testCount,
        source_line: this.firstFailureLine ?? this.sourceLine,
      }),
      { mode: 0o600 },
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
