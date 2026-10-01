import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

// This private report contains only booleans and bounded integers. Never retain
// titles, values, errors, attachments, URLs, response data or browser snapshots.
export default class SafeProviderReporter implements Reporter {
  private passed = true;
  private testCount = 0;
  private sourceLine = 0;

  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep): void {
    const location = step.location;
    if (
      location?.file.split(/[\\/]/u).at(-1) === "provider-connection.spec.ts" &&
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
  }

  async onEnd(result: FullResult): Promise<void> {
    const target = process.env.VIBE_PROVIDER_CONNECTION_SUMMARY;
    const scratch = process.env.TMPDIR;
    if (!target || !scratch || dirname(resolve(target)) !== resolve(scratch)) {
      throw new Error("Provider summary requires harness-owned private scratch.");
    }
    await writeFile(
      target,
      JSON.stringify({
        passed: this.passed && result.status === "passed" && this.testCount === 1,
        test_count: this.testCount,
        source_line: this.sourceLine,
      }),
      { mode: 0o600 },
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
