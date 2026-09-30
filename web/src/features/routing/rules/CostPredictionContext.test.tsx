import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { hiddenCostValue } from "./cost-prediction-state";
import { costPath, costValue, deferred, estimateResult, setupCost } from "./cost-prediction-test-harness";

describe("비용 예측의 현재 입력과 계산 의미", () => {
  it("빈 토큰은 기존 0 본문을 유지하고 메시지 추정 및 기본 출력과 구분한다", async () => {
    const current = await setupCost();
    current.fields("public-cost-model", "", "");
    expect(screen.getByText(/비우면 입력 토큰 0으로 계산하며 메시지에서 추정하지 않습니다/u)).toBeVisible();
    expect(screen.getByText(/충분한 이력이 없으면 600으로 계산합니다/u)).toBeVisible();
    current.response.predict = () => ({
      ...estimateResult,
      input_tokens: 0,
      basis: "default",
      latency_ms: 0,
    });
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
    expect(current.api.bodies(costPath)).toEqual([
      { model: "public-cost-model", input_tokens: 0, max_tokens: 0 },
    ]);
    expect(costValue("산정 기준")).toHaveTextContent("기본 출력 토큰 기준");
    expect(costValue("예상 지연")).toHaveTextContent("확인할 수 없음");
  });
  for (const first of ["input", "max"] as const) {
    it(`${first}: 실제 버튼 클릭은 첫 숫자 오류로 초점을 옮기고 전송하지 않는다`, async () => {
      const current = await setupCost();
      current.fields("public-cost-model", first === "input" ? "-1" : "1000", "1.5");
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      const input = screen.getByRole("spinbutton", {
        name: first === "input" ? "입력 토큰" : "최대 출력 토큰",
      });
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(current.api.bodies(costPath)).toEqual([]);
    });
  }
  it("이전 렌더의 실제 실행 콜백도 현재 B 입력을 읽어 보낸다", async () => {
    const current = await setupCost();
    current.fields("model-a", "100", "200");
    const old = current.capture();
    current.fields("model-b", "300", "400");
    current.response.predict = () => ({ ...estimateResult, model: "model-b" });
    await act(async () => old());
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("model-b"));
    expect(current.api.bodies(costPath)).toEqual([{ model: "model-b", input_tokens: 300, max_tokens: 400 }]);
    expect(costValue("계산한 모델")).toHaveTextContent("model-b");
    expect(costValue("계산한 입력 토큰")).toHaveTextContent("300");
    expect(costValue("계산한 최대 출력 토큰")).toHaveTextContent("400");
  });
  it("A 기준은 B 편집 뒤 그대로이며 수동 실행만 B 기준으로 바꾼다", async () => {
    const current = await setupCost();
    current.fields("model-a", "100", "200");
    current.response.predict = () => ({ ...estimateResult, model: "model-a" });
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("model-a"));
    current.fields("model-b", "300", "400");
    expect(costValue("계산한 모델")).toHaveTextContent("model-a");
    expect(costValue("계산한 입력 토큰")).toHaveTextContent("100");
    expect(costValue("계산한 최대 출력 토큰")).toHaveTextContent("200");
    expect(screen.getByText(/입력이 달라졌습니다/u)).toBeVisible();
    expect(current.api.bodies(costPath)).toHaveLength(1);
    current.response.predict = () => ({ ...estimateResult, model: "model-b" });
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("model-b"));
    expect(costValue("계산한 모델")).toHaveTextContent("model-b");
    expect(screen.queryByText(/입력이 달라졌습니다/u)).not.toBeInTheDocument();
    expect(current.api.bodies(costPath)).toHaveLength(2);
  });
  for (const mode of ["read_only", "preview_read_only"] as const) {
    it(`${mode} 전환 자체는 이미 시작한 순수 계산 결과나 초안을 버리지 않는다`, async () => {
      const current = await setupCost();
      const held = deferred<typeof estimateResult>();
      current.response.predict = () => held.promise;
      current.fields();
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      current.update({ mode });
      expect(screen.getByTestId("cost-access")).toHaveTextContent("routing.rules:true");
      await act(async () => held.resolve(estimateResult));
      expect(costValue("모델")).toHaveTextContent("public-cost-model");
      expect(screen.getByRole("textbox", { name: "모델" })).toHaveValue("public-cost-model");
      expect(current.api.bodies(costPath)).toHaveLength(1);
    });
  }
  it("확인된 가격의 0은 예상값으로 표시하되 무료·실제 청구·정확한 가격표라고 단정하지 않는다", async () => {
    const current = await setupCost();
    current.fields("public-cost-model", "0", "0");
    current.response.predict = () => ({ ...estimateResult, cost_krw: 0 });
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
    expect(costValue("예상 비용")).not.toHaveTextContent("확인할 수 없음");
    expect(costValue("가격표 적용")).toHaveTextContent("추정 가능");
    expect(screen.getByText("실제 청구 금액이나 호출 허가가 아닌 예상값입니다.")).toBeVisible();
    expect(screen.getByText("가격의 적용 경로는 확인할 수 없습니다.")).toBeVisible();
    expect(screen.getByText(/정확한 모델명·접두사·기본 대체 가격/u)).toBeVisible();
    expect(screen.getByText(/입력한 최대 출력 토큰으로 제한되지 않습니다/u)).toBeVisible();
  });
  it("실패 상태를 아직 실행하지 않은 상태와 함께 표시하지 않는다", async () => {
    const current = await setupCost();
    current.fields();
    current.response.predict = () => {
      throw new AppError("synthetic", { kind: "http", status: 503 });
    };
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await screen.findByText("비용을 예측하지 못했습니다.");
    expect(screen.queryByText("아직 비용을 예측하지 않았습니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("비용을 계산하고 있습니다.")).not.toBeInTheDocument();
  });
});

