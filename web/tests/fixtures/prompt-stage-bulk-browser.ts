import type { Page } from "@playwright/test";
import type { PromptStageBulkApply } from "../../src/shared/api/generated";
import { installPromptStages } from "./prompt-stage-browser";
import { bulkStageReview } from "./prompt-stage-bulk-data";

export async function installBulkStage(page: Page, readOnly = false) {
  const fixture = await installPromptStages(page, readOnly);
  fixture.bootstrap.backend_version = "v0.86.133";
  const now = Date.parse("2026-11-17T04:00:00Z");
  await page.clock.setFixedTime(new Date(now));
  const review = bulkStageReview(now);
  const state = { status: 200, writeStatus: 200, applied: false };
  const reads: URLSearchParams[] = [],
    changes: PromptStageBulkApply[] = [];
  await page.route("**/admin/prompts/promotions?*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.searchParams.get("view") !== "promotion-review") return route.fallback();
    if (request.method() === "GET") {
      reads.push(url.searchParams);
      if (state.status !== 200)
        return route.fulfill({ status: state.status, json: { error: { message: "private-bulk-error" } } });
      return route.fulfill({ json: review });
    }
    if (request.method() !== "POST") throw Error("Unexpected bulk method");
    const body: PromptStageBulkApply = request.postDataJSON();
    changes.push(body);
    if (state.writeStatus !== 200 || state.applied || body.revision !== review.revision)
      return route.fulfill({
        status: state.writeStatus === 200 ? 409 : state.writeStatus,
        json: { error: { message: "private-bulk-write-error" } },
      });
    state.applied = true;
    return route.fulfill({
      json: {
        count: review.items.length,
        updated_at: new Date(now + 10000).toISOString(),
        review_revision: review.revision,
      },
    });
  });
  return { ...fixture, bulkReads: reads, bulkChanges: changes, bulkState: state, review };
}
