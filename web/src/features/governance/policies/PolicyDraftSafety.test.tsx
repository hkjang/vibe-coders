import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { acknowledgement, advice, applyPath, deferred, setupDraft } from "./policy-draft-test-harness";

describe("기존 초안 생성 정상 대조", () => {
  it("실제 확인 뒤 기존 title/conditions/actions만 한 번 전송한다", async () => {
    const current = await setupDraft();
    await current.user.click(current.button());
    await current.user.click(current.confirm());
    await waitFor(() =>
      expect(current.api.bodies(applyPath)).toEqual([
        { title: advice.title, conditions: advice.conditions, actions: advice.actions },
      ]),
    );
  });
  it("취소는 생성 요청을 보내지 않는다", async () => {
    const current = await setupDraft();
    await current.user.click(current.button());
    await current.user.click(within(current.dialog()).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(current.api.bodies(applyPath)).toEqual([]);
  });
  it("admin:write 없는 행은 생성되지 않는다", async () => {
    const current = await setupDraft();
    current.update({ scopes: ["security:read", "admin:read"] });
    expect(current.button()).toBeDisabled();
    await current.user.click(current.button());
    expect(current.api.bodies(applyPath)).toEqual([]);
  });
});
describe("추천에서 비활성 초안으로의 안전한 검토", () => {
  for (const mode of ["read_only", "preview_read_only"]) {
    it(`${mode}에서 생성은 차단하되 시뮬레이션은 유지한다`, async () => {
      const current = await setupDraft(mode);
      expect(screen.getByTestId("draft-access")).toHaveTextContent("governance.policies:true");
      expect(current.button()).toBeDisabled();
      expect(screen.getByRole("button", { name: / 섀도우 영향 확인$/u })).toBeEnabled();
    });
  }
  it("열린 추천의 제목·규칙·기간을 실제 확인창에 표시한다", async () => {
    const current = await setupDraft();
    await current.user.click(current.button());
    expect(current.dialog()).toHaveTextContent("검토한 추천");
    expect(current.dialog()).toHaveTextContent(advice.title ?? "");
    expect(current.dialog()).toHaveTextContent("public-model");
    expect(current.dialog()).toHaveTextContent("최근 7일");
  });
  for (const change of ["readonly", "scope", "owner", "principal"] as const) {
    it(`${change} 변경 뒤 캡처한 확인 콜백은 POST하지 않는다`, async () => {
      const current = await setupDraft();
      await current.user.click(current.button());
      const old = current.capture();
      current.update(
        change === "readonly"
          ? { mode: "read_only" }
          : change === "scope"
            ? { scopes: ["security:read", "admin:read"] }
            : change === "owner"
              ? { owner: "gateway.providers" }
              : { principal: "usr_public_b" },
      );
      await act(async () => old());
      expect(current.api.bodies(applyPath)).toEqual([]);
    });
  }
  it("렌더 전 확인 콜백 두 번은 한 전송만 만든다", async () => {
    const current = await setupDraft();
    const held = deferred<typeof acknowledgement>();
    current.response.apply = () => held.promise;
    await current.user.click(current.button());
    const confirm = current.capture();
    act(() => {
      confirm();
      confirm();
    });
    await waitFor(() => expect(current.api.bodies(applyPath).length).toBeGreaterThan(0));
    const count = current.api.bodies(applyPath).length;
    await act(async () => held.resolve(acknowledgement));
    expect(count).toBe(1);
  });
  it("조회 실패의 이전 추천을 바로 생성하지 않는다", async () => {
    const current = await setupDraft();
    current.response.suggestions = () => {
      throw new AppError("synthetic", { kind: "http", status: 503 });
    };
    await act(async () => {
      await current.view.client.refetchQueries({ queryKey: ["governance", "advisor"] });
    });
    await waitFor(() => expect(current.button()).toBeDisabled());
    expect(current.api.bodies(applyPath)).toEqual([]);
  });
  it("누락된 성공 확인은 생성 완료로 닫지 않는다", async () => {
    const current = await setupDraft();
    current.response.apply = () => ({});
    await current.user.click(current.button());
    await current.user.click(current.confirm());
    await waitFor(() => expect(current.api.bodies(applyPath)).toHaveLength(1));
    expect(await screen.findByText("생성 여부를 확인할 수 없습니다.")).toBeVisible();
    expect(current.dialog()).toBeVisible();
  });
  it("오류의 요청 ID는 현재 접두사로 가린다", async () => {
    const current = await setupDraft();
    const marker = `private_${"public_synthetic_".repeat(3)}`;
    current.response.apply = () => {
      throw new AppError("synthetic", { kind: "http", status: 503, requestId: marker });
    };
    await current.user.click(current.button());
    current.update({ prefixes: ["private_"] });
    await current.user.click(current.confirm());
    await screen.findByRole("alert");
    expect(current.dialog().outerHTML).not.toContain(marker);
    expect(current.dialog()).toHaveTextContent("중복");
  });
});