describe("계산 권한과 별도 설정 조회", () => {
  it("설정 GET 실패나 admin:read 부재는 허용된 admin:write 계산 POST의 선행 조건이 아니다", async () => {
    const current = await setupCost();
    current.update({ scopes: ["routing:read", "admin:write"] });
    current.response.guard = () => {
      throw new AppError("synthetic denied", { kind: "http", status: 401 });
    };
    await current.user.click(screen.getByRole("button", { name: "비용 보호 설정 새로고침" }));
    await screen.findByText("설정 미확인");
    current.fields();
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
    expect(current.api.bodies(costPath)).toHaveLength(1);
  });
  for (const outcome of ["resolve", "reject"] as const) {
    it(`admin:write 회수 뒤 ${outcome}은 결과·오류를 표시하지 않고 복구 뒤에도 수동 재실행만 한다`, async () => {
      const current = await setupCost();
      const held = deferred<typeof estimateResult>();
      current.response.predict = () => held.promise;
      current.fields();
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      current.update({ scopes: ["routing:read", "admin:read"] });
      await act(async () => {
        if (outcome === "resolve") held.resolve(estimateResult);
        else held.reject(new AppError("synthetic denied late", { kind: "http", status: 503 }));
        await held.promise.catch(() => undefined);
      });
      expect(screen.getByText("이전 계산 결과를 표시하지 않습니다.")).toBeVisible();
      expect(screen.queryByText("비용을 예측하지 못했습니다.")).not.toBeInTheDocument();
      expect(screen.queryByText("실제 청구 금액이나 호출 허가가 아닌 예상값입니다.")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "모델" })).toHaveValue("public-cost-model");
      current.update({ scopes: ["routing:read", "admin:read", "admin:write"] });
      expect(current.api.bodies(costPath)).toHaveLength(1);
      expect(screen.getByText("이전 계산 결과를 표시하지 않습니다.")).toBeVisible();
      current.response.predict = () => estimateResult;
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      await waitFor(() => expect(costValue("모델")).toHaveTextContent("public-cost-model"));
      expect(current.api.bodies(costPath)).toHaveLength(2);
    });
  }
});

