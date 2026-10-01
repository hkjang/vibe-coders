import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { deferred, policy, savePath, setupEditor } from "./policy-editor-test-harness";

describe("현재 화면·원본·권한과 실제 단일 전송 경계", () => {
  it("옛 행의 캡처한 열기 콜백은 새 조회 뒤 원본을 열지 않는다", async () => {
    const c = await setupEditor();
    const old = c.captureOpen();
    c.response.rows = [{ ...structuredClone(policy), description: "새 서버 원본" }];
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "policies"] });
    });
    await act(async () => old());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("열린 편집 중 다른 현재 행 callback도 원본을 갈아끼우지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName("작업 중인 이름");
    c.response.rows = [
      { ...structuredClone(policy), id: "other_policy", name: "다른 초안", description: "다른 원본" },
    ];
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "policies"] });
    });
    await screen.findByRole("button", { name: "다른 초안 초안 편집", hidden: true });
    const other = c.captureOpen();
    await act(async () => other());
    expect(screen.getByRole("table", { name: "정책 변경 전후" })).toHaveTextContent("공개 설명");
    expect(screen.getByRole("table", { name: "정책 변경 전후" })).not.toHaveTextContent("다른 원본");
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  for (const mode of ["read_only", "preview_read_only"]) {
    it(`${mode}는 새 편집 저장을 허용하지 않는다`, async () => {
      const c = await setupEditor();
      c.update({ mode });
      expect(c.open()).toBeDisabled();
      await c.user.click(c.open());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(c.api.bodies(savePath)).toEqual([]);
    });
  }
  it("활성 정책은 이 편집 경로에서 수정하지 않는다", async () => {
    const c = await setupEditor({ ...structuredClone(policy), enabled: true });
    expect(c.open()).toBeDisabled();
  });
  for (const change of ["readonly", "write", "read", "owner", "principal", "epoch"] as const) {
    it(`${change} 전환 뒤 옛 확인 콜백은 GET/POST하지 않는다`, async () => {
      const c = await setupEditor();
      await c.user.click(c.open());
      await c.editName();
      const old = c.captureSave();
      const reads = c.api.bodies("GET /admin/policies").length;
      if (change === "epoch") act(() => tokenStore.clearAll());
      else
        c.update(
          change === "readonly"
            ? { mode: "read_only" }
            : change === "write"
              ? { scopes: ["security:read", "admin:read"] }
              : change === "read"
                ? { scopes: ["admin:write"] }
                : change === "owner"
                  ? { owner: "gateway.providers" }
                  : { principal: "public_b" },
        );
      await act(async () => old());
      expect(c.api.bodies(savePath)).toEqual([]);
      expect(c.api.bodies("GET /admin/policies")).toHaveLength(reads);
    });
  }
  it("사용자 A→B→A 뒤 폐기된 창과 옛 승인은 살아나지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    const old = c.captureSave();
    c.update({ principal: "public_b" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    c.update({ principal: "public_a" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => old());
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  it("쓰기 권한 회수 후 복구해도 과거 검토 승인을 다시 쓰지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    const old = c.captureSave();
    c.update({ scopes: ["security:read"] });
    c.update({ scopes: ["security:read", "admin:write"] });
    await act(async () => old());
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  it("다시 편집 후 원래 값으로 돌아와도 옛 검토 콜백은 보내지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    const old = c.captureSave();
    await c.user.click(screen.getByRole("button", { name: "다시 편집" }));
    await c.editName();
    await act(async () => old());
    expect(c.api.bodies(savePath)).toEqual([]);
    await c.user.click(c.save());
    await screen.findByText("비활성 정책을 저장했습니다.");
    expect(c.api.bodies(savePath)).toHaveLength(1);
  });
  it("현재 목록의 invalidated 상태는 조회 성공 데이터가 있어도 쓰지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    await act(async () => {
      await c.view.client.invalidateQueries({ queryKey: ["governance", "policies"], refetchType: "none" });
    });
    await c.user.click(c.save());
    expect(c.api.bodies(savePath)).toEqual([]);
    expect(c.api.bodies("GET /admin/policies")).toHaveLength(1);
  });
  for (const change of ["active", "deleted", "different", "duplicate"] as const) {
    it(`직전 GET의 ${change} 원본은 저장을 거부하고 초안을 유지한다`, async () => {
      const c = await setupEditor();
      await c.user.click(c.open());
      await c.editName();
      c.response.rows =
        change === "deleted"
          ? []
          : change === "duplicate"
            ? [structuredClone(policy), structuredClone(policy)]
            : [
                {
                  ...structuredClone(policy),
                  ...(change === "active" ? { enabled: true } : { description: "새 원본" }),
                },
              ];
      await c.user.click(c.save());
      expect(await screen.findByText("저장 전 원본을 확인하지 못했습니다.")).toBeVisible();
      expect(c.api.bodies(savePath)).toEqual([]);
      expect(c.dialog()).toHaveTextContent("바꾼 초안");
    });
  }
  it("직전 GET 중 readonly 변경을 다시 확인하고 POST하지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    const held = deferred<unknown>();
    c.response.list = () => held.promise;
    await c.user.click(c.save());
    await waitFor(() => expect(c.api.bodies("GET /admin/policies")).toHaveLength(2));
    c.update({ mode: "read_only" });
    await act(async () => held.resolve({ policies: [policy] }));
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  it("실제 저장 중 렌더 전 중복 콜백/취소는 한 전송과 열린 창을 유지한다", async () => {
    const c = await setupEditor();
    const held = deferred<unknown>();
    c.response.save = () => held.promise;
    await c.user.click(c.open());
    await c.editName();
    const submit = c.captureSave();
    act(() => {
      submit();
      submit();
    });
    await waitFor(() => expect(c.api.bodies(savePath)).toHaveLength(1));
    expect(c.save()).toHaveAttribute("aria-disabled", "true");
    await c.user.click(screen.getByRole("button", { name: "취소" }));
    expect(c.dialog()).toBeVisible();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const body = c.api.bodies(savePath)[0];
    await act(async () => held.resolve({ policy: body }));
    await screen.findByText("비활성 정책을 저장했습니다.");
    expect(c.api.bodies(savePath)).toHaveLength(1);
  });
  it("이미 전송한 유효 ACK는 쓰기 권한만 회수돼도 read/owner가 유효하면 완료로 인정한다", async () => {
    const c = await setupEditor();
    const held = deferred<unknown>();
    c.response.save = () => held.promise;
    await c.user.click(c.open());
    await c.editName();
    await c.user.click(c.save());
    await waitFor(() => expect(c.api.bodies(savePath)).toHaveLength(1));
    c.update({ mode: "read_only" });
    await act(async () => held.resolve({ policy: c.api.bodies(savePath)[0] }));
    expect(await screen.findByText("비활성 정책을 저장했습니다.")).toBeVisible();
    expect(c.api.bodies(savePath)).toHaveLength(1);
  });
  it("세션 폐기 뒤 늦은 ACK는 후속 GET/성공 표시를 하지 않는다", async () => {
    const c = await setupEditor();
    const held = deferred<unknown>();
    c.response.save = () => held.promise;
    await c.user.click(c.open());
    await c.editName();
    await c.user.click(c.save());
    await waitFor(() => expect(c.api.bodies(savePath)).toHaveLength(1));
    act(() => tokenStore.clearAll());
    await act(async () => held.resolve({ policy: c.api.bodies(savePath)[0] }));
    expect(screen.queryByText("비활성 정책을 저장했습니다.")).not.toBeInTheDocument();
    expect(c.api.bodies("GET /admin/policies")).toHaveLength(2);
  });
  it("원본 조회 오류는 쓰기 없이 수동 복구하고 민감한 오류문을 노출하지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName();
    c.response.list = () => {
      throw new AppError("secret_private_error", { kind: "http", status: 503, requestId: "public_retry" });
    };
    await c.user.click(c.save());
    expect(await screen.findByText("저장 전 원본을 확인하지 못했습니다.")).toBeVisible();
    expect(document.body.innerHTML).not.toContain("secret_private_error");
    expect(c.api.bodies(savePath)).toEqual([]);
    c.response.list = () => ({ policies: [policy] });
    await waitFor(() => expect(c.save()).toHaveAttribute("aria-disabled", "false"));
    await c.user.click(c.save());
    await screen.findByText("비활성 정책을 저장했습니다.");
    expect(c.api.bodies(savePath)).toHaveLength(1);
  });
  it("새 draft JSON은 검토까지 query/mutation cache나 URL/storage에 넣지 않는다", async () => {
    const c = await setupEditor();
    await c.user.click(c.open());
    await c.editName("새 공개 이름");
    expect(
      JSON.stringify(
        c.view.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("새 공개 이름");
    expect(c.view.client.getMutationCache().getAll()).toHaveLength(0);
    expect(window.location.href).not.toContain(encodeURIComponent("새 공개 이름"));
    expect(JSON.stringify(localStorage)).not.toContain("새 공개 이름");
  });
});
