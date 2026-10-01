import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import {
  deferred,
  setupSimulation,
  simulationPath,
  simulationResult,
  suggestion,
} from "./policy-simulation-test-harness";

describe("기존 시뮬레이션 정상 대조", () => {
  for (const mode of ["writable", "read_only", "preview_read_only"]) {
    it(`${mode}: 원래 POST 본문과 저장 없는 결과를 유지한다`, async () => {
      const current = await setupSimulation(mode);
      expect(screen.getByTestId("simulation-access")).toHaveTextContent(
        `governance.policies:${String(mode !== "writable")}`,
      );
      await current.user.click(current.button());
      expect(await screen.findByRole("dialog", { name: "섀도우 영향 분석" })).toBeVisible();
      expect(current.api.bodies(simulationPath)).toEqual([
        {
          rules: [{ name: suggestion.title, conditions: suggestion.conditions, actions: suggestion.actions }],
          window: "7d",
        },
      ]);
      expect(current.api.calls.filter(({ key }) => key.startsWith("POST"))).toHaveLength(1);
    });
  }
  it("admin:write 없이 물리 활성화는 없다", async () => {
    const current = await setupSimulation();
    current.update({ scopes: ["security:read", "admin:read"] });
    expect(current.button()).toBeDisabled();
    await current.user.click(current.button());
    expect(current.api.bodies(simulationPath)).toEqual([]);
  });
  it("닫기는 저장 요청 없이 원래 동작으로 초점을 돌린다", async () => {
    const current = await setupSimulation();
    await current.user.click(current.button());
    await screen.findByRole("dialog", { name: "섀도우 영향 분석" });
    await current.user.click(screen.getByRole("button", { name: "패널 닫기" }));
    await waitFor(() => expect(current.button()).toHaveFocus());
    expect(current.api.bodies(simulationPath)).toHaveLength(1);
  });
});

describe("실행 기준과 제한된 이력 결과", () => {
  it("닫기 초기초점 뒤 Tab으로 본문 읽기 안내에 도달한다", async () => {
    const current = await setupSimulation();
    await current.user.click(current.button());
    const panel = await screen.findByRole("dialog", { name: "섀도우 영향 분석" });
    await waitFor(() => expect(within(panel).getByRole("button", { name: "패널 닫기" })).toHaveFocus());
    await current.user.tab();
    expect(within(panel).getByRole("region", { name: "시뮬레이션 결과 읽기" })).toHaveFocus();
    expect(current.api.bodies(simulationPath)).toHaveLength(1);
  });
  it("서버 기준 시작과 실행한 기간·추천·규칙을 고정해 설명한다", async () => {
    const current = await setupSimulation();
    await current.user.click(current.button());
    const panel = await screen.findByRole("dialog", { name: "섀도우 영향 분석" });
    expect(within(panel).getByText("실행한 분석 기간")).toBeVisible();
    expect(within(panel).getByText("최근 7일")).toBeVisible();
    expect(within(panel).getByText("실행한 규칙")).toBeVisible();
    expect(panel).toHaveTextContent("정책을 저장하거나 적용하지 않습니다.");
    expect(panel).toHaveTextContent("5,000");
  });
  it("0개 표본은 0% 안전이 아니라 평가 표본 없음을 표시한다", async () => {
    const current = await setupSimulation();
    current.response.simulate = () => ({
      ...simulationResult,
      evaluated: 0,
      blocked: 0,
      allowed: 0,
      require_approval: 0,
      block_rate: 0,
    });
    await current.user.click(current.button());
    const panel = await screen.findByRole("dialog", { name: "섀도우 영향 분석" });
    expect(within(panel).getByText("평가할 표본이 없습니다.")).toBeVisible();
    expect(panel).not.toHaveTextContent("0.0%");
  });
  it("누락 응답은 성공한 0건으로 바꾸지 않는다", async () => {
    const current = await setupSimulation();
    current.response.simulate = () => ({});
    await current.user.click(current.button());
    const panel = await screen.findByRole("dialog", { name: "섀도우 영향 분석" });
    expect(within(panel).getAllByText("확인할 수 없음").length).toBeGreaterThan(0);
  });
  it("민감정보 조건과 복원하지 못한 값의 한계를 표시한다", async () => {
    const current = await setupSimulation();
    const row = current.response.rows[0];
    if (!row) throw new Error("missing synthetic suggestion");
    row.conditions = { contains_secret: true };
    await current.user.click(current.button());
    const panel = await screen.findByRole("dialog", { name: "섀도우 영향 분석" });
    expect(panel).toHaveTextContent("당시 값을 복원하지 못하는 조건이 있습니다.");
    expect(panel).toHaveTextContent("비밀정보 포함");
  });
  it("5000 표본은 상한 도달 가능성을 안내한다", async () => {
    const current = await setupSimulation();
    current.response.simulate = () => ({ ...simulationResult, evaluated: 5000 });
    await current.user.click(current.button());
    expect(await screen.findByText("표본 상한에 도달했을 수 있습니다.")).toBeVisible();
  });
});

