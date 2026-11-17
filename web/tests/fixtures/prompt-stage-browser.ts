import type { Page } from "@playwright/test";
import type { PromptStageChange, PromptStageWorkspaceItem } from "../../src/shared/api/generated";
import { installPromptLibrary } from "./prompt-library-browser";
import { stagePage, stageRow } from "./prompt-stage-data";
export async function installPromptStages(page: Page, readOnly = false) {
  const fixture = await installPromptLibrary(page, readOnly);
  fixture.bootstrap.backend_version = "v0.86.132";
  const state = { status: 200, writeStatus: 200, empty: false };
  const reads: URLSearchParams[] = [];
  const changes: PromptStageChange[] = [];
  const rows: PromptStageWorkspaceItem[] = Array.from({ length: 31 }, (_, i) => ({
    ...stageRow,
    reference: String(i).padStart(43, "a"),
    name: i === 0 ? "업무 요약" : `업무 프롬프트 ${i + 1}`,
    stage: i % 3 === 0 ? "experiment" : i % 3 === 1 ? "validation" : "production",
    calls: i * 4,
    errors: 0,
    evaluation_failures: i,
    eligible_stage: "",
  }));
  await page.route("**/admin/prompts/promotions?*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.searchParams.get("view") !== "workspace") throw Error("Unexpected legacy stage request");
    if (request.method() === "POST") {
      const body: PromptStageChange = request.postDataJSON();
      changes.push(body);
      if (state.writeStatus !== 200)
        return route.fulfill({
          status: state.writeStatus,
          json: { error: { message: "private-stage-error" } },
        });
      const row = rows.find((row) => row.name === body.name && row.version === body.version);
      if (!row || row.revision !== body.revision)
        return route.fulfill({ status: 409, json: { error: { message: "private-conflict" } } });
      row.stage = body.stage;
      row.updated_at = "2026-11-17T04:10:00Z";
      row.revision = "c".repeat(43);
      return route.fulfill({
        json: {
          reference: row.reference,
          stage: row.stage,
          revision: row.revision,
          updated_at: row.updated_at,
        },
      });
    }
    if (request.method() !== "GET") throw Error("Unexpected stage method");
    reads.push(url.searchParams);
    if (state.status !== 200)
      return route.fulfill({ status: state.status, json: { error: { message: "private-stage-error" } } });
    const stage = url.searchParams.get("stage"),
      window = url.searchParams.get("window"),
      limit = Number(url.searchParams.get("limit")),
      offset = Number(url.searchParams.get("offset"));
    const filtered = state.empty ? [] : rows.filter((row) => stage === "all" || row.stage === stage);
    return route.fulfill({
      json: {
        ...stagePage(filtered.slice(offset, offset + limit)),
        total: filtered.length,
        stage,
        window,
        limit,
        offset,
      },
    });
  });
  return { ...fixture, state, reads, changes, rows };
}
