import { useLayoutEffect, useState } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AppError, isAppError } from "@/shared/api/error";
import { FeatureAccessHarness } from "@/test/feature-access";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { OverviewRefreshContext } from "./overview-refresh-context";
import { useOverviewQuery } from "./use-overview-query";

function exportHarness(read: Reader) {
  let current = () => false;
  function Host() {
    const [period, setPeriod] = useState("1h");
    const query = useOverviewQuery({ key: ["export", period], read });
    useLayoutEffect(() => {
      current = query.isDataCurrent;
    });
    return (
      <>
        <output aria-label="내보낼 결과">{query.data?.label ?? "없음"}</output>
        <output aria-label="선택 기간">{period}</output>
        <button onClick={query.refetch}>내보내기 데이터 새로고침</button>
        <button onClick={() => setPeriod((value) => (value === "1h" ? "7d" : "1h"))}>기간 바꾸기</button>
      </>
    );
  }
  return {
    ...renderScreen(
      <FeatureAccessHarness featureId="overview" readOnly>
        <Host />
      </FeatureAccessHarness>,
      { route: "/overview" },
    ),
    capture: () => current,
  };
}

it("CSV가 캡처한 응답은 새 응답과 뷰 종료 후 다시 사용할 수 없다", async () => {
  let value = { label: "첫 통계" };
  const view = exportHarness(async () => value);
  await screen.findByText("첫 통계");
  const old = view.capture();
  expect(old()).toBe(true);
  value = { label: "새 통계" };
  await userEvent.click(screen.getByRole("button", { name: "내보내기 데이터 새로고침" }));
  await screen.findByText("새 통계");
  expect(old()).toBe(false);
  const current = view.capture();
  expect(current()).toBe(true);
  view.unmount();
  expect(current()).toBe(false);
});

it.each([401, 403])("%s 조회 거부 뒤 같은 응답으로 복구해도 이전 CSV 검사는 폐기된다", async (status) => {
  let denied = false;
  const value = { label: "같은 통계" };
  const view = exportHarness(async () => {
    if (denied) throw new AppError("거부", { kind: "permission", status });
    return value;
  });
  await screen.findByText("같은 통계");
  const old = view.capture();
  denied = true;
  await userEvent.click(screen.getByRole("button", { name: "내보내기 데이터 새로고침" }));
  await waitFor(() => expect(screen.getByLabelText("내보낼 결과")).toHaveTextContent("없음"));
  expect(old()).toBe(false);
  denied = false;
  await userEvent.click(screen.getByRole("button", { name: "내보내기 데이터 새로고침" }));
  await screen.findByText("같은 통계");
  expect(view.capture()()).toBe(true);
  expect(old()).toBe(false);
});

