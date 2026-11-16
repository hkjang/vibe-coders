import { useLayoutEffect, useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { usePreferences } from "@/shared/stores/preferences";
import { SystemHealthPage } from "./SystemHealthPage";
import {
  opsHome,
  incidents,
  workers,
  preflight,
  indexHealth,
  migrationSql,
  risk,
} from "./system-health-fixtures";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
beforeEach(() => {
  state.auth = testAuth({ user: { team_id: "alpha" } });
  usePreferences.setState({ refreshInterval: 0 });
});
function setup(tab = "ops", overrides: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/ops/risk": () => risk,
    "GET /admin/ops/home": () => opsHome,
    "GET /admin/incidents/candidates": () => incidents,
    "GET /admin/ops/workers": () => workers,
    "GET /admin/ops/preflight": () => preflight,
    "GET /admin/index-health": () => indexHealth,
    "GET /admin/migration-sql": () => migrationSql,
    ...overrides,
  });
  let redraw = () => {};
  function Host() {
    const [, update] = useState(0);
    useLayoutEffect(() => {
      redraw = () => update((n) => n + 1);
    }, []);
    return (
      <FeatureAccessHarness featureId="system.health">
        <SystemHealthPage />
      </FeatureAccessHarness>
    );
  }
  const view = renderScreen(<Host />, { route: `/system/health?tab=${tab}` });
  return { ...view, api, redraw: () => act(redraw) };
}

it("상단 새로고침은 현재 운영 탭의 두 조회만 한 번씩 갱신한다", async () => {
  const current = setup();
  await screen.findByRole("list", { name: "장애 후보" });
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await waitFor(() =>
    expect(current.api.calls.filter((c) => c.key === "GET /admin/ops/home")).toHaveLength(2),
  );
  expect(current.api.calls.filter((c) => c.key === "GET /admin/incidents/candidates")).toHaveLength(2);
  expect(current.api.calls.some((c) => c.key === "GET /admin/ops/risk")).toBe(false);
});

it("같은 계정의 팀 변경은 배포 점검 결과와 요청 의도를 폐기한다", async () => {
  const current = setup("workers");
  await screen.findByRole("table", { name: "백그라운드 작업 상태" });
  await userEvent.click(screen.getByRole("button", { name: "점검 실행" }));
  await screen.findByRole("table", { name: /점검 결과/ });
  state.auth = testAuth({ user: { team_id: "beta" } });
  current.redraw();
  expect(screen.queryByRole("table", { name: /점검 결과/ })).not.toBeInTheDocument();
  expect(screen.getByText("아직 점검하지 않았습니다.")).toBeVisible();
  expect(current.api.calls.filter((c) => c.key === "GET /admin/ops/preflight")).toHaveLength(1);
});

it("인덱스 조회 실패를 불일치나 정상 빈 목록으로 표시하지 않는다", async () => {
  setup("indexes", {
    "GET /admin/index-health": () => {
      throw apiFailure("failed", 503, "public-index-error");
    },
  });
  await screen.findByText(/public-index-error/);
  expect(screen.queryByText("불일치")).not.toBeInTheDocument();
  expect(screen.queryByText(/선언한 인덱스 0개가 모두/)).not.toBeInTheDocument();
  expect(screen.queryByText("눈에 띄는 후보가 없습니다.")).not.toBeInTheDocument();
});

it("인덱스 응답에 요약과 비교가 없으면 성공이나 불일치로 단정하지 않는다", async () => {
  setup("indexes", { "GET /admin/index-health": () => ({}) });
  expect(await screen.findByText("미확인")).toBeVisible();
  expect(screen.queryByText("불일치")).not.toBeInTheDocument();
  expect(screen.queryByText(/선언한 인덱스 0개가 모두/)).not.toBeInTheDocument();
  expect(screen.queryByText("눈에 띄는 후보가 없습니다.")).not.toBeInTheDocument();
});

it("조회 거부는 이전 운영 카드를 폐기하고 다른 정상 이슈는 유지한다", async () => {
  let denied = false;
  const current = setup("ops", {
    "GET /admin/ops/home": () => {
      if (denied) throw apiFailure("denied", 403);
      return opsHome;
    },
  });
  await screen.findByText("₩120,000");
  denied = true;
  await act(async () => {
    await current.client.invalidateQueries({ queryKey: ["system", "ops", "home"] });
  });
  await waitFor(() => expect(screen.queryByText("₩120,000")).not.toBeInTheDocument());
  expect(screen.getByRole("list", { name: "장애 후보" })).toBeVisible();
});

