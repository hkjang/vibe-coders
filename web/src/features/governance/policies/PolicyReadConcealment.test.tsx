import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { deferred, policy, savePath, setupEditor as setupBaseEditor } from "./policy-editor-test-harness";

async function setupEditor(initial = structuredClone(policy)) {
  const c = await setupBaseEditor(initial);
  // The server may keep the feature available while withdrawing an API scope.
  // Exercise the dialog's read boundary independently of route-level unmounting.
  c.update({ serverAvailable: true });
  return c;
}

describe("정책 조회 권한 회수 시 화면 원문 제거", () => {
  it.each(["read_only", "preview_read_only"])("%s는 조회 가능한 초안을 숨기지 않는다", async (mode) => {
    const c = await setupEditor();
    await c.user.click(c.open());
    c.update({ mode });
    expect(within(c.dialog()).getByRole("textbox", { name: "정책 이름" })).toHaveValue(policy.name);
    expect(within(c.dialog()).getByRole("button", { name: "변경 내용 검토" })).toBeDisabled();
  });
  it("조회 권한 회수 시 기존 서버 오류의 요청 ID도 표시하지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    c.response.list = () => {
      throw new AppError("public failure", { kind: "http", status: 503, requestId: "public-read-reference" });
    };
    await c.user.click(c.save());
    expect(await screen.findByText("요청 ID: public-read-reference")).toBeVisible();
    c.update({ scopes: ["admin:write"] });
    expect(c.dialog()).not.toHaveTextContent("public-read-reference");
  });
  it.each([false, true])(
    "정책 사용 상태 %s의 확인창은 조회 권한이 없으면 같은 버튼 색상과 문구를 사용한다",
    async (enabled) => {
      const c = await setupEditor({ ...structuredClone(policy), enabled });
      const action = enabled ? "중지" : "사용";
      await c.user.click(screen.getByRole("button", { name: `${policy.name} ${action}` }));
      const original = screen.getByRole("dialog");
      expect(within(original).getByRole("button", { name: action })).toHaveClass(
        enabled ? "button-danger" : "button-primary",
      );
      c.update({ scopes: ["admin:write"] });
      const dialog = screen.getByRole("dialog", { name: "정책 변경 확인" });
      const confirm = within(dialog).getByRole("button", { name: "확인" });
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveClass("button-primary");
      expect(confirm).not.toHaveClass("button-danger");
      c.update({ scopes: ["security:read", "admin:write"] });
      expect(within(original).getByRole("button", { name: action })).toHaveClass(
        enabled ? "button-danger" : "button-primary",
      );
      expect(c.api.bodies(savePath)).toEqual([]);
    },
  );
  it.each(["fields", "review", "saving"])(
    "%s 상태에서 원문을 제거하고 작업 수명은 유지한다",
    async (phase) => {
      const c = await setupEditor();
      const pending = deferred<unknown>();
      c.response.save = () => pending.promise;
      await c.user.click(c.open());
      if (phase !== "fields") await c.editName();
      if (phase === "saving") {
        await c.user.click(c.save());
        await waitFor(() => expect(c.api.bodies(savePath)).toHaveLength(1));
      }
      c.update({ scopes: ["admin:write"] });
      const dialog = c.dialog();
      expect(dialog).toBeVisible();
      expect(within(dialog).queryAllByRole("textbox")).toHaveLength(0);
      expect(within(dialog).queryByRole("table", { name: "정책 변경 전후" })).not.toBeInTheDocument();
      expect(dialog).not.toHaveTextContent(policy.description ?? "");
      expect(dialog).not.toHaveTextContent("첫 규칙");
      expect(c.api.bodies(savePath)).toHaveLength(phase === "saving" ? 1 : 0);
      if (phase === "saving") {
        await act(async () => pending.resolve({}));
        c.update({ scopes: ["security:read", "admin:write"] });
        expect(await screen.findByText("저장 여부를 확인할 수 없습니다.")).toBeVisible();
        await c.user.click(screen.getByRole("button", { name: "다시 편집" }));
        await c.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
        expect(c.save()).toHaveAttribute("aria-disabled", "true");
        await c.user.click(c.save());
        expect(c.api.bodies(savePath)).toHaveLength(1);
      }
    },
  );
  it("필드에서 조회 권한이 사라지면 안내로 초점을 이동한다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    const input = within(c.dialog()).getByRole("textbox", { name: "정책 이름" });
    await c.user.click(input);
    expect(input).toHaveFocus();
    c.update({ scopes: ["admin:write"] });
    expect(screen.getByRole("region", { name: "정책 조회 권한 안내" })).toHaveFocus();
  });
  it("조회 권한 복구 후 이전 검토 승인으로 자동 저장하지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    const old = c.captureSave();
    c.update({ scopes: ["admin:write"] });
    c.update({ scopes: ["security:read", "admin:write"] });
    await act(async () => old());
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  it("시나리오 삭제 확인창도 조회 권한 회수 시 이름을 표시하지 않는다", async () => {
    const c = await setupEditor();
    c.response.cases = () => ({ cases: [{ id: "public-case", name: "공개 삭제 대상", expect: "allow" }] });
    await act(async () => c.view.client.refetchQueries({ queryKey: ["governance", "regression-cases"] }));
    await c.user.click(await screen.findByRole("button", { name: "공개 삭제 대상 시나리오 삭제" }));
    c.update({ scopes: ["admin:write"] });
    const dialog = screen.getByRole("dialog", { name: "회귀 시나리오를 삭제할까요?" });
    expect(dialog).not.toHaveTextContent("공개 삭제 대상");
    expect(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled();
  });
});
