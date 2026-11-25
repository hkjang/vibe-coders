import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/shared/api/schemas";
import SessionPermissionsDialog from "./SessionPermissionsDialog";
import { sessionPermissionRows } from "./session-permissions";

const runtime = vi.hoisted(() => ({ user: undefined as AuthUser | undefined, raw: false, mode: "session" }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: runtime.user,
    authenticationMode: runtime.mode,
    capabilities: { raw_prompt_view: runtime.raw },
  }),
}));

function dialog() {
  return <SessionPermissionsDialog onClose={vi.fn()} returnFocusRef={createRef()} />;
}
function scopeRow(code: string) {
  const row = screen.getByText(code).closest("li");
  if (!row) throw new Error("Missing permission row");
  return within(row);
}

function currentUser(): AuthUser {
  if (!runtime.user) throw new Error("Missing fixture user");
  return runtime.user;
}

describe("현재 세션 권한", () => {
  beforeEach(() => {
    runtime.mode = "session";
    runtime.raw = false;
    runtime.user = {
      id: "self",
      email: "operator@example.test",
      role: "super_admin",
      roles: ["super_admin"],
      team_id: "platform",
      scopes: ["models:read", "models:read"],
      features: {},
    };
  });
  it("관리자 역할이어도 서버가 부여하지 않은 쓰기 권한이나 원문 권한을 추정하지 않는다", async () => {
    render(dialog());
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(scopeRow("models:read").getByText("부여됨")).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText("부여 상태"), "all");
    expect(scopeRow("admin:write").getByText("미부여")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "요청 원문 열람" })).getByText("제한됨")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("부여된 권한 1개");
  });
  it("갱신된 세션의 권한과 원문 열람 상태를 즉시 반영한다", async () => {
    const view = render(dialog());
    await userEvent.selectOptions(screen.getByLabelText("부여 상태"), "all");
    runtime.user = { ...currentUser(), role: "custom-reviewer", scopes: ["admin:write"] };
    runtime.raw = true;
    view.rerender(dialog());
    expect(scopeRow("models:read").getByText("미부여")).toBeVisible();
    expect(scopeRow("admin:write").getByText("부여됨")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "요청 원문 열람" })).getByText("허용됨")).toBeVisible();
    runtime.user = undefined;
    view.rerender(dialog());
    expect(screen.queryByRole("list", { name: "세션 권한 목록" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("권한 정보를 받지 못했습니다");
  });
  it("빈 권한과 알 수 없는 로그인 정보를 구분하고 개방 모드를 명시한다", async () => {
    runtime.mode = "open";
    currentUser().scopes = [];
    render(dialog());
    expect(screen.getByText("개방 모드")).toBeVisible();
    expect(screen.getByText("현재 연결에 적용된 공유 관리자 권한입니다.")).toBeVisible();
    expect(screen.getByText("현재 로그인에 부여된 세션 권한 코드가 없습니다.")).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText("부여 상태"), "all");
    expect(scopeRow("admin:write").getByText("미부여")).toBeVisible();
  });
  it("한글·코드 검색과 부여 상태를 결합하고 알 수 없는 서버 권한도 텍스트로 보존한다", async () => {
    const user = userEvent.setup();
    currentUser().scopes.push("custom:<script>text</script>");
    render(dialog());
    await user.selectOptions(screen.getByLabelText("부여 상태"), "granted");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await user.type(screen.getByLabelText("권한 검색"), "모델");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user.clear(screen.getByLabelText("권한 검색"));
    await user.type(screen.getByLabelText("권한 검색"), "CUSTOM:");
    expect(screen.getByText("custom:<script>text</script>")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    await user.selectOptions(screen.getByLabelText("부여 상태"), "missing");
    expect(screen.getByText("검색 조건에 맞는 권한이 없습니다.")).toBeVisible();
  });
  it("미부여 필터는 현재 부여된 중복 권한을 포함하지 않는다", () => {
    const rows = sessionPermissionRows(["models:read", "models:read"], "", "missing");
    expect(rows.every((row) => !row.granted && row.value !== "models:read")).toBe(true);
    expect(sessionPermissionRows(["models:read"], "  MODELS:READ ", "all")).toHaveLength(1);
  });
});