it("팀 변경은 열려 있던 SQL 문장과 검색 입력을 폐기한다", async () => {
  const current = setup("indexes");
  await screen.findByText("idx_requests_created");
  await userEvent.click(screen.getByRole("button", { name: "마이그레이션 SQL 보기" }));
  const dialog = screen.getByRole("dialog");
  await within(dialog).findByText("CREATE TABLE requests (id TEXT PRIMARY KEY);");
  await userEvent.type(within(dialog).getByLabelText("검색"), "private search");
  state.auth = testAuth({ user: { team_id: "beta" } });
  current.redraw();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      current.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("CREATE TABLE requests");
});

it("사용 권한이 없는 운영 카드의 관리 링크를 노출하지 않는다", async () => {
  state.auth = testAuth({ scopes: ["admin:read"] });
  setup();
  await screen.findByText("₩120,000");
  expect(screen.queryByRole("link", { name: /비용/ })).not.toBeInTheDocument();
});

it("탭 이동 뒤 새로고침은 현재 작업만 갱신하고 배포 점검을 대신 실행하지 않는다", async () => {
  const current = setup();
  await screen.findByRole("list", { name: "장애 후보" });
  await userEvent.click(screen.getByRole("tab", { name: "백그라운드 작업·배포 점검" }));
  await screen.findByText("async-logger");
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await waitFor(() =>
    expect(current.api.calls.filter((c) => c.key === "GET /admin/ops/workers")).toHaveLength(2),
  );
  expect(current.api.calls.filter((c) => c.key === "GET /admin/ops/home")).toHaveLength(1);
  expect(current.api.calls.some((c) => c.key === "GET /admin/ops/preflight")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "점검 실행" }));
  await screen.findByText("데이터베이스 구성");
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await waitFor(() =>
    expect(current.api.calls.filter((c) => c.key === "GET /admin/ops/workers")).toHaveLength(3),
  );
  expect(current.api.calls.filter((c) => c.key === "GET /admin/ops/preflight")).toHaveLength(1);
});