describe("현재 표시용 비밀정보 검사와 이전 작업 격리", () => {
  it("새 접두사로 기존 모델·산정 기준·스냅숏 표시만 가리고 원래 전송과 입력을 바꾸지 않는다", async () => {
    const current = await setupCost();
    const marker = `cost_private_${"a".repeat(32)}`;
    current.fields(marker);
    // Unknown basis is defensive display testing, not a new Go basis contract.
    current.response.predict = () => ({ ...estimateResult, model: marker, basis: marker });
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await waitFor(() => expect(costValue("모델")).toHaveTextContent(marker));
    current.update({ credentialPrefixes: ["vc_sk_", "vc_sa_", "cost_private_"] });
    for (const label of ["모델", "계산한 모델", "산정 기준"]) {
      expect(costValue(label)).toHaveTextContent(hiddenCostValue);
      expect(costValue(label).outerHTML).not.toContain(marker);
    }
    expect(screen.getByRole("textbox", { name: "모델" })).toHaveValue(marker);
    expect(current.api.bodies(costPath)).toEqual([{ model: marker, input_tokens: 1000, max_tokens: 600 }]);
    expect(window.location.href).not.toContain(marker);
    expect(JSON.stringify(window.localStorage)).not.toContain(marker);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(marker);
  });
  it("민감한 요청 ID와 서버 원문 오류는 새 결과 안내에 노출하지 않는다", async () => {
    const current = await setupCost();
    const marker = `cost_private_${"a".repeat(32)}`;
    current.update({ credentialPrefixes: ["cost_private_"] });
    current.fields();
    current.response.predict = () => {
      throw new AppError(`raw ${marker}`, { kind: "http", status: 503, requestId: marker });
    };
    await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
    await screen.findByText("비용을 예측하지 못했습니다.");
    const notice = screen.getByText("비용을 예측하지 못했습니다.").closest(".inline-notice");
    expect(notice).toHaveTextContent(hiddenCostValue);
    expect(notice?.outerHTML).not.toContain(marker);
  });
  for (const outcome of ["resolve", "reject"] as const) {
    it(`새 세션 B가 이미 대기 중일 때 이전 인스턴스 A의 ${outcome}/finally는 B를 끝내지 않는다`, async () => {
      const current = await setupCost();
      const a = deferred<typeof estimateResult>();
      const b = deferred<typeof estimateResult>();
      current.response.predict = () => a.promise;
      current.fields("model-a");
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      act(() => tokenStore.clearAll());
      current.update({ userId: "cost-user-b" });
      expect(screen.getByRole("textbox", { name: "모델" })).toHaveValue("");
      current.response.predict = () => b.promise;
      current.fields("model-b");
      await current.user.click(screen.getByRole("button", { name: "비용 예측" }));
      expect(screen.getByRole("button", { name: "계산 중" })).toBeDisabled();
      await act(async () => {
        if (outcome === "resolve") a.resolve(estimateResult);
        else a.reject(new AppError("old rejection", { kind: "http", status: 503 }));
        await a.promise.catch(() => undefined);
      });
      expect(screen.getByRole("button", { name: "계산 중" })).toBeDisabled();
      expect(screen.getByText("비용을 계산하고 있습니다.")).toBeVisible();
      expect(screen.queryByText("비용을 예측하지 못했습니다.")).not.toBeInTheDocument();
      expect(costValue("계산한 모델")).toHaveTextContent("model-b");
      expect(current.api.bodies(costPath)).toHaveLength(2);
      await act(async () => b.resolve({ ...estimateResult, model: "model-b" }));
      expect(costValue("모델")).toHaveTextContent("model-b");
      expect(screen.getByRole("textbox", { name: "모델" })).toHaveValue("model-b");
      expect(screen.getByRole("button", { name: "비용 예측" })).toBeEnabled();
      expect(current.api.bodies(costPath)).toHaveLength(2);
    });
  }
  for (const change of ["owner", "epoch", "unmount"] as const) {
    it(`${change}: 이전 잘못된 입력 콜백은 현재 초점을 빼앗거나 오류를 남기지 않는다`, async () => {
      const current = await setupCost();
      current.fields("model-a", "-1", "-1");
      const callback = current.capture();
      if (change === "owner") current.update({ owner: "gateway.health" });
      if (change === "epoch") act(() => tokenStore.clearAll());
      if (change === "unmount") current.view.unmount();
      const focusTarget = document.createElement("button");
      document.body.append(focusTarget);
      focusTarget.focus();
      try {
        await act(async () => callback());
        expect(focusTarget).toHaveFocus();
        expect(screen.queryByText("입력 토큰은 0 이상의 안전한 정수로 입력하세요.")).not.toBeInTheDocument();
        expect(current.api.bodies(costPath)).toEqual([]);
      } finally {
        focusTarget.remove();
      }
    });
  }
});
