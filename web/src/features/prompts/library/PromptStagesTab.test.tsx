import { useReducer } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { stagePage, stageRow } from "../../../../tests/fixtures/prompt-stage-data";
import { PromptLibraryPage } from "./PromptLibraryPage";
const runtime = vi.hoisted(() => ({
  version: "v0.86.132",
  id: "operator",
  scopes: ["admin:read", "admin:write"],
  readOnly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ backendVersion: runtime.version, user: { id: runtime.id }, scopes: runtime.scopes }),
  };
});
function setup(
  read: ApiHandler = () => stagePage(),
  write: ApiHandler = () => ({
    reference: stageRow.reference,
    stage: "validation",
    revision: "c".repeat(43),
    updated_at: "2026-11-17T04:10:00Z",
  }),
  route = "/prompts/library?tab=promotions",
) {
  const api = mockApi({ "GET /admin/prompts/promotions": read, "POST /admin/prompts/promotions": write });
  const tree = () => (
    <FeatureAccessContext.Provider
      value={{ featureId: "prompts.library", permitted: true, readOnly: runtime.readOnly, status: "preview" }}
    >
      <PromptLibraryPage />
    </FeatureAccessContext.Provider>
  );
  let refresh: () => void = () => undefined;
  function Harness() {
    const [, redraw] = useReducer((value: number) => value + 1, 0);
    refresh = redraw;
    return tree();
  }
  const view = renderScreen(<Harness />, { route });
  return { ...view, api, user: userEvent.setup(), update: () => act(() => refresh()) };
}
beforeEach(() => {
  vi.restoreAllMocks();
  runtime.version = "v0.86.132";
  runtime.id = "operator";
  runtime.scopes = ["admin:read", "admin:write"];
  runtime.readOnly = false;
});
async function draft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "단계 변경" }));
  const dialog = within(screen.getByRole("dialog", { name: "프롬프트 단계 변경" }));
  await user.selectOptions(dialog.getByRole("combobox", { name: "변경할 단계" }), "validation");
  await user.type(dialog.getByRole("textbox", { name: "변경 사유" }), "검증 결과 확인");
  return dialog;
}
describe("프롬프트 단계 관리", () => {
  it("requires review and commits once with the reviewed revision", async () => {
    const view = setup();
    const dialog = await draft(view.user);
    expect(dialog.getByRole("region", { name: "변경 전후 확인" })).toBeVisible();
    await view.user.click(dialog.getByRole("button", { name: "확인한 단계로 변경" }));
    await dialog.findByText("변경 내용을 확인해 주세요.");
    expect(view.api.calls.filter((call) => call.key.startsWith("POST"))).toHaveLength(0);
    await view.user.click(dialog.getByRole("checkbox"));
    await view.user.click(dialog.getByRole("button", { name: "확인한 단계로 변경" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const writes = view.api.calls.filter((call) => call.key.startsWith("POST"));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.options).toMatchObject({
      query: { view: "workspace" },
      body: {
        name: stageRow.name,
        version: "v1",
        revision: stageRow.revision,
        stage: "validation",
        reason: "검증 결과 확인",
      },
    });
  });
  it("clears confirmation after editing and never submits an unchanged stage", async () => {
    const view = setup();
    const dialog = await draft(view.user);
    await view.user.click(dialog.getByRole("checkbox"));
    await view.user.type(dialog.getByRole("textbox", { name: "변경 사유" }), " 완료");
    expect(dialog.getByRole("checkbox")).not.toBeChecked();
    await view.user.selectOptions(dialog.getByRole("combobox", { name: "변경할 단계" }), "experiment");
    await view.user.click(dialog.getByRole("checkbox"));
    await view.user.click(dialog.getByRole("button", { name: "확인한 단계로 변경" }));
    await dialog.findByText("현재와 다른 단계를 선택하세요.");
    expect(view.api.calls.filter((call) => call.key.startsWith("POST"))).toHaveLength(0);
  });
  it("keeps the draft but blocks a stale review without retry", async () => {
    const view = setup(undefined, () => {
      throw apiFailure("private-conflict", 409);
    });
    const dialog = await draft(view.user);
    await view.user.click(dialog.getByRole("checkbox"));
    await view.user.click(dialog.getByRole("button", { name: "확인한 단계로 변경" }));
    await dialog.findByText(/다른 관리자가 단계를 수정/);
    expect(dialog.getByRole("textbox", { name: "변경 사유" })).toHaveValue("검증 결과 확인");
    expect(dialog.getByRole("button", { name: "확인한 단계로 변경" })).toBeDisabled();
    expect(view.api.calls.filter((call) => call.key.startsWith("POST"))).toHaveLength(1);
    expect(screen.queryByText("private-conflict")).not.toBeInTheDocument();
  });
  it("blocks uncertain acknowledgements and malformed success receipts", async () => {
    const view = setup(undefined, () => ({
      reference: "x".repeat(43),
      stage: "validation",
      revision: "c".repeat(43),
      updated_at: "2026-11-17T04:10:00Z",
    }));
    const dialog = await draft(view.user);
    await view.user.click(dialog.getByRole("checkbox"));
    await view.user.click(dialog.getByRole("button", { name: "확인한 단계로 변경" }));
    await dialog.findByText("이전 작업 결과 확인 필요");
    expect(dialog.getByRole("button", { name: "확인한 단계로 변경" })).toBeDisabled();
  });
  it("preserves a draft when edit permission is withdrawn", async () => {
    const view = setup();
    const dialog = await draft(view.user);
    runtime.readOnly = true;
    view.update();
    await dialog.findByText("읽기 전용으로 전환됐습니다.");
    expect(dialog.getByRole("textbox", { name: "변경 사유" })).toHaveValue("검증 결과 확인");
    expect(dialog.getByRole("button", { name: "확인한 단계로 변경" })).toBeDisabled();
  });
  it("does not expose an editable row to a reader", async () => {
    runtime.scopes = ["admin:read"];
    setup();
    expect(await screen.findByRole("button", { name: "단계 변경" })).toBeDisabled();
  });
  it("does not fetch unsupported workspace contracts", async () => {
    runtime.version = "v0.86.131";
    const view = setup();
    await screen.findByText(/백엔드 v0.86.132 이상/);
    expect(view.api.calls).toEqual([]);
  });
  it("restores period/stage/page from the URL and rejects mismatched receipts", async () => {
    const view = setup(
      () => stagePage(),
      undefined,
      "/prompts/library?tab=promotions&stages_stage=production&stages_window=24h&stages_page=2",
    );
    await screen.findAllByText("프롬프트 단계를 조회하지 못했습니다.");
    expect(view.api.calls[0]?.options.query).toMatchObject({
      stage: "production",
      window: "24h",
      offset: 25,
    });
    expect(screen.queryByText(stageRow.name)).not.toBeInTheDocument();
  });
  it("retires data on read denial and recovers only after explicit recheck", async () => {
    let denied = false;
    const view = setup(() => {
      if (denied) throw apiFailure("private-denial", 403);
      return stagePage();
    });
    await screen.findByText(stageRow.name);
    denied = true;
    await view.user.click(screen.getByRole("button", { name: "새로고침" }));
    await screen.findByRole("heading", { name: "프롬프트 보관함 조회 권한 확인 필요" });
    expect(screen.queryByText(stageRow.name)).not.toBeInTheDocument();
    denied = false;
    await view.user.click(screen.getByRole("button", { name: "권한 확인 후 다시 조회" }));
    await screen.findByText(stageRow.name);
  });
  it("keeps sensitive input out of the mutation", async () => {
    const view = setup();
    const dialog = await draft(view.user);
    await view.user.clear(dialog.getByRole("textbox", { name: "변경 사유" }));
    await view.user.type(dialog.getByRole("textbox", { name: "변경 사유" }), "token=private-credential");
    await view.user.click(dialog.getByRole("checkbox"));
    await view.user.click(dialog.getByRole("button", { name: "확인한 단계로 변경" }));
    await dialog.findByText(/비밀정보나 줄바꿈 없이/);
    expect(view.api.calls.filter((call) => call.key.startsWith("POST"))).toHaveLength(0);
  });
  it("locks a credential-shaped identity before it reaches a write form", async () => {
    setup(() => stagePage([{ ...stageRow, name: "vc_sk_private_credential_example" }]));
    expect(await screen.findByRole("button", { name: "단계 변경" })).toBeDisabled();
    expect(screen.queryByText("vc_sk_private_credential_example")).not.toBeInTheDocument();
  });
});