describe("현재 화면과 실행 수명", () => {
  it("같은 token epoch에서 principal 교체 뒤 A 응답을 게시하지 않는다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    await current.user.click(current.button());
    const epoch = tokenStore.getSessionEpoch();
    current.update({ principal: "usr_public_b" });
    await act(async () => gate.resolve(simulationResult));
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
    expect(screen.queryByRole("dialog", { name: "섀도우 영향 분석" })).not.toBeInTheDocument();
  });
  for (const change of ["scope", "owner"] as const) {
    it(`${change}: 예전 실제 콜백은 새 전송하지 않는다`, async () => {
      const current = await setupSimulation();
      const old = current.capture();
      current.update(
        change === "scope" ? { scopes: ["admin:read", "security:read"] } : { owner: "gateway.providers" },
      );
      await act(async () => old());
      expect(current.api.bodies(simulationPath)).toEqual([]);
    });
  }
  it("렌더 전 동기 중복은 한 번만 실행한다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    const run = current.capture();
    act(() => {
      run();
      run();
    });
    await waitFor(() => expect(current.api.bodies(simulationPath).length).toBeGreaterThan(0));
    const count = current.api.bodies(simulationPath).length;
    await act(async () => gate.resolve(simulationResult));
    expect(count).toBe(1);
  });
  it("기간 변경 뒤 이전 응답이 새 결과창을 열지 않는다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    await current.user.click(current.button());
    await current.user.selectOptions(
      screen.getByRole("combobox", { name: "정책 어드바이저 분석 기간" }),
      "30d",
    );
    await act(async () => gate.resolve(simulationResult));
    expect(screen.queryByRole("dialog", { name: "섀도우 영향 분석" })).not.toBeInTheDocument();
    expect(current.api.bodies(simulationPath)).toHaveLength(1);
  });
  it("전송 후 scope 회수의 늦은 결과는 복구해도 자동 게시하지 않는다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    await current.user.click(current.button());
    current.update({ scopes: ["admin:read", "security:read"] });
    await act(async () => gate.resolve(simulationResult));
    current.update({ scopes: ["admin:read", "admin:write", "security:read"] });
    expect(screen.queryByRole("dialog", { name: "섀도우 영향 분석" })).not.toBeInTheDocument();
    expect(current.api.bodies(simulationPath)).toHaveLength(1);
  });
  it("기존 API epoch가 폐기한 응답은 새 세션에 나타나지 않는다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    await current.user.click(current.button());
    act(() => tokenStore.clearAll());
    await act(async () => gate.resolve(simulationResult));
    expect(screen.queryByRole("dialog", { name: "섀도우 영향 분석" })).not.toBeInTheDocument();
  });
  it("오류와 요청 ID를 인라인에 유지하고 수동 재시도만 보낸다", async () => {
    const current = await setupSimulation();
    current.response.simulate = () => {
      throw new AppError("private raw upstream", { kind: "http", status: 503, requestId: "req_public_sim" });
    };
    await current.user.click(current.button());
    expect(await screen.findByText("정책 영향을 계산하지 못했습니다.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("req_public_sim");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private raw upstream");
    expect(current.api.bodies(simulationPath)).toHaveLength(1);
    current.response.simulate = () => simulationResult;
    await current.user.click(screen.getByRole("button", { name: "다시 시뮬레이션" }));
    await screen.findByRole("dialog", { name: "섀도우 영향 분석" });
    expect(current.api.bodies(simulationPath)).toHaveLength(2);
  });
});