it("같은 응답의 기간 왕복과 캐시 제거도 이전 내보내기를 복원하지 않는다", async () => {
  const value = { label: "동일 통계" };
  const read = vi.fn(async () => value);
  const view = exportHarness(read);
  await screen.findByText("동일 통계");
  const first = view.capture();
  await userEvent.click(screen.getByRole("button", { name: "기간 바꾸기" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await screen.findByText("동일 통계");
  expect(first()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "기간 바꾸기" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  await screen.findByText("동일 통계");
  expect(first()).toBe(false);
  const current = view.capture();
  expect(current()).toBe(true);
  act(() => {
    view.client.removeQueries({ queryKey: ["overview", "export"] });
    expect(current()).toBe(false);
  });
});

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
type Value = { label: string };
type Reader = (signal: AbortSignal) => Promise<Value>;
beforeEach(() => {
  state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
});

function Widget({ name, read, polling }: { name: string; read: Reader; polling: boolean }) {
  const query = useOverviewQuery({ key: [name], read, interval: polling ? 100 : false });
  return (
    <section aria-label={name}>
      <output aria-label={`${name} 결과`}>{query.data?.label ?? "없음"}</output>
      {query.error ? (
        <p role="alert">
          {isAppError(query.error) ? `${query.error.message} ${query.error.requestId ?? ""}` : "조회 실패"}
        </p>
      ) : null}
      <button onClick={query.refetch}>{name} 다시 확인</button>
    </section>
  );
}
function setup(read: Reader, secondary?: Reader, polling = false) {
  let refresh = () => {};
  function Host() {
    const [, update] = useState(0);
    const [refreshers] = useState(() => new Set<() => void>());
    const [second, setSecond] = useState(true);
    useLayoutEffect(() => {
      refresh = () => update((value) => value + 1);
    }, []);
    return (
      <FeatureAccessHarness featureId="overview" readOnly>
        <OverviewRefreshContext value={refreshers}>
          <button
            onClick={() => {
              for (const reload of refreshers) reload();
            }}
          >
            전체 새로고침
          </button>
          <button onClick={() => setSecond(false)}>두 번째 영역 닫기</button>
          <Widget name="통계" read={read} polling={polling} />
          {second && secondary ? <Widget name="추이" read={secondary} polling={polling} /> : null}
        </OverviewRefreshContext>
      </FeatureAccessHarness>
    );
  }
  return { ...renderScreen(<Host />, { route: "/overview" }), refresh: () => act(refresh) };
}

it("팀 변경 후 이전 통계의 늦은 응답을 화면과 캐시에 남기지 않는다", async () => {
  let finish!: (value: Value) => void;
  let oldSignal: AbortSignal | undefined;
  const read = vi.fn<Reader>((signal) => {
    if (state.auth.user?.team_id === "alpha") {
      oldSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return Promise.resolve({ label: "베타 통계" });
  });
  const view = setup(read);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "beta" } });
  view.refresh();
  expect(await screen.findByText("베타 통계")).toBeVisible();
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish({ label: "알파 비공개 통계" }));
  expect(screen.queryByText("알파 비공개 통계")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      view.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("알파");
});

it("한 영역의 조회 거부는 해당 캐시만 비우고 수동 새로고침으로 복구한다", async () => {
  let deny = false;
  const read = vi.fn<Reader>(async () => {
    if (deny) throw new AppError("denied", { kind: "permission", status: 403 });
    return { label: "비용 통계" };
  });
  const other = vi.fn<Reader>(async () => ({ label: "정상 추이" }));
  const view = setup(read, other, true);
  expect(await screen.findByText("비용 통계")).toBeVisible();
  deny = true;
  await userEvent.click(screen.getByRole("button", { name: "통계 다시 확인" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("조회 권한");
  expect(screen.queryByText("비용 통계")).not.toBeInTheDocument();
  expect(screen.getByText("정상 추이")).toBeVisible();
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey[1] === "통계")
      .some((q) => q.state.data !== undefined),
  ).toBe(false);
  const count = read.mock.calls.length;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(read).toHaveBeenCalledTimes(count);
  deny = false;
  await userEvent.click(screen.getByRole("button", { name: "전체 새로고침" }));
  expect(await screen.findByText("비용 통계")).toBeVisible();
  expect(read).toHaveBeenCalledTimes(count + 1);
});

it("전체 새로고침은 현재 열린 영역을 한 번씩만 조회한다", async () => {
  const first = vi.fn<Reader>(async () => ({ label: "비용" }));
  const second = vi.fn<Reader>(async () => ({ label: "추이" }));
  setup(first, second);
  await screen.findByText("비용");
  await screen.findByText("추이");
  await userEvent.click(screen.getByRole("button", { name: "두 번째 영역 닫기" }));
  const before = first.mock.calls.length,
    other = second.mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "전체 새로고침" }));
  await waitFor(() => expect(first).toHaveBeenCalledTimes(before + 1));
  expect(second).toHaveBeenCalledTimes(other);
});

it("권한 회수는 기존 데이터와 캐시를 즉시 제거한다", async () => {
  const read = vi.fn<Reader>(async () => ({ label: "기존 비용" }));
  const view = setup(read);
  await screen.findByText("기존 비용");
  state.auth = testAuth({ scopes: [] });
  view.refresh();
  expect(screen.queryByText("기존 비용")).not.toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("조회 권한");
  const count = read.mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "전체 새로고침" }));
  expect(read).toHaveBeenCalledTimes(count);
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .some((q) => q.state.data),
  ).toBe(false);
});

it("일시 오류는 마지막 정상 값을 유지하고 비밀 접두사의 요청 ID는 표시하지 않는다", async () => {
  let failed = false;
  state.auth = { ...state.auth, credentialPrefixes: ["private_metric_"] };
  setup(async () => {
    if (failed)
      throw new AppError("private_metric_" + "x".repeat(40), {
        kind: "http",
        status: 503,
        requestId: "private_metric_" + "x".repeat(40),
      });
    return { label: "마지막 정상 값" };
  });
  await screen.findByText("마지막 정상 값");
  failed = true;
  await userEvent.click(screen.getByRole("button", { name: "통계 다시 확인" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("서버가 요청을 처리하지 못했습니다.");
  expect(screen.getByText("마지막 정상 값")).toBeVisible();
  expect(document.body.textContent).not.toContain("private_metric_");
});
