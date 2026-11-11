import { expect, type Page } from "@playwright/test";
import { installDefinitionEditor } from "./golden-definition-browser";
import { promptRevisions, promptRun, workflowRevisions, workflowRun } from "./golden-run";

export async function installGoldenRunner(page: Page) {
  const fixture = await installDefinitionEditor(page);
  fixture.bootstrap.backend_version = "v0.86.67";
  const state = {
    definitions: fixture.state,
    revisions: structuredClone(promptRevisions),
    capability: true,
    lost: false,
    rejected: false,
    partial: false,
    pending: undefined as Promise<void> | undefined,
  };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await page.route(/\/admin\/golden-(prompts|workflows)(\/run-reviewed)?(?:\?.*)?$/, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (fixture.state.readStatus !== 200)
        return route.fulfill({
          status: fixture.state.readStatus,
          json: { error: { message: "public denial" } },
        });
      return route.fulfill({
        json:
          path === "/admin/golden-prompts"
            ? {
                golden_prompts: fixture.state.prompts,
                results: [],
                ...(state.capability ? { run_revisions: state.revisions } : {}),
              }
            : {
                workflows: fixture.state.workflows,
                ...(state.capability ? { run_revisions: workflowRevisions } : {}),
              },
      });
    }
    if (request.method() !== "POST" || !path.endsWith("/run-reviewed")) return route.fallback();
    calls.push({ path, body: request.postDataJSON() as Record<string, unknown> });
    if (state.pending) await state.pending;
    if (state.lost) return route.abort("failed");
    if (state.rejected)
      return route.fulfill({
        status: 409,
        json: { error: { message: "public changed definition", code: "golden_run_changed" } },
      });
    const result = structuredClone(path.includes("prompts") ? promptRun : workflowRun);
    if (state.partial) {
      result.complete = false;
      result.planned_total = 4;
    }
    return route.fulfill({ json: result });
  });
  return {
    ...fixture,
    state,
    calls,
    check: () => {
      fixture.check();
      expect(fixture.writes).toHaveLength(0);
    },
  };
}
