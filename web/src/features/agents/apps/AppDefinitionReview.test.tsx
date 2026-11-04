import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppPage } from "./AppPage";
import { AppDefinitionReview } from "./AppDefinitionReview";
import { appFormDefaults, appFormSchema } from "./app-form";
import { deferred } from "./app-permission-test-support";
import { FeatureAccessHarness } from "@/test/feature-access";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
const app = {
  id: "review-app",
  title: "기존 업무 앱",
  description: "기존 설명",
  status: "active",
  owner: "owner",
  components: [{ kind: "model", ref: "model-a", label: "추천 모델" }],
  allowed_teams: "platform",
  allowed_roles: "developer",
};
const checklist = {
  ready: true,
  missing: 0,
  checks: ["title", "owner", "components", "description", "access_scope"].map((key, i) => ({
    key,
    severity: i < 3 ? "required" : "recommended",
    ok: true,
    detail: "공개 점검 결과",
  })),
};
const render = () =>
  renderScreen(
    <FeatureAccessHarness featureId="agents.apps">
      <AppPage />
    </FeatureAccessHarness>,
    { path: "/agents/apps", route: "/agents/apps" },
  );
async function edit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: `${app.title} 상세 열기` }));
  await user.click(
    within(screen.getByRole("dialog", { name: app.title })).getByRole("button", { name: "수정" }),
  );
  return screen.findByRole("dialog", { name: "AI 업무 앱 수정" });
}
describe("업무 앱 정의 검토", () => {
  it.each(["변경 내용 검토", "온보딩 준비도 확인"])(
    "%s의 폼 검증 도중 입력 변경은 이전 스냅샷을 사용하지 않는다",
    async (action) => {
      const api = mockApi({
        "GET /admin/apps": () => ({ apps: [app] }),
        "POST /admin/apps/onboarding-check": () => checklist,
      });
      const user = userEvent.setup();
      render();
      const form = await edit(user);
      fireEvent.click(within(form).getByRole("button", { name: action }));
      fireEvent.change(within(form).getByRole("textbox", { name: /제목/u }), {
        target: { value: "검증 중 변경" },
      });
      await act(async () => undefined);
      expect(api.bodies("POST /admin/apps/onboarding-check")).toEqual([]);
      expect(
        within(form).queryByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다." }),
      ).not.toBeInTheDocument();
    },
  );
  it("민감한 값은 비교에 표시하지 않으면서 서로 다른 값을 유지로 표시하지 않는다", () => {
    const before = "org-secret-" + "a".repeat(40);
    const after = "org-secret-" + "b".repeat(40);
    const values = appFormSchema.parse({ ...appFormDefaults(app), description: after });
    renderScreen(
      <AppDefinitionReview
        app={{ ...app, description: before }}
        values={values}
        prefixes={["org-secret-"]}
      />,
    );
    const row = screen.getByRole("rowheader", { name: "설명 · 변경" }).closest("tr");
    expect(row).toHaveTextContent("민감한 값은 비교에 표시하지 않습니다.");
    expect(row).not.toHaveTextContent(before);
    expect(row).not.toHaveTextContent(after);
  });
  it("변경 전후를 확인하기 전 저장하지 않고 검토한 정규화 본문만 저장한다", async () => {
    const api = mockApi({
      "GET /admin/apps": () => ({ apps: [app] }),
      "PATCH /admin/apps/review-app": () => app,
    });
    const user = userEvent.setup();
    render();
    const form = await edit(user);
    const title = within(form).getByRole("textbox", { name: /제목/u });
    await user.clear(title);
    await user.type(title, "  바뀐 제목  ");
    expect(within(form).getByRole("button", { name: "수정 저장" })).toBeDisabled();
    await user.click(within(form).getByRole("button", { name: "변경 내용 검토" }));
    const comparison = within(form).getByRole("table", { name: "업무 앱 변경 전후" });
    expect(comparison).toHaveTextContent(app.title);
    expect(comparison).toHaveTextContent("바뀐 제목");
    await user.click(within(form).getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다." }));
    await user.click(within(form).getByRole("button", { name: "수정 저장" }));
    await waitFor(() => expect(api.bodies("PATCH /admin/apps/review-app")).toHaveLength(1));
    expect(api.bodies("PATCH /admin/apps/review-app")[0]).toEqual(
      expect.objectContaining({ title: "바뀐 제목", allowed_teams: "platform" }),
    );
  });
  it("검토 후 값을 바꿨다가 복원해도 다시 검토해야 한다", async () => {
    const api = mockApi({ "GET /admin/apps": () => ({ apps: [app] }) });
    const user = userEvent.setup();
    render();
    const form = await edit(user);
    await user.click(within(form).getByRole("button", { name: "변경 내용 검토" }));
    await user.click(within(form).getByRole("checkbox", { name: "변경 내용과 적용 범위를 확인했습니다." }));
    const title = within(form).getByRole("textbox", { name: /제목/u });
    await user.type(title, "X");
    await user.keyboard("{Backspace}");
    expect(title).toHaveValue(app.title);
    expect(within(form).getByRole("button", { name: "수정 저장" })).toBeDisabled();
    const element = title.closest("form");
    if (!element) throw new Error("missing form");
    fireEvent.submit(element);
    await act(async () => undefined);
    expect(api.calls.filter((c) => c.key.startsWith("PATCH"))).toEqual([]);
  });
  it("검토 시 잘못된 JSON을 필드 오류로 표시한다", async () => {
    mockApi({ "GET /admin/apps": () => ({ apps: [app] }) });
    const user = userEvent.setup();
    render();
    const form = await edit(user);
    const components = within(form).getByRole("textbox", { name: /구성 요소/u });
    await user.clear(components);
    await user.type(components, "invalid");
    await user.click(within(form).getByRole("button", { name: "변경 내용 검토" }));
    expect(await within(form).findByText("구성 요소가 올바른 JSON이 아닙니다.")).toBeVisible();
    expect(components).toHaveFocus();
  });
  it("입력 변경 후 이전 준비도 성공 결과는 즉시 숨긴다", async () => {
    mockApi({
      "GET /admin/apps": () => ({ apps: [app] }),
      "POST /admin/apps/onboarding-check": () => checklist,
    });
    const user = userEvent.setup();
    render();
    const form = await edit(user);
    await user.click(within(form).getByRole("button", { name: "온보딩 준비도 확인" }));
    await within(form).findByRole("list", { name: "온보딩 준비도 점검 결과" });
    await user.type(within(form).getByRole("textbox", { name: /제목/u }), "변경");
    expect(within(form).queryByRole("list", { name: "온보딩 준비도 점검 결과" })).not.toBeInTheDocument();
    expect(within(form).getByText("입력이 변경되었습니다. 준비도를 다시 확인하세요.")).toBeVisible();
  });
  it("요청 중 입력 변경 뒤 늦은 준비도 응답을 받아들이지 않는다", async () => {
    const held = deferred();
    const api = mockApi({
      "GET /admin/apps": () => ({ apps: [app] }),
      "POST /admin/apps/onboarding-check": () => held.promise,
    });
    const user = userEvent.setup();
    render();
    const form = await edit(user);
    await user.click(within(form).getByRole("button", { name: "온보딩 준비도 확인" }));
    await waitFor(() => expect(api.bodies("POST /admin/apps/onboarding-check")).toHaveLength(1));
    await user.type(within(form).getByRole("textbox", { name: /제목/u }), "X");
    await user.keyboard("{Backspace}");
    await act(async () => held.resolve(checklist));
    expect(within(form).queryByRole("list", { name: "온보딩 준비도 점검 결과" })).not.toBeInTheDocument();
  });
  it.each([
    {},
    { ready: true, checks: [], missing: 0 },
    { ...checklist, missing: 1 },
    { ...checklist, ready: false },
  ])("불완전하거나 모순된 준비도 응답을 성공으로 표시하지 않는다: %j", async (result) => {
    mockApi({
      "GET /admin/apps": () => ({ apps: [app] }),
      "POST /admin/apps/onboarding-check": () => result,
    });
    const user = userEvent.setup();
    render();
    const form = await edit(user);
    await user.click(within(form).getByRole("button", { name: "온보딩 준비도 확인" }));
    expect(await within(form).findByText("준비도를 확인하지 못했습니다.")).toBeVisible();
    expect(within(form).queryByRole("list", { name: "온보딩 준비도 점검 결과" })).not.toBeInTheDocument();
  });
});
