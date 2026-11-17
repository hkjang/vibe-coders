import { useReducer } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { stageQuerySchema } from "@/shared/api/domains/prompt-stages";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { bulkStageReview } from "../../../../tests/fixtures/prompt-stage-bulk-data";
import { stagePage, stageRow } from "../../../../tests/fixtures/prompt-stage-data";
import { PromptLibraryPage } from "./PromptLibraryPage";
const runtime = vi.hoisted(() => ({ version: "v0.86.133", readOnly: false }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ backendVersion: runtime.version, scopes: ["admin:read", "admin:write"] }),
  };
});
beforeEach(() => {
  vi.restoreAllMocks();
  runtime.version = "v0.86.133";
  runtime.readOnly = false;
});
function setup(review = bulkStageReview(), write?: ApiHandler, route = "/prompts/library?tab=promotions") {
  const api = mockApi({
    "GET /admin/prompts/promotions": ({ query }) => {
      if ((query as { view?: string })?.view === "promotion-review") return review;
      const q = stageQuerySchema.parse(query);
      return {
        ...stagePage([{ ...stageRow, stage: q.stage === "all" ? "experiment" : q.stage }]),
        window: q.window,
        stage: q.stage,
        offset: q.offset,
        limit: q.limit,
        total: q.offset + 1,
      };
    },
    "POST /admin/prompts/promotions":
      write ??
      (() => ({
        count: review.items.length,
        updated_at: new Date().toISOString(),
        review_revision: review.revision,
      })),
  });
  let refresh: () => void = () => undefined;
  function Harness() {
    const [, render] = useReducer((v: number) => v + 1, 0);
    refresh = render;
    return (
      <FeatureAccessContext.Provider
        value={{
          featureId: "prompts.library",
          permitted: true,
          readOnly: runtime.readOnly,
          status: "preview",
        }}
      >
        <PromptLibraryPage />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Harness />, { route });
  return { ...view, api, user: userEvent.setup(), update: () => act(() => refresh()), review };
}
async function open(view: ReturnType<typeof setup>) {
  await view.user.click(await screen.findByRole("button", { name: "일괄 승격 검토" }));
  await screen.findByText(/관측 버전 .*변경 대상/);
  return within(screen.getByRole("dialog", { name: "프롬프트 일괄 승격 검토" }));
}
async function fill(view: ReturnType<typeof setup>, dialog: ReturnType<typeof within>, count = "2") {
  await view.user.type(dialog.getByRole("textbox", { name: /^변경 사유/ }), "전체 변경 대상 확인");
  await view.user.type(dialog.getByRole("textbox", { name: /^변경할 버전 수 확인/ }), count);
  await view.user.click(dialog.getByRole("checkbox"));
}
describe("일괄 승격 검토", () => {
  it("keeps the reviewed plan and confirmation fixed during global refresh", async () => {
    const view = setup();
    const dialog = await open(view);
    await fill(view, dialog);
    const reads = () =>
      view.api.calls.filter((call) => (call.options.query as { view?: string })?.view === "promotion-review")
        .length;
    expect(reads()).toBe(1);
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["prompts"] });
    });
    expect(reads()).toBe(1);
    expect(dialog.getByRole("checkbox")).toBeChecked();
    expect(dialog.getByRole("textbox", { name: /^변경 사유/ })).toHaveValue("전체 변경 대상 확인");
  });
  it("preserves the reviewed draft but blocks newly withdrawn edit permission", async () => {
    const view = setup();
    const dialog = await open(view);
    await fill(view, dialog);
    runtime.readOnly = true;
    view.update();
    await dialog.findByText("읽기 전용으로 전환됐습니다.");
    expect(dialog.getByRole("button", { name: "확인한 2개 승격" })).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: /^변경 사유/ })).toHaveValue("전체 변경 대상 확인");
    expect(view.api.bodies("POST /admin/prompts/promotions")).toEqual([]);
  });
  it("requires the total count, reason and review before exactly one atomic request", async () => {
    const view = setup();
    const dialog = await open(view);
    expect(view.api.bodies("POST /admin/prompts/promotions")).toEqual([]);
    await fill(view, dialog, "1");
    await view.user.click(dialog.getByRole("button", { name: "확인한 2개 승격" }));
    await dialog.findByText("전체 변경 대상 수를 정확히 입력하세요.");
    expect(view.api.bodies("POST /admin/prompts/promotions")).toEqual([]);
    const input = dialog.getByRole("textbox", { name: /^변경할 버전 수 확인/ });
    await view.user.clear(input);
    await view.user.type(input, "2");
    expect(dialog.getByRole("checkbox")).not.toBeChecked();
    await view.user.click(dialog.getByRole("checkbox"));
    await view.user.click(dialog.getByRole("button", { name: "확인한 2개 승격" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(view.api.bodies("POST /admin/prompts/promotions")).toEqual([
      {
        window: view.review.window,
        since: view.review.since,
        until: view.review.until,
        revision: view.review.revision,
        reason: "전체 변경 대상 확인",
      },
    ]);
  });
  it("reviews the entire selected interval without applying page or stage filters", async () => {
    const view = setup(
      bulkStageReview(Date.now(), 2, "24h"),
      undefined,
      "/prompts/library?tab=promotions&stages_window=24h&stages_stage=production&stages_page=2",
    );
    await open(view);
    expect(
      view.api.calls
        .filter((c) => (c.options.query as { view?: string })?.view === "promotion-review")
        .map((c) => c.options.query),
    ).toEqual([{ view: "promotion-review", window: "24h" }]);
  });
  it("does not retry a conflicted batch and preserves its draft", async () => {
    const view = setup(undefined, () => {
      throw apiFailure("private-conflict", 409);
    });
    const dialog = await open(view);
    await fill(view, dialog);
    await view.user.click(dialog.getByRole("button", { name: "확인한 2개 승격" }));
    await dialog.findByText(/검토 이후 단계·관측 기록/);
    expect(dialog.getByRole("button", { name: "확인한 2개 승격" })).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: /^변경 사유/ })).toHaveValue("전체 변경 대상 확인");
    expect(view.api.bodies("POST /admin/prompts/promotions")).toHaveLength(1);
  });
  it("treats a mismatched receipt as uncertain", async () => {
    const view = setup(undefined, () => ({
      count: 1,
      updated_at: new Date().toISOString(),
      review_revision: "r".repeat(43),
    }));
    const dialog = await open(view);
    await fill(view, dialog);
    await view.user.click(dialog.getByRole("button", { name: "확인한 2개 승격" }));
    await dialog.findByText("이전 작업 결과 확인 필요");
    expect(dialog.getByRole("button", { name: "확인한 2개 승격" })).toBeDisabled();
  });
  it("blocks an expired review and a later loss of edit permission", async () => {
    const view = setup(bulkStageReview(Date.now() - 301000));
    const dialog = await open(view);
    await dialog.findByText(/검토 유효 시간이 지났습니다/);
    expect(dialog.getByRole("button", { name: "확인한 2개 승격" })).toBeDisabled();
    runtime.readOnly = true;
    view.update();
    await dialog.findByText("읽기 전용으로 전환됐습니다.");
    expect(dialog.getByRole("textbox", { name: /^변경 사유/ })).toBeDisabled();
    expect(view.api.bodies("POST /admin/prompts/promotions")).toEqual([]);
  });
  it.each(["empty", "unsafe"])("does not apply an %s plan", async (mode) => {
    const review = bulkStageReview(Date.now(), mode === "empty" ? 0 : 2);
    if (mode === "unsafe") {
      const first = review.items[0];
      if (!first) throw new Error("Missing unsafe review fixture");
      first.name = "token=private-credential";
    }
    const view = setup(review);
    const dialog = await open(view);
    expect(
      dialog.getByRole("button", { name: mode === "empty" ? "확인한 0개 승격" : "확인한 2개 승격" }),
    ).toBeDisabled();
    if (mode === "unsafe") {
      await dialog.findByText(/안전하게 표시하거나 변경할 수 없는 대상/);
      expect(screen.queryByText("token=private-credential")).not.toBeInTheDocument();
    }
  });
  it("keeps the bulk feature unavailable on an older server", async () => {
    runtime.version = "v0.86.132";
    setup();
    await screen.findByText("업무 요약", { exact: true });
    expect(screen.queryByRole("button", { name: "일괄 승격 검토" })).not.toBeInTheDocument();
  });
});
