import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { costPath, costValue, deferred, estimateResult, setupCost } from "./cost-prediction-test-harness";

describe("기존 비용 예측의 정상 대조", () => {
  for (const mode of ["writable", "read_only", "preview_read_only"] as const) {
    it(`${mode}: admin:write가 있으면 routing:write 없이 기존 정수 본문을 한 번 보낸다`, async () => {
      const current = await setupCost(mode);
      current.fields("  public-cost-model  ");
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
      expect(current.api.bodies(costPath)).toEqual([
        { model: "public-cost-model", input_tokens: 1000, max_tokens: 600 },
      ]);
      expect(current.api.calls.every(({ key }) => key === costPath || key === "GET /admin/cost")).toBe(true);
    });
  }
  it("admin:write 없는 일반 클릭은 예측을 보내지 않는다", async () => {
    const current = await setupCost();
    current.fields();
    current.update({ scopes: ["routing:read", "admin:read"] });
    const button = screen.getByRole("button", { name: "비용 예측" });
    expect(button).toBeDisabled();
    await current.user.click(button);
    expect(current.api.bodies(costPath)).toEqual([]);
  });
  it("빈 모델은 기존 실행 버튼이 잠기고 전송하지 않는다", async () => {
    const current = await setupCost();
    const button = screen.getByRole("button", { name: "비용 예측" });
    expect(button).toBeDisabled();
    await current.user.click(button);
    expect(current.api.bodies(costPath)).toEqual([]);
  });
  it("정수 0은 음수가 아니며 기존 기본 출력 추정 요청 의미를 보존한다", async () => {
    const current = await setupCost();
    current.fields("public-cost-model", "0", "0");
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
    expect(current.api.bodies(costPath)).toEqual([
      { model: "public-cost-model", input_tokens: 0, max_tokens: 0 },
    ]);
  });
  it("503은 안전한 요청 ID와 수동 재시도만 제공한다", async () => {
    const current = await setupCost();
    current.fields();
    current.response.predict = () => {
      throw new AppError("synthetic", { kind: "http", status: 503, requestId: "req_cost_public" });
    };
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await screen.findByText(/req_cost_public/u);
    expect(current.api.bodies(costPath)).toHaveLength(1);
    current.response.predict = () => estimateResult;
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
    expect(current.api.bodies(costPath)).toHaveLength(2);
  });
});

describe("실행 기준과 한국어 추정 의미", () => {
  it("A를 계산한 뒤 입력 B로 바꾸면 A 결과와 구분하고 자동 재실행하지 않는다", async () => {
    const current = await setupCost();
    const held = deferred<typeof estimateResult>();
    current.response.predict = () => held.promise;
    current.fields();
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    current.fields("public-cost-model-b", "2000", "900");
    await act(async () => held.resolve(estimateResult));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
    expect(current.api.bodies(costPath)).toEqual([
      { model: "public-cost-model", input_tokens: 1000, max_tokens: 600 },
    ]);
    expect(screen.getByRole("textbox", { name: "모델" })).toHaveValue("public-cost-model-b");
    expect(screen.getByText(/입력이 달라졌습니다/u)).toBeVisible();
  });
  it("가격 미확인의 비용 0을 확인된 무료 비용처럼 표시하지 않는다", async () => {
    const current = await setupCost();
    current.fields();
    current.response.predict = () => ({ ...estimateResult, cost_krw: 0, priced: false });
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
    expect(costValue("예상 비용")).toHaveTextContent("확인할 수 없음");
  });
  for (const [basis, korean] of [
    ["history", "과거 사용량 기준"],
    ["max_tokens", "입력한 출력 토큰 기준"],
    ["default", "기본 출력 토큰 기준"],
  ] as const) {
    it(`${basis} 계산 기준은 한글로 설명한다`, async () => {
      const current = await setupCost();
      current.fields("public-cost-model", "1000", basis === "default" ? "0" : "600");
      current.response.predict = () => ({
        ...estimateResult,
        basis,
        latency_ms: basis === "history" ? 40 : 0,
      });
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
      expect(costValue("산정 기준")).toHaveTextContent(korean);
    });
  }
});

