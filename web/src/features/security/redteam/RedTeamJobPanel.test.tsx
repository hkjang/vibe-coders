import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { focusManager } from "@tanstack/react-query";
import axe from "axe-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RedTeamJobPanel } from "./RedTeamJobPanel";
import { executionJobFixture, executionJobId } from "./job-fixture";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import type { RedTeamJobView } from "@/shared/api/domains/redteam-jobs";

const runtime = vi.hoisted(() => ({ user: "usr_test" }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ user: { id: runtime.user }, scopes: ["admin:read"] }) };
});
const read = "GET /admin/redteam/campaigns/public-campaign/run-reviewed";
const ref = { id: executionJobId, campaign: "public-campaign" };
function root(onOutcome = vi.fn(), onClose = vi.fn(), permitted = true) {
  return (
    <FeatureAccessContext
      value={{ featureId: "security.redteam", permitted, readOnly: true, status: "preview" }}
    >
      <RedTeamJobPanel job={ref} onOutcome={onOutcome} onClose={onClose} />
    </FeatureAccessContext>
  );
}
beforeEach(() => {
  runtime.user = "usr_test";
  focusManager.setFocused(true);
});
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

it("저장된 작업 주소는 조회만 수행하고 읽기 전용 사용자도 결과를 연다", async () => {
  const result = executionJobFixture(true),
    api = mockApi({ [read]: () => result });
  const show = vi.fn();
  const view = renderScreen(root(show));
  expect(await screen.findByText("레드팀 검사 완료")).toBeVisible();
  expect(screen.getByText("1 / 1건")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "저장된 실행 결과" }));
  expect(show).toHaveBeenCalledWith(result.outcome);
  expect(api.calls).toEqual([{ key: read, options: { body: undefined, query: { job_id: executionJobId } } }]);
  expect((await axe.run(view.container)).violations).toEqual([]);
});

it("일시적인 조회 오류에서는 마지막 진행 상태와 요청 ID를 남긴다", async () => {
  let failed = false;
  mockApi({
    [read]: () => {
      if (failed) throw apiFailure("private detail", 503);
      return executionJobFixture();
    },
  });
  renderScreen(root());
  await screen.findByText("레드팀 검사 진행 중");
  failed = true;
  fireEvent.click(screen.getByRole("button", { name: "작업 상태 새로고침" }));
  expect(await screen.findByText(/갱신에 실패해 마지막 정상 데이터/u)).toBeVisible();
  expect(screen.getByText("0 / 1건")).toBeVisible();
  expect(screen.getByText("요청 ID: req_test")).toBeVisible();
  expect(screen.queryByText("private detail")).toBeNull();
});

it("조회 권한 거부는 이전 진행 데이터와 계정 소유 캐시를 제거한다", async () => {
  let denied = false;
  mockApi({
    [read]: () => {
      if (denied) throw apiFailure("private", 403);
      return executionJobFixture();
    },
  });
  const view = renderScreen(root());
  await screen.findByText("레드팀 검사 진행 중");
  denied = true;
  fireEvent.click(screen.getByRole("button", { name: "작업 상태 새로고침" }));
  expect(await screen.findByText("레드팀 작업 조회 권한을 확인하세요.")).toBeVisible();
  expect(screen.queryByText("0 / 1건")).toBeNull();
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .every((query) => query.state.data === undefined),
  ).toBe(true);
});

it("계정 교체 후 늦은 이전 계정 응답을 표시하지 않는다", async () => {
  let finish: (value: RedTeamJobView) => void = () => undefined;
  const pending = new Promise<RedTeamJobView>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  mockApi({ [read]: () => (++calls === 1 ? pending : executionJobFixture(true)) });
  let refresh = () => undefined;
  function Harness() {
    const [, update] = useState(0);
    useEffect(() => {
      refresh = () => {
        update((value) => value + 1);
      };
    }, []);
    return root();
  }
  const view = renderScreen(<Harness />);
  await waitFor(() => expect(calls).toBe(1));
  runtime.user = "another-user";
  act(() => refresh());
  await screen.findByText("레드팀 검사 완료");
  await act(async () => finish(executionJobFixture()));
  expect(screen.queryByText("레드팀 검사 진행 중")).toBeNull();
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.data),
  ).toHaveLength(1);
});

it("다른 캠페인의 작업 응답은 표시하지 않는다", async () => {
  mockApi({ [read]: () => ({ ...executionJobFixture(), campaign_id: "another" }) });
  renderScreen(root());
  expect(await screen.findByText("실행 작업 조회에 실패했습니다.")).toBeVisible();
  expect(screen.queryByText("0 / 1건")).toBeNull();
});

it.each(["unknown", "interrupted", "stopped"] as const)(
  "%s 상태는 자동 재실행 없이 확인을 안내한다",
  async (status) => {
    const api = mockApi({ [read]: () => ({ ...executionJobFixture(), status }) });
    renderScreen(root());
    expect(await screen.findByText("실행 이력과 저장 상태를 확인하세요.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /실행$/u })).toBeNull();
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  },
);

it("접수 전 404를 조회로 복구하고 비활성 탭과 완료 후에는 주기 조회를 멈춘다", async () => {
  vi.useFakeTimers();
  let state: "missing" | "running" | "completed" = "missing";
  const api = mockApi({
    [read]: () => {
      if (state === "missing") throw apiFailure("missing", 404);
      return executionJobFixture(state === "completed");
    },
  });
  renderScreen(root());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(api.calls).toHaveLength(1);
  state = "running";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_010);
  });
  expect(screen.getByText("레드팀 검사 진행 중")).toBeVisible();
  focusManager.setFocused(false);
  const before = api.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  expect(api.calls).toHaveLength(before);
  state = "completed";
  focusManager.setFocused(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_010);
  });
  expect(screen.getByText("레드팀 검사 완료")).toBeVisible();
  const completed = api.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  expect(api.calls).toHaveLength(completed);
});

it("접수 미확인을 무한 조회하지 않고 수동 확인을 제공한다", async () => {
  vi.useFakeTimers();
  const api = mockApi({
    [read]: () => {
      throw apiFailure("missing", 404);
    },
  });
  renderScreen(root());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32_000);
  });
  const before = api.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(api.calls).toHaveLength(before);
  expect(screen.getByRole("button", { name: "작업 상태 새로고침" })).toBeEnabled();
});
