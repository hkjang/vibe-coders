import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

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
    if (step.location?.file.endsWith("/auth-live.spec.ts") && step.location.line > 40) {
      this.sourceLines.set(test.id, step.location.line);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const scenario = /^AUTH-LIVE-\d{3}$/.exec(test.title.split(" ")[0] ?? "")?.[0] ?? "UNKNOWN";
    this.results.push({
      scenario,
      status: result.status,
      durationMs: result.duration,
      lastSourceLine: this.sourceLines.get(test.id),
      failureSourceLine: result.error?.stack?.match(/auth-live\.spec\.ts:(\d+):\d+/)?.[1]
        ? Number(result.error.stack.match(/auth-live\.spec\.ts:(\d+):\d+/)?.[1])
        : undefined,
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    const directory = resolve("test-results");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "auth-live-summary.json"),
      JSON.stringify({ status: result.status, tests: this.results }, null, 2) + "\n",
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
