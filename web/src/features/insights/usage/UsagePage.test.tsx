import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

import { UsagePage } from "./UsagePage";
import {
  fixtureCategoryRows,
  fixtureFlow,
  fixtureInsights,
  fixtureMatrix,
  fixtureModels,
  fixtureOverview,
  fixtureProductivity,
  fixtureReads,
  fixtureRequests,
  fixtureSessionDetail,
  fixtureStatus,
  fixtureTrend,
  fixtureWithheld,
  type FixtureQuery,
} from "./usage-fixtures";
import { qualityWithheldNote, withheldChartText, withheldScopeText } from "./usage-labels";
import { formatMetricCompact } from "./usage-metrics";

const auth = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: auth.scopes }) };
});

const base = "/admin/work-intel";

/** Answers with a raw fixture run through the endpoint's own schema, as the client would. */
const answer =
  (build: (query: FixtureQuery) => unknown): ApiHandler =>
  (options, endpoint) =>
    endpoint.schema.parse(build((options.query ?? {}) as FixtureQuery));

function mockUsage(overrides: Readonly<Record<string, ApiHandler>> = {}) {
  const handlers: Record<string, ApiHandler> = {};
  for (const [name, build] of Object.entries(fixtureReads)) handlers[`GET ${base}/${name}`] = answer(build);
  const api = mockApi({ ...handlers, ...overrides });
  return {
    ...api,
    queries: (name: string) =>
      api.calls.filter((call) => call.key === `GET ${base}/${name}`).map((call) => call.options.query ?? {}),
  };
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function open(route = "/insights/usage") {
  return renderScreen(
    <FeatureAccessContext
      value={{ featureId: "insights.usage", permitted: true, readOnly: false, status: "preview" }}
    >
      <UsagePage />
      <LocationProbe />
    </FeatureAccessContext>,
    { path: "/insights/usage", route },
  );
}

const location = (): URL => new URL(screen.getByTestId("location").textContent ?? "", "http://app.test");

beforeEach(() => {
  auth.scopes = ["admin:read", "admin:write"];
  tokenStore.clearAll();
  notifications.success.mockReset();
  notifications.error.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UsagePage summary", () => {
  it("renders the KPI tiles in the required order with their comparisons and tab links", async () => {
    mockUsage();
    open();
    const kpis = await screen.findByRole("region", { name: "요약 지표" });
    const tiles = within(kpis).getAllByRole("article");
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "업무 세션",
      "LLM 요청",
      "활용 사용자",
      "활용 조직",
      "활성 업무 유형",
      "분류 완료율",
      "증가율",
      "신규 업무",
      "자동화 후보",
    ]);
    const [sessions, requests, , , , classified, growth] = tiles as [HTMLElement, ...HTMLElement[]];
    expect(within(sessions).getByText("1,240")).toBeVisible();
    expect(within(sessions).getByText("직전 1,000 · ▲ 24.0%")).toBeVisible();
    expect(within(sessions).getByRole("link")).toHaveAttribute("href", "/insights/usage?tab=sessions");
    expect(within(requests as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/insights/usage?tab=sessions&list=requests",
    );
    expect(within(classified as HTMLElement).getByText("92.0%")).toBeVisible();
    expect(within(classified as HTMLElement).getByText("직전 90.0% · +2.0%p")).toBeVisible();
    expect(within(growth as HTMLElement).getByText("▲ 24.0%")).toBeVisible();
    expect(screen.getByRole("region", { name: "분류 신뢰도 분포" })).toHaveTextContent("0.9 이상");
  });

  it("lays the summary sections out in the required order", async () => {
    mockUsage();
    open();
    await screen.findByRole("region", { name: "요약 지표" });
    await screen.findByRole("list", { name: "인사이트 목록" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      "신뢰도 분포",
      "업무 유형별 비중",
      "증감 추이",
      "조직별 히트맵",
      "업무별 모델·비용",
      "신규·급증 업무",
      "반복 업무·자동화 후보",
      "인사이트",
    ]);
    // The KPI tiles come before the first section.
    const first = screen.getByRole("heading", { level: 2, name: "업무 유형별 비중" });
    const kpis = screen.getByRole("region", { name: "요약 지표" });
    expect(kpis.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("states the scope: everything, the period, the comparison and how far the data goes", async () => {
    mockUsage();
    open();
    const line = await screen.findByLabelText("현재 조회 범위");
    await waitFor(() => expect(line).toHaveTextContent("2026-11-27 11:10:00"));
    expect(line).toHaveTextContent("범위전체");
    expect(line).toHaveTextContent("(30일)");
    expect(line).toHaveTextContent("비교 기간2026-09-29 ~ 2026-10-28");
    expect(line).toHaveTextContent("집계 기준업무 세션 수");
    expect(line).toHaveTextContent("3명 미만");
  });

  it("shows insights with their period, comparison, sample and a link built from link", async () => {
    mockUsage();
    open();
    const list = await screen.findByRole("list", { name: "인사이트 목록" });
    const [first, second] = within(list).getAllByRole("listitem") as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent("2026-10-29 ~ 2026-11-27");
    expect(first).toHaveTextContent("2026-09-29 ~ 2026-10-28");
    expect(first).toHaveTextContent("2,280건");
    expect(within(first).getByRole("link", { name: /근거 화면 열기/u })).toHaveAttribute(
      "href",
      "/insights/usage?tab=categories&parent=dev",
    );
    expect(second).toHaveTextContent("비교 없음");
    expect(within(second).queryByRole("link")).toBeNull();
  });

  it("shows the first six insights and opens the rest in place", async () => {
    mockUsage({
      [`GET ${base}/insights`]: answer((query) => {
        const built = fixtureInsights(query);
        const [first] = built.rows;
        const rows = Array.from({ length: 9 }, (_, index) => ({
          ...first,
          id: `ins-${index}`,
          title: `인사이트 ${index + 1}`,
        }));
        return { ...built, rows };
      }),
    });
    open();
    const list = await screen.findByRole("list", { name: "인사이트 목록" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    const more = screen.getByRole("button", { name: "나머지 3개 더 보기" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(within(screen.getByRole("list", { name: "인사이트 목록" })).getAllByRole("listitem")).toHaveLength(
      9,
    );
    expect(screen.getByRole("button", { name: "처음 6개만 보기" })).toHaveAttribute("aria-expanded", "true");
  });

  it("does not compare automation candidates with a previous period they do not have", async () => {
    mockUsage();
    open();
    const kpis = await screen.findByRole("region", { name: "요약 지표" });
    const tile = within(kpis).getByRole("article", { name: "자동화 후보" });
    expect(tile).toHaveTextContent("현재 후보 수 · 이력이 없어 비교하지 않음");
    expect(tile).not.toHaveTextContent("직전");
  });
});

describe("UsagePage filters", () => {
  it("refetches every panel with metric= when the metric changes and keeps it in the URL", async () => {
    const api = mockUsage();
    open();
    await screen.findByRole("region", { name: "요약 지표" });
    expect(api.queries("overview").at(-1)).toMatchObject({ metric: "sessions", compare: "prev" });

    fireEvent.change(screen.getByLabelText("집계 기준"), { target: { value: "cost" } });
    await waitFor(() => expect(location().searchParams.get("metric")).toBe("cost"));
    for (const name of ["overview", "categories", "trend", "matrix", "models", "trends"]) {
      await waitFor(() => expect(api.queries(name).at(-1)).toMatchObject({ metric: "cost" }));
    }
    const sent = api.queries("overview").at(-1) as Record<string, string>;
    expect(sent.from).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(sent.to).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    await waitFor(() => expect(screen.getByLabelText("현재 조회 범위")).toHaveTextContent("집계 기준비용"));
  });

  it("restores every filter from the URL and sends them", async () => {
    const api = mockUsage();
    open(
      `/insights/usage?days=7&compare=none&team=${encodeURIComponent("플랫폼팀")}&category=dev.codegen&action=create&model=gpt-4.1&client=Cursor&metric=tokens&tab=teams`,
    );
    await screen.findByRole("heading", { name: "조직 × 업무 히트맵" });
    expect(screen.getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("switch", { name: "직전 기간 비교" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("팀")).toHaveValue("플랫폼팀");
    expect(screen.getByLabelText("업무 분류 대분류")).toHaveValue("dev");
    await waitFor(() => expect(screen.getByLabelText("업무 분류 중분류")).toHaveValue("dev.codegen"));
    expect(screen.getByLabelText("작업 유형")).toHaveValue("create");
    expect(screen.getByLabelText("모델")).toHaveValue("gpt-4.1");
    expect(screen.getByLabelText("클라이언트")).toHaveValue("Cursor");
    expect(screen.getByLabelText("집계 기준")).toHaveValue("tokens");
    await waitFor(() =>
      expect(api.queries("matrix").at(-1)).toMatchObject({
        compare: "none",
        team: "플랫폼팀",
        category: "dev.codegen",
        action: "create",
        model: "gpt-4.1",
        client: "Cursor",
        metric: "tokens",
      }),
    );
    const scope = screen.getByLabelText("현재 조회 범위");
    expect(scope).toHaveTextContent("필터 5개 적용");
    expect(scope).toHaveTextContent("비교 안 함");
  });

  it("clears every filter on reset and keeps the tab", async () => {
    const api = mockUsage();
    open(`/insights/usage?tab=teams&days=7&compare=none&team=${encodeURIComponent("플랫폼팀")}&metric=cost`);
    await screen.findByRole("heading", { name: "조직 × 업무 히트맵" });
    const reset = screen.getByRole("button", { name: "필터 초기화" });
    expect(reset).toBeEnabled();

    fireEvent.click(reset);
    await waitFor(() =>
      expect(`${location().pathname}${location().search}`).toBe("/insights/usage?tab=teams"),
    );
    await waitFor(() => {
      const sent = api.queries("matrix").at(-1) as Record<string, unknown>;
      expect(sent).toMatchObject({ compare: "prev", metric: "sessions" });
      expect(sent).not.toHaveProperty("team");
    });
    expect(screen.getByRole("button", { name: "30일" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "필터 초기화" })).toBeDisabled();
    expect(screen.getByLabelText("현재 조회 범위")).toHaveTextContent("범위전체");
  });

  it("applies a custom range only when both dates are valid", async () => {
    const api = mockUsage();
    open();
    await screen.findByRole("region", { name: "요약 지표" });
    fireEvent.click(screen.getByRole("button", { name: "직접 입력" }));
    fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(await screen.findByText(/시작일이 종료일보다 늦거나/u)).toBeVisible();
    expect(location().search).toBe("");

    fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    await waitFor(() => expect(location().search).toBe("?from=2026-10-20&to=2026-10-31"));
    await waitFor(() =>
      expect(api.queries("overview").at(-1)).toMatchObject({ from: "2026-10-20", to: "2026-10-31" }),
    );
  });
});

describe("UsagePage category drill-down", () => {
  it("drills 대분류 → 중분류 → 소분류 through the URL and opens a leaf's sessions", async () => {
    const api = mockUsage();
    open("/insights/usage?tab=categories");
    fireEvent.click(await screen.findByRole("button", { name: "소프트웨어 개발 하위 분류 보기" }));
    await waitFor(() => expect(location().searchParams.get("parent")).toBe("dev"));
    await waitFor(() =>
      expect(api.queries("categories").some((query) => "parent" in query && query.parent === "dev")).toBe(
        true,
      ),
    );
    // The trend narrows to the same category.
    await waitFor(() => expect(api.queries("trend").at(-1)).toMatchObject({ category: "dev" }));

    fireEvent.click(await screen.findByRole("button", { name: "코드 생성 하위 분류 보기" }));
    await waitFor(() => expect(location().searchParams.get("parent")).toBe("dev.codegen"));
    const crumbs = within(screen.getByRole("navigation", { name: "업무 분류 단계" }));
    expect(crumbs.getByRole("button", { name: "전체 업무" })).toBeVisible();
    expect(crumbs.getByRole("button", { name: "소프트웨어 개발" })).toBeVisible();
    await waitFor(() => expect(crumbs.getByText("코드 생성")).toHaveAttribute("aria-current", "page"));

    fireEvent.click(await screen.findByRole("button", { name: "API 구현 세션 보기" }));
    await waitFor(() => expect(location().searchParams.get("tab")).toBe("sessions"));
    expect(location().searchParams.get("category")).toBe("dev.codegen.api");
    expect(location().searchParams.has("parent")).toBe(false);
    await waitFor(() =>
      expect(api.queries("sessions").at(-1)).toMatchObject({ category: "dev.codegen.api" }),
    );
    expect(await screen.findByRole("table", { name: "업무 세션 목록" })).toBeVisible();
  });

  it("always lists unclassified and failed as their own rows with an explanation", async () => {
    mockUsage();
    open("/insights/usage?tab=categories");
    const table = await screen.findByRole("table", { name: "전체 업무 대분류 목록" });
    const names = within(table)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent);
    expect(names).toEqual(["소프트웨어 개발", "데이터 분석", "일반 사무", "정보보호", "미분류", "분류 실패"]);
    expect(screen.getAllByText(/미분류는 규칙과 캐시/u).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/분류 실패는 분류 모델 호출이 실패/u).length).toBeGreaterThan(0);
    // A suppressed category shows the protection label instead of numbers, never a 0.
    const suppressed = within(table).getByRole("row", { name: /정보보호/u });
    expect(within(suppressed).getAllByText("보호됨").length).toBeGreaterThanOrEqual(4);
    expect(within(suppressed).queryByText("0")).toBeNull();
    expect(within(suppressed).queryByText("₩0")).toBeNull();
    // The unclassified row leads to its requests.
    fireEvent.click(within(table).getByRole("button", { name: "미분류 요청 보기" }));
    await waitFor(() =>
      expect(Object.fromEntries(location().searchParams)).toEqual({
        tab: "sessions",
        list: "requests",
        status: "unclassified",
      }),
    );
  });

  it("offers every chart's values as a table", async () => {
    mockUsage();
    open("/insights/usage?tab=categories");
    await screen.findByRole("table", { name: "전체 업무 대분류 목록" });
    for (const caption of [
      "전체 업무 대분류별 업무 세션 수 비중",
      "전체 업무 대분류별 업무 세션 수 트리맵",
      "전체 업무 대분류별 사용량과 비용",
      "전체 업무 대분류별 업무 세션 수 추이",
    ]) {
      await waitFor(() => expect(screen.getByRole("img", { name: caption })).toBeInTheDocument());
      expect(screen.getByRole("table", { name: caption, hidden: true })).toBeInTheDocument();
    }
    expect(screen.getAllByText("표로 보기").length).toBeGreaterThanOrEqual(5);
  });
});

describe("UsagePage privacy", () => {
  it("shows 보호됨 with the minimum group size for a suppressed heatmap cell", async () => {
    mockUsage();
    open();
    const heatmap = await screen.findByRole("table", { name: "조직별 업무 활용 히트맵" });
    const row = within(heatmap).getByRole("row", { name: /경영지원팀/u });
    const cell = within(row).getByText("보호됨").closest("td");
    expect(cell).toHaveAttribute("data-suppressed", "true");
    expect(cell).toHaveAttribute("title", expect.stringContaining("3명 미만"));
    // A shown cell is a button that names its team, category and value.
    expect(within(heatmap).getByRole("button", { name: /플랫폼팀 · 소프트웨어 개발 · 410/u })).toBeVisible();
  });

  it("does not print a user identifier the server masked, and writes an empty one as a dash", async () => {
    mockUsage();
    open("/insights/usage?tab=sessions");
    const table = await screen.findByRole("table", { name: "업무 세션 목록" });
    // Every fourth fixture session has an empty (masked) user.
    const row = (await within(table).findByRole("button", { name: "세션 sess_0004 상세 열기" })).closest(
      "tr",
    );
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement).getAllByRole("cell");
    const header = within(table).getAllByRole("columnheader");
    const userColumn = header.findIndex((cell) => cell.textContent?.includes("사용자"));
    expect(cells[userColumn]).toHaveTextContent(/^—$/u);
    // No filter or link is offered on it.
    expect(within(cells[userColumn] as HTMLElement).queryByRole("button")).toBeNull();
    expect(within(cells[userColumn] as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(table).queryByText("u-004")).toBeNull();
    expect(within(table).queryByText("가려짐")).toBeNull();
  });
});

describe("UsagePage states", () => {
  it("says classification is still catching up when there is a backlog", async () => {
    mockUsage({
      [`GET ${base}/overview`]: answer((query) =>
        fixtureOverview(query, { backlog: 320, data_through: "2026-11-26T09:00:00Z" }),
      ),
    });
    open();
    const notice = await screen.findByText("분류 진행 중");
    const body = notice.closest(".inline-notice") as HTMLElement;
    expect(body).toHaveTextContent("320건");
    expect(body).toHaveTextContent("2026-11-26 18:00:00");
    expect(screen.getByRole("region", { name: "요약 지표" })).toBeVisible();
  });

  it("says the classifier is off while still showing what was classified before", async () => {
    mockUsage({
      [`GET ${base}/overview`]: answer((query) => fixtureOverview(query, { classify_enabled: false })),
    });
    open();
    expect(await screen.findByText("분류 엔진이 꺼져 있습니다.")).toBeVisible();
    expect(screen.queryByText("분류 진행 중")).toBeNull();
    expect(await screen.findByRole("region", { name: "요약 지표" })).toBeVisible();
  });

  it("explains that the analysis is switched off and loads nothing else", async () => {
    const api = mockUsage({
      [`GET ${base}/status`]: answer(() => fixtureStatus({ analytics_enabled: false })),
    });
    open();
    expect(await screen.findByRole("heading", { name: "업무 활용 분석이 꺼져 있습니다." })).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    // Only the status read was made: no panel asked a server that has the analysis off.
    expect(api.calls.map((call) => call.key)).toEqual([`GET ${base}/status`]);
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
  });

  it("explains a server that does not implement the API yet (501)", async () => {
    const notImplemented = (): never => {
      throw new AppError("work intelligence is not implemented yet", {
        kind: "http",
        status: 501,
        code: "work_intel_not_implemented",
      });
    };
    const api = mockUsage(
      Object.fromEntries(Object.keys(fixtureReads).map((name) => [`GET ${base}/${name}`, notImplemented])),
    );
    open();
    expect(
      await screen.findByRole("heading", { name: "이 서버에서는 업무 활용 분석을 아직 제공하지 않습니다." }),
    ).toBeVisible();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.calls.map((call) => call.key)).toEqual([`GET ${base}/status`]);
  });

  it("keeps the rest of the page working when one panel fails, and retries that panel alone", async () => {
    let fail = true;
    const api = mockUsage({
      [`GET ${base}/trend`]: (options, endpoint) => {
        if (fail) throw apiFailure("trend store unavailable", 500, "req_trend_1");
        return endpoint.schema.parse(fixtureReads.trend?.((options.query ?? {}) as FixtureQuery));
      },
    });
    open();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("증감 추이 조회 실패");
    expect(alert).toHaveTextContent("req_trend_1");
    // Everything else rendered.
    expect(screen.getByRole("region", { name: "요약 지표" })).toBeVisible();
    expect(await screen.findByRole("img", { name: "업무 유형별 업무 세션 수 비중" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "조직별 업무 활용 히트맵" })).toBeVisible();
    expect(await screen.findByRole("list", { name: "인사이트 목록" })).toBeVisible();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    const before = api.queries("overview").length;
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "증감 추이 다시 시도" }));
    expect(await screen.findByRole("img", { name: "업무 유형별 업무 세션 수 추이" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.queries("overview")).toHaveLength(before);
  });

  it("tells an empty period apart from loading and from failure", async () => {
    mockUsage({
      [`GET ${base}/categories`]: answer((query) => ({
        ...(fixtureReads.categories?.(query) as object),
        rows: [],
        unclassified: {},
        failed: {},
        total: {},
      })),
      [`GET ${base}/matrix`]: answer((query) => ({ ...(fixtureReads.matrix?.(query) as object), rows: [] })),
    });
    open();
    expect(
      await screen.findByText(/업무 유형별 비중: 선택한 기간과 필터에 해당하는 데이터가 없습니다/u),
    ).toBeVisible();
    expect(
      await screen.findByText(/조직별 히트맵: 선택한 기간과 필터에 해당하는 데이터가 없습니다/u),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("UsagePage sessions and requests", () => {
  it("pages and sorts on the server, opens a session and links a request to the request explorer", async () => {
    const api = mockUsage({
      [`GET ${base}/sessions/sess_0001`]: answer(() => fixtureSessionDetail("sess_0001")),
    });
    open("/insights/usage?tab=sessions");
    const table = await screen.findByRole("table", { name: "업무 세션 목록" });
    expect(api.queries("sessions").at(-1)).toMatchObject({ limit: 25, offset: 0, sort: "last_at:desc" });
    expect(await screen.findByText("전체 60건 중 1–25")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(location().searchParams.get("page")).toBe("2"));
    await waitFor(() => expect(api.queries("sessions").at(-1)).toMatchObject({ offset: 25 }));

    fireEvent.click(within(table).getByRole("button", { name: "비용 내림차순 정렬" }));
    await waitFor(() => expect(location().searchParams.get("sort")).toBe("cost_krw:desc"));
    await waitFor(() =>
      expect(api.queries("sessions").at(-1)).toMatchObject({ sort: "cost_krw:desc", offset: 0 }),
    );

    fireEvent.change(screen.getByLabelText("세션 완료 상태"), { target: { value: "confirmed" } });
    await waitFor(() =>
      expect(api.queries("sessions").at(-1)).toMatchObject({ session_status: "confirmed" }),
    );

    fireEvent.change(screen.getByLabelText("세션 완료 상태"), { target: { value: "" } });
    fireEvent.click(await screen.findByRole("button", { name: "세션 sess_0001 상세 열기" }));
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(location().searchParams.get("session")).toBe("sess_0001"));
    expect(await within(sheet).findByRole("table", { name: "세션의 업무 구간" })).toBeVisible();
    const requests = within(sheet).getByRole("table", { name: "세션의 요청" });
    expect(within(requests).getAllByRole("link")[0]).toHaveAttribute(
      "href",
      "/observability/requests?request_id=req_00001",
    );
  });

  it("opens a session whose ID the URL policy refuses without writing it to the address", async () => {
    const secretLike = "sk-proj-abcdefgh12345678";
    mockUsage({
      [`GET ${base}/sessions`]: answer((query) => {
        const page = fixtureReads.sessions?.(query) as { rows: Record<string, unknown>[] };
        return { ...page, rows: [{ ...page.rows[0], session_id: secretLike }] };
      }),
      [`GET ${base}/sessions/${secretLike}`]: answer(() => fixtureSessionDetail(secretLike)),
    });
    open("/insights/usage?tab=sessions");
    fireEvent.click(await screen.findByRole("button", { name: `세션 ${secretLike} 상세 열기` }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("table", { name: "세션의 업무 구간" })).toBeVisible();
    expect(location().search).toBe("?tab=sessions");
    fireEvent.click(within(sheet).getByRole("button", { name: "패널 닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("filters the request list by classification status and confidence", async () => {
    const api = mockUsage();
    open("/insights/usage?tab=sessions&list=requests");
    await screen.findByRole("table", { name: "분류된 요청 목록" });
    expect(api.queries("sessions")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("분류 상태"), { target: { value: "review" } });
    await waitFor(() => expect(api.queries("requests").at(-1)).toMatchObject({ status: "review" }));
    fireEvent.change(screen.getByLabelText("신뢰도"), { target: { value: "low" } });
    await waitFor(() => expect(api.queries("requests").at(-1)).toMatchObject({ max_conf: 0.5 }));
    expect(Object.fromEntries(location().searchParams)).toEqual({
      tab: "sessions",
      list: "requests",
      status: "review",
      conf: "low",
    });
  });
});

describe("UsagePage trends and automation", () => {
  it("groups signals by kind and shows the numbers behind each", async () => {
    mockUsage();
    open("/insights/usage?tab=trends");
    const rising = await screen.findByRole("region", { name: "7일 급증 신호" });
    expect(rising).toHaveTextContent("코드 생성");
    expect(rising).toHaveTextContent("+50");
    expect(rising).toHaveTextContent("▲ 71.4%");
    expect(rising).toHaveTextContent("9명 → 14명");
    expect(rising).toHaveTextContent("720건");
    expect(screen.getByRole("region", { name: "신규 신호" })).toHaveTextContent("비교 기준 없음");
    expect(screen.getByRole("region", { name: "확산 신호" })).toHaveTextContent(
      "이 기간에는 해당 신호가 없습니다.",
    );
    expect(screen.getByRole("region", { name: "비용 이상 신호" })).toHaveTextContent("보호됨 → 보호됨");
    for (const kind of ["30일 급증", "특정 조직 집중", "감소", "모델 의존"]) {
      expect(screen.getByRole("region", { name: `${kind} 신호` })).toBeVisible();
    }
  });

  it("records a review decision for a candidate and says nothing is executed", async () => {
    const api = mockUsage({
      [`POST ${base}/automation/auto-weekly-report/review`]: (options, endpoint) =>
        endpoint.schema.parse({
          ...(fixtureReads.automation?.({}) as { rows: object[] }).rows[0],
          review_status: (options.body as { review_status: string }).review_status,
        }),
    });
    open("/insights/usage?tab=trends");
    fireEvent.click(
      await screen.findByRole("button", { name: "주간 장애 보고서 초안 작성 자동화 후보 상세" }),
    );
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(location().searchParams.get("candidate")).toBe("auto-weekly-report"));
    expect(sheet).toHaveTextContent("어떤 것도 자동으로 등록하거나 실행하지 않습니다");
    fireEvent.change(within(sheet).getByLabelText("검토 상태"), { target: { value: "accepted" } });
    fireEvent.change(within(sheet).getByLabelText("메모"), { target: { value: "  템플릿으로 등록 검토  " } });
    fireEvent.click(within(sheet).getByRole("button", { name: "검토 상태 기록" }));
    await waitFor(() =>
      expect(api.bodies(`POST ${base}/automation/auto-weekly-report/review`)).toEqual([
        { review_status: "accepted", note: "템플릿으로 등록 검토" },
      ]),
    );
    await waitFor(() => expect(notifications.success).toHaveBeenCalled());
  });

  it("does not offer the review action without admin:write", async () => {
    auth.scopes = ["admin:read"];
    const api = mockUsage();
    open("/insights/usage?tab=trends&candidate=auto-sql-audit");
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("button", { name: "검토 상태 기록" })).toBeDisabled();
    expect(sheet).toHaveTextContent("admin:write 권한이 필요합니다");
    // The sheet is modal, so the page behind it is hidden from the accessibility tree.
    expect(screen.getByRole("button", { name: /지금 다시 계산/u, hidden: true })).toBeDisabled();
    expect(api.calls.some((call) => call.key.startsWith("POST"))).toBe(false);
  });
});

describe("UsagePage other tabs", () => {
  it("states the denominator and that usage is not a performance score on the team tab", async () => {
    mockUsage();
    open("/insights/usage?tab=teams");
    expect(await screen.findByText("이 탭의 수치를 읽는 법")).toBeVisible();
    const note = screen.getByText("이 탭의 수치를 읽는 법").closest(".inline-notice") as HTMLElement;
    expect(note).toHaveTextContent("활성 사용자");
    expect(note).toHaveTextContent("성과 평가에 쓰도록 만든 것이 아닙니다");
    const table = await screen.findByRole("table", { name: "조직별 업무 활용" });
    const suppressed = within(table).getByRole("row", { name: /보안팀/u });
    // Value, users, per-user sessions, top categories, diversity, cost, rising and deviation.
    expect(within(suppressed).getAllByText("보호됨")).toHaveLength(8);
    expect(within(suppressed).queryByText("₩0")).toBeNull();
    expect(await screen.findByRole("img", { name: /조직에서 업무를 거쳐 모델로 가는/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /조직 플랫폼팀 · 490/u })).toBeInTheDocument();
  });

  it("marks low-sample model rows and lists suggestions with their basis", async () => {
    mockUsage();
    open("/insights/usage?tab=models");
    const table = await screen.findByRole("table", { name: "업무별 모델 사용 현황" });
    const low = within(table).getByRole("row", { name: /gpt-4.1-mini/u });
    expect(within(low).getByText("표본 적음")).toBeVisible();
    expect(within(table).getAllByText("표본 적음")).toHaveLength(1);
    const suggestions = screen.getByRole("list", { name: "모델 변경 제안" });
    expect(suggestions).toHaveTextContent("세션당 비용이 62% 낮음");
    expect(suggestions).toHaveTextContent("210세션");
  });

  it("labels observed and estimated figures and gives the reason when there is no estimate", async () => {
    mockUsage();
    open("/insights/usage?tab=productivity");
    const table = await screen.findByRole("table", { name: "업무별 관측값과 추정 절감" });
    expect(within(table).getAllByText("관측").length).toBe(3);
    expect(within(table).getAllByText("추정").length).toBe(2);
    expect(within(table).getByRole("row", { name: /소프트웨어 개발/u })).toHaveTextContent("약 5,400분");
    const noBaseline = within(table).getByRole("row", { name: /일반 사무/u });
    expect(noBaseline).toHaveTextContent("추정 불가");
    expect(noBaseline).toHaveTextContent("기준값이 등록되지 않았습니다.");
  });

  it("offers CSV export only on tabs the server has a table for", async () => {
    mockUsage();
    open("/insights/usage?tab=productivity");
    await screen.findByRole("table", { name: "업무별 관측값과 추정 절감" });
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "모델" }));
    await screen.findByRole("table", { name: "업무별 모델 사용 현황" });
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeEnabled();
  });
});

describe("UsagePage small-group protection", () => {
  /** What a caller who may not see raw prompts gets for a request: nothing derived from the prompt. */
  const withoutPromptText = <Row extends object>(row: Row): Row => ({
    ...row,
    user: "",
    work_title: "",
    tags: [],
    technologies: [],
  });

  it("says 보호됨, not 0, on every KPI of a withheld period and on its distribution panels", async () => {
    mockUsage({
      [`GET ${base}/overview`]: answer((query) => {
        const built = fixtureOverview(query);
        return {
          ...built,
          current: {
            ...fixtureWithheld(),
            teams: 2,
            active_categories: null,
            classified_rate: null,
            new_categories: null,
            automation_candidates: 1,
          },
          growth_rate: null,
          confidence: [],
          methods: [],
          statuses: [],
        };
      }),
    });
    open();
    const kpis = await screen.findByRole("region", { name: "요약 지표" });
    for (const label of [
      "업무 세션",
      "LLM 요청",
      "활용 사용자",
      "활성 업무 유형",
      "분류 완료율",
      "증가율",
      "신규 업무",
    ]) {
      const tile = within(kpis).getByRole("article", { name: label });
      expect(within(tile).getByText("보호됨")).toHaveAttribute("title", expect.stringContaining("3명 미만"));
      expect(tile.querySelector(".stat-card-value")).not.toHaveTextContent(/^(0|0\.0%)$/u);
    }
    // The previous period was shown, so it is still the comparison.
    expect(within(kpis).getByRole("article", { name: "업무 세션" })).toHaveTextContent("직전 1,000");
    expect(within(kpis).getByRole("article", { name: "분류 완료율" })).toHaveTextContent("직전 90.0%");
    // Teams and candidates are never withheld.
    expect(within(kpis).getByRole("article", { name: "활용 조직" })).toHaveTextContent("2");
    expect(within(kpis).getByRole("article", { name: "자동화 후보" })).toHaveTextContent("1");
    const distribution = screen.getByRole("region", { name: "분류 신뢰도 분포" });
    expect(distribution).toHaveTextContent("보호됨");
    expect(distribution).not.toHaveTextContent("신뢰도 분포 데이터가 없습니다");
  });

  it("says 직전 기간은 보호됨 when only the previous period is withheld", async () => {
    mockUsage({
      [`GET ${base}/overview`]: answer((query) => {
        const built = fixtureOverview(query);
        return {
          ...built,
          previous: {
            ...fixtureWithheld(),
            teams: 1,
            active_categories: null,
            classified_rate: null,
            new_categories: null,
            automation_candidates: 1,
          },
          growth_rate: null,
        };
      }),
    });
    open();
    const kpis = await screen.findByRole("region", { name: "요약 지표" });
    const sessions = within(kpis).getByRole("article", { name: "업무 세션" });
    expect(sessions).toHaveTextContent("1,240");
    expect(sessions).toHaveTextContent("직전 기간은 보호됨");
    expect(within(kpis).getByRole("article", { name: "분류 완료율" })).toHaveTextContent(
      "직전 기간은 보호됨",
    );
    expect(within(within(kpis).getByRole("article", { name: "증가율" })).getByText("보호됨")).toBeVisible();
  });

  it("writes a withheld trend bucket as 보호됨 in the table views, and its incomplete sums as such", async () => {
    mockUsage({
      [`GET ${base}/trend`]: answer((query) => {
        const built = fixtureTrend(query);
        const [first, ...rest] = built.series;
        if (!first) throw new Error("fixture has no series");
        return {
          ...built,
          series: [
            { ...first, values: first.values.map((value, index) => (index === 1 ? null : value)) },
            ...rest,
          ],
          total: built.total.map((value, index) => (index === 2 ? null : value)),
        };
      }),
    });
    open("/insights/usage?tab=categories");
    const stacked = await screen.findByRole("table", {
      name: "전체 업무 대분류별 업무 세션 수 추이",
      hidden: true,
    });
    const withheldRow = within(stacked).getByRole("row", { name: /^11-22/u, hidden: true });
    // 구간, 소프트웨어 개발 (withheld), 데이터 분석, 일반 사무, 그 외, 합계.
    const cells = within(withheldRow).getAllByRole("cell", { hidden: true });
    expect(cells[0]).toHaveTextContent(/^보호됨$/u);
    expect(cells.at(-1)).toHaveTextContent("(일부 보호됨)");
    expect(within(stacked).getByRole("row", { name: /^11-21/u, hidden: true })).not.toHaveTextContent(
      "보호됨",
    );

    const total = screen.getByRole("table", { name: "전체 업무 업무 세션 수 합계 추이", hidden: true });
    expect(within(total).getByRole("row", { name: /^11-23/u, hidden: true })).toHaveTextContent(/보호됨$/u);
    expect(within(total).getByRole("row", { name: /^11-22/u, hidden: true })).not.toHaveTextContent("보호됨");
    const chart = screen.getByRole("img", { name: "전체 업무 업무 세션 수 합계 추이" });
    expect(chart.querySelector('[data-withheld="true"] title')).toHaveTextContent("11-23 · 보호됨");
  });

  it("writes every measure of a withheld model row as 보호됨 and ignores its low-sample flag", async () => {
    mockUsage();
    open("/insights/usage?tab=models");
    const table = await screen.findByRole("table", { name: "업무별 모델 사용 현황" });
    const row = within(table).getByRole("row", { name: /claude-haiku/u });
    // Share, sessions, cost, tokens, P50, P95, errors, retries, switches and feedback.
    expect(within(row).getAllByText("보호됨")).toHaveLength(10);
    expect(within(row).queryByText("표본 적음")).toBeNull();
    expect(within(row).queryByText("0.0%")).toBeNull();
    expect(within(table).getAllByText("표본 적음")).toHaveLength(1);
    expect(screen.getByText(/사용자가 적은 1개 행은 수치를 ‘보호됨’으로 가렸고/u)).toBeVisible();
  });

  it("writes the figures of a withheld productivity row as 보호됨 with the server's reason", async () => {
    mockUsage();
    open("/insights/usage?tab=productivity");
    const table = await screen.findByRole("table", { name: "업무별 관측값과 추정 절감" });
    const row = within(table).getByRole("row", { name: /정보보호/u });
    // Sessions, confirmed sessions, model time, minutes and cost saved.
    expect(within(row).getAllByText("보호됨")).toHaveLength(5);
    expect(row).toHaveTextContent("사용자가 적어 개인을 추정할 수 없도록 수치를 가렸습니다.");
    expect(row).not.toHaveTextContent("추정 불가");
    expect(row).toHaveTextContent("수작업 30분");
  });

  it("shows the category name in place of a work title the caller may not see", async () => {
    mockUsage({
      [`GET ${base}/requests`]: answer((query) => {
        const built = fixtureRequests(query);
        return { ...built, rows: built.rows.map(withoutPromptText) };
      }),
      [`GET ${base}/sessions/sess_0001`]: answer(() => {
        const built = fixtureSessionDetail("sess_0001");
        return {
          ...built,
          session: { ...built.session, user: "" },
          requests: built.requests.map(withoutPromptText),
        };
      }),
    });
    open("/insights/usage?tab=sessions&list=requests");
    const table = await screen.findByRole("table", { name: "분류된 요청 목록" });
    const fallbacks = await within(table).findAllByTitle("작업 제목이 없어 업무 이름을 대신 표시합니다.");
    expect(fallbacks.length).toBe(25);
    expect(fallbacks[0]).toHaveTextContent("API 구현");
    expect(within(table).queryByText(/주문 API/u)).toBeNull();

    fireEvent.click(within(table).getByRole("button", { name: "요청 req_00001의 세션 열기" }));
    const sheet = await screen.findByRole("dialog");
    const requests = await within(sheet).findByRole("table", { name: "세션의 요청" });
    expect(
      within(requests).getAllByTitle("작업 제목이 없어 업무 이름을 대신 표시합니다.")[0],
    ).toHaveTextContent("API 구현");
    const user = within(sheet).getByText("사용자").closest(".kv-item");
    expect(user).toHaveTextContent(/^사용자—$/u);
  });

  it("notes withheld flow links and does not offer the 기타 node as a filter", async () => {
    mockUsage({
      [`GET ${base}/flow`]: answer((query) => {
        const built = fixtureFlow(query);
        return {
          ...built,
          nodes: [...built.nodes, { id: "team:기타", kind: "team", name: "기타", value: 20 }],
          links: [...built.links, { source: "team:기타", target: "category:data", value: 20 }],
          suppressed_links: 2,
        };
      }),
    });
    open("/insights/usage?tab=teams");
    expect(await screen.findByText(/보호된 연결 2개/u)).toBeVisible();
    expect(screen.getByRole("button", { name: /조직 플랫폼팀 · 490/u })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /조직 기타 ·/u })).toBeNull();
  });

  it("says why a team-scoped administrator cannot record a review for a candidate spanning teams", async () => {
    mockUsage({
      [`POST ${base}/automation/auto-weekly-report/review`]: () => {
        throw new AppError("a team-scoped administrator can only review their own team", {
          kind: "permission",
          status: 403,
          code: "work_intel_team_forbidden",
          requestId: "req_review_1",
        });
      },
    });
    open("/insights/usage?tab=trends&candidate=auto-weekly-report");
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(await within(sheet).findByRole("button", { name: "검토 상태 기록" }));
    await waitFor(() =>
      expect(notifications.error).toHaveBeenCalledWith(
        expect.stringContaining("팀 범위 관리자는 검토 상태를 기록할 수 없습니다"),
        expect.objectContaining({ description: "요청 ID: req_review_1" }),
      ),
    );
    expect(notifications.success).not.toHaveBeenCalled();
  });
});

describe("UsagePage withheld scopes", () => {
  /** The 보호됨 box a panel shows when the server withheld its whole scope. */
  const withheldPanel = async (label: string): Promise<HTMLElement> => {
    const heading = await screen.findByText(new RegExp(`^${label}:`, "u"));
    const box = heading.closest<HTMLElement>('[data-withheld="true"]');
    if (!box) throw new Error(`${label} is not shown as withheld`);
    expect(box).toHaveTextContent("보호됨");
    expect(box).toHaveTextContent(withheldScopeText);
    return box;
  };

  it("tells a caller without raw-prompt access why the classification-quality panel is empty", async () => {
    mockUsage({
      [`GET ${base}/overview`]: answer((query) => ({
        ...fixtureOverview(query, { small_groups_withheld: true }),
        confidence: [],
        methods: [],
        statuses: [],
      })),
    });
    open();
    const distribution = await screen.findByRole("region", { name: "분류 신뢰도 분포" });
    expect(distribution).toHaveTextContent(qualityWithheldNote);
    expect(distribution).not.toHaveTextContent("신뢰도 분포 데이터가 없습니다");
    expect(distribution).not.toHaveTextContent("보호됨");
    expect(distribution).not.toHaveTextContent("분류 방식");
    // The headline numbers are not affected.
    expect(screen.getByRole("article", { name: "업무 세션" })).toHaveTextContent("1,240");
  });

  it("shows 보호됨 instead of an empty trend when the whole scope is withheld", async () => {
    mockUsage({
      [`GET ${base}/trend`]: answer((query) => ({
        ...fixtureTrend(query),
        series: [],
        other: [],
        total: [],
        suppressed: true,
      })),
    });
    open();
    await withheldPanel("증감 추이");
    expect(screen.queryByRole("img", { name: "업무 유형별 업무 세션 수 추이" })).toBeNull();
    expect(screen.queryByText(/증감 추이: 선택한 기간과 필터에 해당하는 데이터가 없습니다/u)).toBeNull();
  });

  it("shows 보호됨 instead of an empty flow, model list and productivity table", async () => {
    mockUsage({
      [`GET ${base}/flow`]: answer((query) => ({
        ...fixtureFlow(query),
        nodes: [],
        links: [],
        suppressed_links: 4,
        suppressed: true,
      })),
      [`GET ${base}/models`]: answer((query) => ({
        ...fixtureModels(query),
        rows: [],
        suggestions: [],
        suppressed: true,
      })),
      [`GET ${base}/productivity`]: answer((query) => ({
        ...fixtureProductivity(query),
        rows: [],
        suppressed: true,
      })),
    });
    open("/insights/usage?tab=teams");
    await withheldPanel("조직 → 업무 → 모델 흐름");
    expect(screen.queryByText(/표시할 흐름이 없습니다/u)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "모델" }));
    await withheldPanel("업무 × 모델");
    await withheldPanel("모델 변경 제안");
    expect(screen.queryByRole("table", { name: "업무별 모델 사용 현황" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "생산성" }));
    await withheldPanel("생산성");
    expect(screen.queryByRole("table", { name: "업무별 관측값과 추정 절감" })).toBeNull();
    expect(screen.queryByText(/데이터가 없습니다/u)).toBeNull();
  });

  it("shows 보호됨 instead of an empty level when the level's total is withheld", async () => {
    mockUsage({
      [`GET ${base}/categories`]: answer((query) => ({
        ...fixtureCategoryRows(query),
        rows: [],
        unclassified: fixtureWithheld(),
        failed: fixtureWithheld(),
        total: fixtureWithheld(),
      })),
    });
    open("/insights/usage?tab=categories");
    await withheldPanel("전체 업무 대분류");
    expect(screen.queryByRole("table", { name: "전체 업무 대분류 목록" })).toBeNull();
    expect(screen.queryByText(/데이터가 없습니다/u)).toBeNull();
  });

  it("lists every category as 보호됨 while still showing the level's total", async () => {
    mockUsage({
      [`GET ${base}/categories`]: answer((query) => {
        const built = fixtureCategoryRows(query);
        return {
          ...built,
          rows: built.rows.map((row) => ({
            ...row,
            current: fixtureWithheld(),
            share: null,
            delta: null,
            suppressed: true,
          })),
          unclassified: fixtureWithheld(),
          failed: fixtureWithheld(),
        };
      }),
    });
    open("/insights/usage?tab=categories");
    const table = await screen.findByRole("table", { name: "전체 업무 대분류 목록" });
    for (const name of ["소프트웨어 개발", "데이터 분석", "일반 사무", "정보보호", "미분류", "분류 실패"]) {
      const row = within(table).getByRole("row", { name: new RegExp(name, "u") });
      expect(within(row).getAllByText("보호됨").length).toBeGreaterThanOrEqual(2);
    }
    // The donut still stands, with the shown total in its centre and every slice listed as 보호됨.
    const donut = screen.getByRole("img", { name: "전체 업무 대분류별 업무 세션 수 비중" });
    expect(donut.querySelector(".wi-donut-center-value")).toHaveTextContent(
      formatMetricCompact(1_240, "sessions"),
    );
    expect(donut.querySelector('[data-withheld="true"]')).not.toBeNull();
    const legend = screen.getByRole("list", { name: "전체 업무 대분류별 업무 세션 수 비중 범례" });
    expect(within(legend).getAllByText("보호됨")).toHaveLength(6);
    // Charts with nothing to draw say why instead of "no values".
    expect(screen.queryByText("표시할 값이 없습니다.")).toBeNull();
    expect(screen.getAllByText(withheldChartText)).toHaveLength(2);
  });

  it("renders a heatmap row of a team too small to show, every cell withheld", async () => {
    mockUsage({
      [`GET ${base}/matrix`]: answer((query) => {
        const built = fixtureMatrix(query);
        return {
          ...built,
          rows: [
            ...built.rows,
            {
              team: "법무팀",
              total: fixtureWithheld(),
              cells: ["dev", "data", "office"].map((id) => ({
                category_id: id,
                value: null,
                users: null,
                suppressed: true,
              })),
            },
          ],
        };
      }),
    });
    open();
    const heatmap = await screen.findByRole("table", { name: "조직별 업무 활용 히트맵" });
    const row = within(heatmap).getByRole("row", { name: /법무팀/u });
    // Three cells and the total.
    expect(within(row).getAllByText("보호됨")).toHaveLength(4);
    expect(row.querySelectorAll('[data-suppressed="true"]')).toHaveLength(3);
    expect(within(row).queryByRole("button")).toBeNull();
  });
});