describe("실제 전송 콜백의 현재 권한과 수명", () => {
  for (const change of ["admin-write", "route-read", "owner", "epoch", "unmount"] as const) {
    it(`${change}: 이전에 캡처한 실제 예측 콜백은 새 전송을 시작하지 않는다`, async () => {
      const current = await setupCost();
      current.fields();
      const callback = current.capture();
      if (change === "admin-write") current.update({ scopes: ["routing:read", "admin:read"] });
      if (change === "route-read") current.update({ scopes: ["admin:read", "admin:write"] });
      if (change === "owner") current.update({ owner: "gateway.health" });
      if (change === "epoch") act(() => tokenStore.clearAll());
      if (change === "unmount") current.view.unmount();
      await act(async () => callback());
      expect(current.api.bodies(costPath)).toEqual([]);
    });
  }
  it("렌더 전 두 동기 실행 콜백은 예측을 한 번만 보낸다", async () => {
    const current = await setupCost();
    current.fields();
    const held = deferred<typeof estimateResult>();
    current.response.predict = () => held.promise;
    const callback = current.capture();
    act(() => {
      callback();
      callback();
    });
    const count = current.api.bodies(costPath).length;
    await act(async () => held.resolve(estimateResult));
    expect(count).toBe(1);
  });
  for (const outcome of ["resolve", "reject"] as const) {
    it(`이전 ${outcome}가 APIClient에서 aborted여도 새 세션 UI에 취소 오류를 남기지 않는다`, async () => {
      const current = await setupCost();
      current.fields();
      const held = deferred<typeof estimateResult>();
      current.response.predict = () => held.promise;
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      act(() => tokenStore.clearAll());
      current.update({ userId: "cost-user-b" });
      await act(async () => {
        if (outcome === "resolve") held.resolve(estimateResult);
        else held.reject(new AppError("synthetic late", { kind: "http", status: 503 }));
        await held.promise.catch(() => undefined);
      });
      await waitFor(() => expect(screen.queryByRole("button", { name: "계산 중" })).not.toBeInTheDocument());
      expect(screen.queryByText("요청이 취소되었습니다.", { exact: false })).not.toBeInTheDocument();
      expect(current.api.bodies(costPath)).toHaveLength(1);
    });
  }
});

describe("음수·소수·안전하지 않은 토큰의 로컬 입력 보호", () => {
  for (const field of ["input", "max"] as const) {
    for (const invalid of ["-1", "1.5"] as const) {
      it(`${field}=${invalid}: 실제 숫자 입력과 버튼 클릭으로 예측을 전송하지 않는다`, async () => {
        const current = await setupCost();
        current.fields(
          "public-cost-model",
          field === "input" ? invalid : "1000",
          field === "max" ? invalid : "600",
        );
        expect(
          screen.getByRole("spinbutton", { name: field === "input" ? "입력 토큰" : "최대 출력 토큰" }),
        ).toHaveValue(Number(invalid));
        await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
        expect(current.api.bodies(costPath)).toEqual([]);
      });
    }
  }
  for (const [label, value] of [
    ["입력 토큰", "Infinity"],
    ["최대 출력 토큰", "NaN"],
  ] as const) {
    it(`${label} ${value}: 실제 입력 콜백의 비유한값을 새 POST로 보내거나 0으로 숨기지 않는다`, async () => {
      const current = await setupCost();
      current.fields();
      // Direct actual React callback evidence only. HTML number inputs may
      // sanitize these strings, so this is not a physical typing/browser claim.
      current.capturedInput(label, value);
      await act(async () => current.capture()());
      expect(current.api.bodies(costPath)).toEqual([]);
    });
  }
  it("JS 안전 정수 범위를 넘는 토큰은 원래 수량이라고 추정해 전송하지 않는다", async () => {
    const current = await setupCost();
    current.fields("public-cost-model", "9007199254740992", "600");
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    expect(current.api.bodies(costPath)).toEqual([]);
  });
});