it("이전 팀의 늦은 운영 응답은 새 화면과 캐시에 반영하지 않는다", async () => {
  let finish!: (data: typeof opsHome) => void;
  const current = setup("ops", {
    "GET /admin/ops/home": () =>
      state.auth.user?.team_id === "alpha"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { ...opsHome, cards: [] },
  });
  await waitFor(() => expect(finish).toBeDefined());
  state.auth = testAuth({ user: { team_id: "beta" } });
  current.redraw();
  await screen.findByText("표시할 운영 신호가 없습니다.");
  await act(async () => finish(opsHome));
  expect(screen.queryByText("₩120,000")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      current.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("₩120,000");
});

it("조회 권한 회수는 모든 운영 데이터와 추가 요청을 차단한다", async () => {
  const current = setup();
  await screen.findByText("₩120,000");
  state.auth = testAuth({ scopes: [], user: { team_id: "alpha" } });
  current.redraw();
  expect(screen.getByText("시스템 상태 조회 권한을 확인하세요.")).toBeVisible();
  expect(screen.queryByText("₩120,000")).not.toBeInTheDocument();
  expect(current.client.getQueryCache().getAll()).toHaveLength(0);
});

it("SQL 문장은 50개씩 읽고 검색 조건 변경은 첫 페이지로 돌아간다", async () => {
  const statements = Array.from({ length: 121 }, (_, index) => ({
    seq: index + 1,
    kind: "create_table",
    table: `table_${index + 1}`,
    sql: `CREATE TABLE table_${index + 1} (id TEXT);`,
  }));
  const current = setup("indexes", {
    "GET /admin/migration-sql": () => ({
      ...migrationSql,
      statements,
      counts: { ...migrationSql.counts, total: 121, create_table: 121, create_index: 0 },
    }),
  });
  await screen.findByText("idx_requests_created");
  await userEvent.click(screen.getByRole("button", { name: "마이그레이션 SQL 보기" }));
  const dialog = within(screen.getByRole("dialog"));
  const list = await dialog.findByRole("list", { name: "선언된 마이그레이션 문장" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(50);
  await userEvent.click(dialog.getByRole("button", { name: "다음 문장" }));
  expect(within(list).getByText("CREATE TABLE table_51 (id TEXT);")).toBeVisible();
  await userEvent.type(dialog.getByLabelText("검색"), "table_121");
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(dialog.getByRole("button", { name: "이전 문장" })).toBeDisabled();
  expect(dialog.getByText("CREATE TABLE table_121 (id TEXT);")).toBeVisible();
  expect(current.api.calls.every((c) => c.key.startsWith("GET "))).toBe(true);
});

it("기존 화면 전용 기능의 운영 카드는 허용된 기존 경로로 연결한다", async () => {
  state.auth = {
    ...state.auth,
    features: state.auth.features.map((f) =>
      f.featureId === "finops.overview" ? { ...f, status: "legacy" } : f,
    ),
  };
  setup();
  await screen.findByText("₩120,000");
  expect(screen.getByRole("link", { name: /비용/ })).toHaveAttribute("href", "/admin#/billing");
});

it("일시 인덱스 오류에는 마지막 정상 상태를 보존하고 명시적으로 다시 조회한다", async () => {
  let failed = false;
  const current = setup("indexes", {
    "GET /admin/index-health": () => {
      if (failed) throw apiFailure("temporary", 503, "index-last-good");
      return indexHealth;
    },
  });
  await screen.findByText("idx_requests_created");
  failed = true;
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await screen.findByText(/index-last-good/);
  expect(screen.getByText("idx_requests_created")).toBeVisible();
  expect(current.api.calls.filter((c) => c.key === "GET /admin/index-health")).toHaveLength(2);
});

it.each(["ops", "workers", "indexes"])("%s의 현재 비밀 접두사 응답을 화면에 표시하지 않는다", async (tab) => {
  const secret = "system_private_" + "x".repeat(40);
  state.auth = { ...state.auth, credentialPrefixes: ["system_private_"] };
  const current = setup(tab, {
    "GET /admin/ops/home": () => ({
      ...opsHome,
      cards: [{ ...opsHome.cards[0], key: "private", title: secret, detail: secret, value: secret }],
    }),
    "GET /admin/ops/workers": () => ({
      ...workers,
      workers: [{ name: secret, detail: secret, status: "warn" }],
    }),
    "GET /admin/index-health": () => ({
      ...indexHealth,
      summary: { ...indexHealth.summary, headline: secret },
      drift: {
        ...indexHealth.drift,
        items: [{ kind: "missing", name: secret, detail: secret, fix: secret }],
      },
    }),
  });
  await waitFor(() => expect(current.client.isFetching()).toBe(0));
  expect(document.body.textContent).not.toContain(secret);
  expect(document.body.textContent).toContain("비공개");
});

it("장애 후보 조회 실패를 위험과 경고 0건으로 표시하지 않는다", async () => {
  setup("ops", {
    "GET /admin/incidents/candidates": () => {
      throw apiFailure("failed", 503, "public-incidents-error");
    },
  });
  await screen.findByText(/public-incidents-error/);
  expect(screen.queryByText("위험 0 · 경고 0")).not.toBeInTheDocument();
  expect(screen.getByText("₩120,000")).toBeVisible();
});

it("백그라운드 작업 조회 실패는 정상 빈 목록으로 표시하지 않는다", async () => {
  setup("workers", {
    "GET /admin/ops/workers": () => {
      throw apiFailure("failed", 503, "public-workers-error");
    },
  });
  await screen.findByText(/public-workers-error/);
  expect(screen.queryByText("표시할 백그라운드 작업이 없습니다.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "점검 실행" })).toBeEnabled();
});

it("SQL 조회 실패를 선언된 문장 0개로 표시하지 않는다", async () => {
  setup("indexes", {
    "GET /admin/migration-sql": () => {
      throw apiFailure("failed", 503, "public-sql-error");
    },
  });
  await screen.findByText("idx_requests_created");
  await userEvent.click(screen.getByRole("button", { name: "마이그레이션 SQL 보기" }));
  const dialog = within(screen.getByRole("dialog"));
  await dialog.findByText(/public-sql-error/);
  expect(dialog.queryByText(/전체 0 · 테이블 0/)).not.toBeInTheDocument();
  expect(dialog.getByRole("button", { name: "다시 시도" })).toBeEnabled();
});
