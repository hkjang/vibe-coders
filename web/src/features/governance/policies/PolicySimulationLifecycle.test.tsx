import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import {
  deferred,
  setupSimulation,
  simulationPath,
  simulationResult,
  suggestion,
} from "./policy-simulation-test-harness";

describe("독립 실행의 기준·생명주기", () => {
  for (const outcome of ["success", "failure"] as const) {
    it(`B pending 뒤 A ${outcome}가 새 flight를 풀거나 결과를 덮지 않는다`, async () => {
      const current = await setupSimulation();
      const a = deferred<typeof simulationResult>();
      const b = deferred<typeof simulationResult>();
      current.response.simulate = () => a.promise;
      await current.user.click(current.button());
      const old = current.capture();
      current.update({ principal: "usr_public_b" });
      current.response.simulate = () => b.promise;
      await current.user.click(current.button());
      await act(async () =>
        outcome === "success" ? a.resolve(simulationResult) : a.reject(new Error("public old error")),
      );
      expect(current.button()).toBeDisabled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => old());
      await current.user.click(current.button());
      expect(current.api.bodies(simulationPath)).toHaveLength(2);
      await act(async () => b.resolve({ ...simulationResult, evaluated: 9 }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("9");
    });
  }
  it("실제 query 재조회 B 이후에도 pending A의 실행 규칙·이름을 보존한다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    await current.user.click(current.button());
    current.response.rows = [{ ...suggestion, title: "새 공개 추천 B", conditions: { model: "public-B" } }];
    await act(async () => current.view.client.refetchQueries({ queryKey: ["governance", "advisor", "7d"] }));
    expect(await screen.findByText("새 공개 추천 B")).toBeVisible();
    await act(async () => gate.resolve(simulationResult));
    const panel = await screen.findByRole("dialog");
    expect(panel).toHaveTextContent(suggestion.title ?? "");
    expect(panel).toHaveTextContent("public-model");
    expect(panel).not.toHaveTextContent("public-B");
    expect(current.api.bodies(simulationPath)).toEqual([
      {
        window: "7d",
        rules: [{ name: suggestion.title, conditions: suggestion.conditions, actions: suggestion.actions }],
      },
    ]);
  });
  it("실패 후 목록 B가 와도 명시적 재시도는 표시된 원래 규칙 A로만 실행한다", async () => {
    const current = await setupSimulation();
    current.response.simulate = () => {
      throw new AppError("public", { kind: "http", status: 503 });
    };
    await current.user.click(current.button());
    await screen.findByText("정책 영향을 계산하지 못했습니다.");
    current.response.rows = [{ ...suggestion, title: "새 공개 추천 B", conditions: { model: "public-B" } }];
    await act(async () => current.view.client.refetchQueries({ queryKey: ["governance", "advisor", "7d"] }));
    current.response.simulate = () => simulationResult;
    await current.user.click(screen.getByRole("button", { name: "다시 시뮬레이션" }));
    await screen.findByRole("dialog");
    expect(current.api.bodies(simulationPath)[1]).toEqual(current.api.bodies(simulationPath)[0]);
  });
  it("unmount 뒤 캡처 콜백과 늦은 오류는 전송·알림을 추가하지 않는다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    const old = current.capture();
    await current.user.click(current.button());
    current.view.unmount();
    await act(async () => {
      old();
      gate.reject(new Error("public late failure"));
    });
    expect(current.api.bodies(simulationPath)).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("실행 중 readonly 전환은 순수 계산 결과를 취소하지 않는다", async () => {
    const current = await setupSimulation();
    const gate = deferred<typeof simulationResult>();
    current.response.simulate = () => gate.promise;
    await current.user.click(current.button());
    current.update({ mode: "read_only" });
    await act(async () => gate.resolve(simulationResult));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(current.api.bodies(simulationPath)).toHaveLength(1);
  });
  it("현재 접두사 변경은 열린 결과·rule·ARIA를 즉시 가리며 원문 전송은 유지한다", async () => {
    const current = await setupSimulation();
    const marker = `corp_${"public".repeat(8)}`;
    current.response.rows = [
      { ...suggestion, title: marker, conditions: { model: marker }, actions: { unknown: marker } },
    ];
    await act(async () => current.view.client.refetchQueries({ queryKey: ["governance", "advisor", "7d"] }));
    await screen.findByRole("button", { name: `${marker} 섀도우 영향 확인` });
    await current.user.click(current.button());
    const panel = await screen.findByRole("dialog");
    expect(panel).toHaveTextContent(marker);
    current.update({ credentialPrefixes: ["corp_"] });
    expect(panel.outerHTML).not.toContain(marker);
    expect(current.view.container.innerHTML).not.toContain(marker);
    expect(JSON.stringify(current.api.bodies(simulationPath))).toContain(marker);
  });
  it("현재 접두사로 오류 Request ID를 가리고 raw error를 남기지 않는다", async () => {
    const current = await setupSimulation();
    const marker = `corp_${"public".repeat(8)}`;
    current.response.simulate = () => {
      throw new AppError("public raw error", { kind: "http", status: 503, requestId: marker });
    };
    await current.user.click(current.button());
    await screen.findByRole("alert");
    current.update({ credentialPrefixes: ["corp_"] });
    expect(screen.getByRole("alert").outerHTML).not.toContain(marker);
    expect(screen.getByRole("alert")).not.toHaveTextContent("public raw error");
  });
  it("raw 표본은 DOM이나 새 query/mutation 캐시에 넣지 않는다", async () => {
    const current = await setupSimulation();
    current.response.simulate = () => ({
      ...simulationResult,
      sample_blocked: [{ api_key_id: "public_sample_key" }],
      shadow: { ...simulationResult.shadow, false_positive_sample: [{ team: "public_sample_team" }] },
    });
    await current.user.click(current.button());
    const panel = await screen.findByRole("dialog");
    expect(panel.outerHTML).not.toMatch(/public_sample/u);
    expect(current.view.client.getMutationCache().getAll()).toHaveLength(0);
    expect(
      JSON.stringify(
        current.view.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toMatch(/public_sample/u);
  });
  it("권한을 수동 복구해도 요청은 늘지 않고 새 실행만 허용한다", async () => {
    const current = await setupSimulation();
    current.update({ scopes: ["security:read", "admin:read"] });
    current.update({ scopes: ["security:read", "admin:read", "admin:write"] });
    expect(current.api.bodies(simulationPath)).toHaveLength(0);
    await current.user.click(current.button());
    await waitFor(() => expect(current.api.bodies(simulationPath)).toHaveLength(1));
  });
});
