import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";

import { TracePage } from "@/features/observability/traces/TracePage";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { AppRequestsResponse } from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({
  credentialPrefixes: ["corp_"],
  legacyFallback: true,
  legacyPath: "/admin#/llm",
  scopes: ["admin:read"] as string[],
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    credentialPrefixes: authRuntime.credentialPrefixes,
    features: [
      {
        appPath: "/app/observability/traces",
        fallbackEnabled: true,
        featureId: "observability.traces",
        legacyPath: authRuntime.legacyPath,
      },
    ],
    legacyFallback: authRuntime.legacyFallback,
    mode: "authenticated",
    user: {
      id: "admin-1",
      role: "admin",
      roles: ["admin"],
      scopes: authRuntime.scopes,
    },
  }),
}));

const providerRef = `prv_${"a".repeat(43)}`;
const firstRequestRef = `req_${"a".repeat(22)}.${"a".repeat(21)}`;
const secondRequestRef = `req_${"b".repeat(22)}.${"b".repeat(21)}`;
const previousCursor = `djE6cHJldmlvdXM.${"p".repeat(43)}`;
const nextCursor = `djE6bmV4dA.${"n".repeat(43)}`;
const firstRow = {
  request_id: "req-001",
  request_ref: firstRequestRef,
  request_filterable: true,
  trace_id: "trace-001",
  trace_filterable: true,
  session_id: "session-001",
  api_key_id: "key-001",
  ip: "192.0.2.10",
  method: "POST",
  model: "gpt-test",
  provider_ref: providerRef,
  provider_display: "공급자 하나",
  endpoint: "/v1/chat/completions",
  stream: true,
  status_code: 200,
  latency_ms: 200,
  first_chunk_ms: 40,
  prompt_tokens: 3,
  completion_tokens: 4,
  total_tokens: 7,
  cached_tokens: 1,
  reasoning_tokens: 0,
  estimated_cost: 1.25,
  currency: "KRW",
  finish_reason: "stop",
  created_at: "2026-09-04T01:02:03Z",
} as const;

const secondRow = {
  ...firstRow,
  request_id: "req-002",
  request_ref: secondRequestRef,
  status_code: 503,
  latency_ms: 400,
  created_at: "2026-09-04T01:02:03.100Z",
} as const;

const response = {
  request_contract_version: 2,
  requests: [secondRow, firstRow],
  limit: 50,
  previous_cursor: previousCursor,
  next_cursor: nextCursor,
  generated_at: "2026-09-04T01:03:00Z",
} satisfies AppRequestsResponse;

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        테스트 기록 뒤로
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        테스트 기록 앞으로
      </button>
    </>
  );
}

function renderPage(initialEntry = "/observability/traces") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/observability/traces"
            element={
              <>
                <TracePage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/observability/requests" element={<h1>요청 탐색기 대상</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TracePage", () => {
  beforeEach(() => {
    authRuntime.legacyFallback = true;
    authRuntime.legacyPath = "/admin#/llm";
    authRuntime.scopes = ["admin:read"];
    usePreferences.setState({ refreshInterval: 0 });
  });

  it("lists recent request-level traces with guidance and safe navigation", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    const view = renderPage();

    expect(await screen.findByRole("heading", { name: "추적 ID로 요청 흐름을 좁혀 보세요." })).toBeVisible();
    expect(screen.getByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "요청 목록" })).toBeVisible();
    expect(screen.getAllByText("trace-001", { exact: false }).length).toBeGreaterThan(0);
    const table = screen.getByRole("table", {
      name: "요청 시각, 상태, 식별자, 모델, 공급자, 지연, 토큰과 비용 목록",
    });
    for (const header of ["시각", "상태", "요청 ID", "모델", "공급자", "지연", "토큰", "비용"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeVisible();
    }
    const firstRowInTable = within(table).getByRole("row", { name: /req-001/u });
    await user.click(within(firstRowInTable).getByText("req-001"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("selected_request");
    const detailTrigger = within(firstRowInTable).getByRole("button", {
      name: "1번째 요청 req-001 상세 보기",
    });
    await user.click(detailTrigger);
    expect(screen.getByTestId("location")).toHaveTextContent("selected_request=req-001");
    expect(screen.getByTestId("location")).not.toHaveTextContent("selected_ref");
    expect(detailTrigger).toHaveAttribute("aria-controls", "trace-request-detail");
    expect(detailTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "1번째 요청 req-001" })).toHaveFocus();
    expect(screen.getByText("1번째 요청 req-001 상세가 열렸습니다.", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "요청 탐색기" })).toHaveAttribute(
      "href",
      expect.stringContaining("request_id=req-001"),
    );
    expect(screen.getByRole("link", { name: /기존 화면 보기/u })).toHaveAttribute("href", "/admin#/llm");
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        endpoints.admin.requests,
        expect.objectContaining({
          headers: { "X-Vibe-App-Requests-Version": "2" },
          query: { limit: 50, tz: "Asia/Seoul" },
          routeId: "observability.traces",
        }),
      );
    });
    expect((await axe.run(view.container)).violations).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    await waitFor(() => expect(detailTrigger).toHaveFocus());
    expect(screen.getByTestId("location")).not.toHaveTextContent("selected_request");
  });

  it.each(["[값 비공개]", "[값 생략]"])(
    "uses distinct opaque refs when projected request IDs share %s",
    async (projectedRequestID) => {
      const firstPrivateRef = `req_${"c".repeat(22)}.${"c".repeat(21)}`;
      const secondPrivateRef = `req_${"d".repeat(22)}.${"d".repeat(21)}`;
      const firstPrivate = {
        ...firstRow,
        request_id: projectedRequestID,
        request_ref: firstPrivateRef,
        request_filterable: false,
        model: "비공개 요청 모델 1",
      };
      const secondPrivate = {
        ...secondRow,
        request_id: projectedRequestID,
        request_ref: secondPrivateRef,
        request_filterable: false,
        model: "비공개 요청 모델 2",
      };
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(apiClient, "request").mockResolvedValue({
        ...response,
        requests: [secondPrivate, firstPrivate],
      } as never);
      const user = userEvent.setup();
      const view = renderPage();

      const timeline = (await screen.findByRole("heading", { name: "요청 처리 흐름" })).closest("section");
      expect(timeline).not.toBeNull();
      const triggers = within(timeline as HTMLElement).getAllByRole("button", {
        name: /^\d+번째 요청 \[(?:값 비공개|값 생략)\] 흐름 선택$/u,
      });
      expect(triggers).toHaveLength(2);

      await user.click(triggers[0] as HTMLButtonElement);
      expect(screen.getByTestId("location")).toHaveTextContent(`selected_ref=${firstPrivateRef}`);
      expect(screen.getByTestId("location")).not.toHaveTextContent("selected_request");
      let detail = screen.getByRole("region", { name: `1번째 요청 ${projectedRequestID}` });
      expect(within(detail).getByText("비공개 요청 모델 1")).toBeVisible();
      expect(
        screen.getByText(`1번째 요청 ${projectedRequestID} 상세가 열렸습니다.`, { exact: true }),
      ).toBeInTheDocument();
      expect(triggers[0]).toHaveAttribute("aria-pressed", "true");
      expect(triggers[1]).toHaveAttribute("aria-pressed", "false");
      expect(
        new URL(
          within(detail).getByRole("link", { name: "요청 탐색기에서 열기" }).getAttribute("href") ?? "",
          "https://app.example.invalid",
        ).searchParams.has("request_id"),
      ).toBe(false);

      await user.click(triggers[1] as HTMLButtonElement);
      expect(screen.getByTestId("location")).toHaveTextContent(`selected_ref=${secondPrivateRef}`);
      detail = screen.getByRole("region", { name: `2번째 요청 ${projectedRequestID}` });
      expect(within(detail).getByText("비공개 요청 모델 2")).toBeVisible();
      expect(
        screen.getByText(`2번째 요청 ${projectedRequestID} 상세가 열렸습니다.`, { exact: true }),
      ).toBeInTheDocument();
      expect(triggers[0]).toHaveAttribute("aria-pressed", "false");
      expect(triggers[1]).toHaveAttribute("aria-pressed", "true");
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
      consoleError.mockRestore();
      view.unmount();
    },
  );

  it.each(["[값 비공개]", "[값 생략]"])(
    "does not resolve projected request ID %s as a selectable deep link",
    async (projectedRequestID) => {
      vi.spyOn(apiClient, "request").mockResolvedValue({
        ...response,
        requests: [
          { ...firstRow, request_id: projectedRequestID, request_filterable: false },
          { ...secondRow, request_id: projectedRequestID, request_filterable: false },
        ],
      } as never);
      renderPage(`/observability/traces?selected_request=${encodeURIComponent(projectedRequestID)}`);

      expect(
        await screen.findByText("선택한 요청이 현재 페이지에 없습니다.", {
          selector: "strong",
        }),
      ).toBeVisible();
      for (const trigger of screen.getAllByRole("button", {
        name: /^\d+번째 요청 \[(?:값 비공개|값 생략)\] 흐름 선택$/u,
      })) {
        expect(trigger).toHaveAttribute("aria-pressed", "false");
      }
    },
  );

  it("v1 호환 응답은 배포 경고를 표시하고 요청 선택을 비활성화한다", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      request_contract_version: 1,
      requests: response.requests.map((request) => ({
        ...request,
        request_filterable: false,
        trace_filterable: false,
      })),
    } as never);
    renderPage("/observability/traces?selected_request=req-001");

    expect(await screen.findByText("서버 배포 버전을 맞추는 중입니다.")).toBeVisible();
    expect(screen.getByText(/v0\.83\.0 이상이 된 뒤 제공됩니다/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "1번째 요청 req-001 흐름 선택" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" })).toBeDisabled();

    const unavailable = screen
      .getByText("서버 업그레이드 중에는 요청 상세를 열 수 없습니다.", { selector: "strong" })
      .closest("section");
    expect(unavailable).toHaveFocus();
    expect(screen.queryByRole("region", { name: /요청 req-001/u })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "요청 탐색기" })).not.toHaveAttribute(
      "href",
      expect.stringContaining("request_id="),
    );
  });

  it("keeps opaque-reference and raw-ID selections in disjoint URL namespaces", async () => {
    const referenceOwner = {
      ...firstRow,
      request_id: "[값 비공개]",
      request_ref: firstRequestRef,
      request_filterable: false,
      model: "참조 소유 요청",
    };
    const rawIdOwner = {
      ...secondRow,
      request_id: firstRequestRef,
      request_ref: secondRequestRef,
      request_filterable: true,
      model: "원시 ID 소유 요청",
    };
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      requests: [rawIdOwner, referenceOwner],
    } as never);

    const byReference = renderPage(
      `/observability/traces?selected_ref=${encodeURIComponent(firstRequestRef)}`,
    );
    let detail = await screen.findByRole("region", { name: "1번째 요청 [값 비공개]" });
    expect(within(detail).getByText("참조 소유 요청")).toBeVisible();
    expect(within(detail).queryByText("원시 ID 소유 요청")).not.toBeInTheDocument();
    byReference.unmount();

    renderPage(`/observability/traces?selected_request=${encodeURIComponent(firstRequestRef)}`);
    detail = await screen.findByRole("region", { name: `2번째 요청 ${firstRequestRef}` });
    expect(within(detail).getByText("원시 ID 소유 요청")).toBeVisible();
    expect(within(detail).queryByText("참조 소유 요청")).not.toBeInTheDocument();
  });

  it("restores the selection trigger when browser history closes request details", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const trigger = screen.getByRole("button", { name: "1번째 요청 req-001 흐름 선택" });
    await user.click(trigger);
    expect(screen.getByRole("region", { name: "1번째 요청 req-001" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "테스트 기록 뒤로" }));
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("selected_request"));
    expect(trigger).toHaveFocus();
  });

  it("restores focus to the matching request after browser history changes the selection", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const firstTrigger = screen.getByRole("button", { name: "1번째 요청 req-001 흐름 선택" });
    const secondTrigger = screen.getByRole("button", { name: "2번째 요청 req-002 흐름 선택" });
    await user.click(firstTrigger);
    await user.click(secondTrigger);
    expect(screen.getByRole("region", { name: "2번째 요청 req-002" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "테스트 기록 뒤로" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("selected_request=req-001"));
    expect(screen.getByRole("region", { name: "1번째 요청 req-001" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    await waitFor(() => expect(firstTrigger).toHaveFocus());
    expect(secondTrigger).not.toHaveFocus();
  });

  it("restores URL filters, selects a safe request detail and pages without retaining the selection", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      requests: [{ ...secondRow, prompt: "원문-비밀", response: "응답-비밀", error: "오류-비밀" }],
    } as never);
    const user = userEvent.setup();
    renderPage(
      "/observability/traces?trace_id=trace-001&status=5xx&model=gpt-test&tz=UTC&selected_request=req-002",
    );

    expect(await screen.findByRole("heading", { name: "요청 req-002" })).toBeVisible();
    expect(screen.getByLabelText("추적 ID")).toHaveValue("trace-001");
    expect(screen.getByLabelText("상태")).toHaveValue("5xx");
    expect(screen.getByLabelText("모델")).toHaveValue("gpt-test");
    expect(screen.queryByText("원문-비밀")).not.toBeInTheDocument();
    expect(screen.queryByText("응답-비밀")).not.toBeInTheDocument();
    expect(screen.queryByText("오류-비밀")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "요청 탐색기에서 열기" })).toHaveAttribute(
      "href",
      expect.stringContaining("request_id=req-002"),
    );
    await waitFor(() => {
      const options = request.mock.calls[0]?.[1] as { query?: Record<string, unknown> };
      expect(options.query).toMatchObject({
        trace_id: "trace-001",
        status: "5xx",
        model: "gpt-test",
        tz: "UTC",
      });
    });

    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getByTestId("location")).toHaveTextContent(`cursor=${nextCursor}`);
    expect(screen.getByTestId("location")).not.toHaveTextContent("selected_request");
    await waitFor(() => expect(screen.getByRole("heading", { name: "추적 조회 결과" })).toHaveFocus());
  });

  it("페이지 이동이 최종 실패하면 오류 제목으로 포커스를 옮긴다", async () => {
    vi.spyOn(apiClient, "request")
      .mockResolvedValueOnce(response as never)
      .mockRejectedValueOnce(
        new AppError("페이지 이동 실패", {
          kind: "http",
          requestId: "gateway-trace-page-error",
        }),
      );
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다음" }));

    const errorHeading = await screen.findByRole("heading", {
      name: "추적 요청 흐름을 불러오지 못했습니다.",
    });
    await waitFor(() => expect(errorHeading).toHaveFocus());
    expect(screen.getByText("요청 ID: gateway-trace-page-error")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "테스트 기록 뒤로" }));
    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("heading", { name: "추적 조회 결과" })).toHaveFocus());
  });

  it("상세가 열린 페이지 이동 중에는 제목을 건너뛰고 완료된 결과로 포커스를 옮긴다", async () => {
    let resolveNextPage: ((value: AppRequestsResponse) => void) | undefined;
    vi.spyOn(apiClient, "request")
      .mockResolvedValueOnce(response as never)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNextPage = resolve as (value: AppRequestsResponse) => void;
          }) as never,
      );
    const user = userEvent.setup();
    renderPage();

    const detailTrigger = await screen.findByRole("button", {
      name: "1번째 요청 req-001 흐름 선택",
    });
    await user.click(detailTrigger);
    expect(screen.getByRole("region", { name: "1번째 요청 req-001" })).toHaveFocus();
    const pageHeading = screen.getByRole("heading", { name: "추적 탐색기" });
    const pageHeadingFocus = vi.spyOn(pageHeading, "focus");

    await user.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`cursor=${nextCursor}`));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "1번째 요청 req-001" })).not.toBeInTheDocument(),
    );
    expect(pageHeadingFocus).not.toHaveBeenCalled();
    expect(pageHeading).not.toHaveFocus();

    expect(resolveNextPage).toBeDefined();
    await act(async () => {
      resolveNextPage?.({
        ...response,
        requests: [
          {
            ...firstRow,
            request_id: "req-page-2",
            request_ref: `req_${"z".repeat(22)}.${"z".repeat(21)}`,
          },
        ],
        previous_cursor: nextCursor,
        next_cursor: undefined,
      });
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: "추적 조회 결과" })).toHaveFocus());
    expect(pageHeadingFocus).not.toHaveBeenCalled();
  });

  it("represents exact status, custom limit and RFC3339 bounds without changing them on submit", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      limit: 75,
      requests: [secondRow],
    } as never);
    const user = userEvent.setup();
    renderPage(
      "/observability/traces?trace_id=trace-001&status=503&model=gpt-test&limit=75&from=2026-09-04T01%3A00%3A00Z&to=2026-09-04T02%3A00%3A00%2B00%3A00&tz=UTC",
    );

    expect(await screen.findByRole("heading", { name: "추적 탐색기" })).toBeVisible();
    expect(screen.getByLabelText("상태")).toHaveValue("503");
    expect(screen.getByLabelText("표시 건수")).toHaveValue("75");
    expect(screen.getByLabelText("시작 시각")).toHaveValue("2026-09-04T01:00:00Z");
    expect(screen.getByLabelText("종료 시각")).toHaveValue("2026-09-04T02:00:00+00:00");

    const requestExplorer = screen.getByRole("link", { name: "요청 탐색기" });
    expect(requestExplorer).toHaveAttribute(
      "href",
      "/observability/requests?from=2026-09-04T01%3A00%3A00Z&to=2026-09-04T02%3A00%3A00%2B00%3A00&status=503&model=gpt-test&trace_id=trace-001&limit=75&tz=UTC",
    );

    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    expect(screen.getByTestId("location")).toHaveTextContent("status=503");
    expect(screen.getByTestId("location")).toHaveTextContent("limit=75");
    expect(screen.getByTestId("location")).toHaveTextContent("from=2026-09-04T01%3A00%3A00Z");
    expect(screen.getByTestId("location")).toHaveTextContent("to=2026-09-04T02%3A00%3A00%2B00%3A00");
    await waitFor(() => {
      const options = request.mock.calls[0]?.[1] as { query?: Record<string, unknown> };
      expect(options.query).toMatchObject({
        from: "2026-09-04T01:00:00Z",
        limit: 75,
        status: "503",
        to: "2026-09-04T02:00:00+00:00",
      });
    });
  });

  it("keeps unsubmitted filter input when opening and closing request details", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const modelFilter = screen.getByLabelText("모델");
    await user.type(modelFilter, "작성 중인 모델");
    await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));

    expect(screen.getByLabelText("모델")).toHaveValue("작성 중인 모델");
    await user.click(screen.getByRole("button", { name: "요청 상세 닫기" }));
    expect(screen.getByLabelText("모델")).toHaveValue("작성 중인 모델");
  });

  it("restores omitted defaults and clears an unsubmitted draft on browser history navigation", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("limit=50"));
    expect(screen.getByTestId("location")).toHaveTextContent("tz=Asia%2FSeoul");

    await user.type(screen.getByLabelText("모델"), "저장하지 않은 초안");
    await user.click(screen.getByRole("button", { name: "테스트 기록 뒤로" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/observability/traces"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("limit=");
    expect(screen.getByLabelText("모델")).toHaveValue("");
  });

  it("blocks an overlong UTF-8 trace ID and focuses its inline error", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const traceID = screen.getByLabelText("추적 ID");
    fireEvent.change(traceID, { target: { value: "한".repeat(171) } });
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));

    expect(screen.getByRole("alert")).toHaveTextContent("UTF-8 기준 512바이트 이하여야 합니다.");
    expect(traceID).toHaveAttribute("aria-invalid", "true");
    expect(traceID).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location")).not.toHaveTextContent("trace_id=");
  });

  it("blocks an overlong UTF-8 model and focuses its inline error", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const model = screen.getByLabelText("모델");
    fireEvent.change(model, { target: { value: "한".repeat(86) } });
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));

    expect(screen.getByRole("alert")).toHaveTextContent("UTF-8 기준 256바이트 이하여야 합니다.");
    expect(model).toHaveAttribute("aria-invalid", "true");
    expect(model).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location")).not.toHaveTextContent("model=");

    fireEvent.input(model, { target: { value: "한글-모델" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a configured credential out of the trace query and browser URL", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const model = screen.getByLabelText("모델");
    await user.type(model, `corp_${"A".repeat(43)}`);
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));

    expect(model).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("비밀정보를 제거한 뒤 검색하세요.");
    expect(screen.getByTestId("location")).not.toHaveTextContent("corp_");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates trace date-time and timezone filters before querying", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const from = screen.getByLabelText("시작 시각");
    await user.type(from, "2026-09-04T25:00");
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    expect(from).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("날짜와 시각");
    expect(request).toHaveBeenCalledTimes(1);

    await user.clear(from);
    const timeZone = screen.getByLabelText("시간대");
    await user.clear(timeZone);
    await user.type(timeZone, "Not/AZone");
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    expect(timeZone).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("IANA 시간대");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("clears an invalid draft and its accessibility state when empty filters are reset", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const model = screen.getByLabelText("모델");
    fireEvent.change(model, { target: { value: "한".repeat(86) } });
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    expect(model).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("UTF-8 기준 256바이트 이하여야 합니다.");

    await user.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(model).toHaveValue("");
    expect(model).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/observability/traces");
  });

  it("clears stale validation errors when browser history restores valid filters", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage("/observability/traces?model=%EC%B2%AB-%EB%AA%A8%EB%8D%B8");

    expect(await screen.findByRole("heading", { name: "요청 처리 흐름" })).toBeVisible();
    const model = screen.getByLabelText("모델");
    fireEvent.change(model, { target: { value: "둘째-모델" } });
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("model=%EB%91%98%EC%A7%B8-%EB%AA%A8%EB%8D%B8"),
    );

    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "한".repeat(86) } });
    await user.click(screen.getByRole("button", { name: "흐름 조회" }));
    expect(screen.getByRole("alert")).toHaveTextContent("UTF-8 기준 256바이트 이하여야 합니다.");

    await user.click(screen.getByRole("button", { name: "테스트 기록 뒤로" }));
    await waitFor(() => expect(screen.getByLabelText("모델")).toHaveValue("첫-모델"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("모델")).not.toHaveAttribute("aria-invalid");

    await user.click(screen.getByRole("button", { name: "테스트 기록 앞으로" }));
    await waitFor(() => expect(screen.getByLabelText("모델")).toHaveValue("둘째-모델"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("모델")).not.toHaveAttribute("aria-invalid");
  });

  it("uses a muted status badge for an unknown HTTP status", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      requests: [
        {
          ...firstRow,
          request_id: "req-unknown-zero",
          request_ref: `req_${"e".repeat(22)}.${"e".repeat(21)}`,
          status_code: 0,
        },
        {
          ...firstRow,
          request_id: "req-unknown-high",
          request_ref: `req_${"f".repeat(22)}.${"f".repeat(21)}`,
          status_code: 600,
        },
      ],
    } as never);
    renderPage();

    const zeroTimelineTrigger = await screen.findByRole("button", {
      name: "1번째 요청 req-unknown-zero 흐름 선택",
    });
    const highTimelineTrigger = screen.getByRole("button", {
      name: "2번째 요청 req-unknown-high 흐름 선택",
    });
    expect(within(zeroTimelineTrigger).getByText("HTTP 0")).toHaveClass("badge-muted");
    expect(within(highTimelineTrigger).getByText("HTTP 600")).toHaveClass("badge-muted");
    const summary = screen.getByRole("region", { name: "추적 요청 요약" });
    expect(
      within(within(summary).getByText("오류 요청").parentElement as HTMLElement).getByText("0건"),
    ).toBeVisible();
  });

  it("uses the runtime migration registry as the Legacy link source", async () => {
    authRuntime.legacyPath = "/admin#/runtime-traces";
    vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    renderPage();

    expect(await screen.findByRole("link", { name: "기존 화면 보기" })).toHaveAttribute(
      "href",
      "/admin#/runtime-traces",
    );
  });

  it("uses the runtime Legacy path from a terminal error state", async () => {
    authRuntime.legacyPath = "/admin#/runtime-traces";
    vi.spyOn(apiClient, "request").mockRejectedValueOnce(
      new AppError("서버 상세 오류", { kind: "http", requestId: "gateway-request-runtime" }),
    );
    renderPage();

    expect(await screen.findByRole("link", { name: "기존 관리자 화면 열기" })).toHaveAttribute(
      "href",
      "/admin#/runtime-traces",
    );
  });

  it("keeps a missing deep-linked selection actionable and focused when the result is empty", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      requests: [],
      next_cursor: undefined,
      previous_cursor: undefined,
    } as never);
    const user = userEvent.setup();
    renderPage("/observability/traces?selected_request=req-missing");

    const missingSelection = await screen.findByText("선택한 요청이 현재 페이지에 없습니다.", {
      selector: "strong",
    });
    expect(missingSelection.closest("section")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "선택 해제" }));
    expect(screen.getByTestId("location")).not.toHaveTextContent("selected_request");
    await waitFor(() => expect(screen.getByRole("heading", { name: "추적 탐색기" })).toHaveFocus());
  });

  it("keeps the last good timeline visible and exposes a retry when refresh fails", async () => {
    const request = vi
      .spyOn(apiClient, "request")
      .mockResolvedValueOnce(response as never)
      .mockRejectedValueOnce(
        new AppError("원시 오류를 표시하면 안 됩니다.", {
          kind: "http",
          requestId: "gateway-request-1",
        }),
      );
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("button", { name: "1번째 요청 req-001 흐름 선택" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByText("갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeVisible();
    expect(screen.getByText("요청 ID: gateway-request-1")).toBeVisible();
    expect(screen.queryByText("원시 오류를 표시하면 안 됩니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1번째 요청 req-001 흐름 선택" })).toBeVisible();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("distinguishes loading, empty and terminal error states and honors Legacy permissions", async () => {
    let resolvePending: ((value: AppRequestsResponse) => void) | undefined;
    vi.spyOn(apiClient, "request").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve as (value: AppRequestsResponse) => void;
        }) as never,
    );
    const loading = renderPage("/observability/traces?trace_id=missing");
    expect(screen.getByText("추적 요청 흐름을 불러오는 중입니다.")).toBeInTheDocument();
    resolvePending?.({ ...response, requests: [], next_cursor: undefined, previous_cursor: undefined });
    expect(await screen.findByRole("heading", { name: "일치하는 추적 요청이 없습니다." })).toBeVisible();
    loading.unmount();

    authRuntime.scopes = ["observability:read"];
    vi.spyOn(apiClient, "request").mockRejectedValueOnce(
      new AppError("서버 상세 오류", {
        kind: "http",
        requestId: "gateway-request-2",
      }),
    );
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "추적 요청 흐름을 불러오지 못했습니다." }),
    ).toBeVisible();
    expect(screen.getByText("요청 ID: gateway-request-2")).toBeVisible();
    expect(screen.queryByText("서버 상세 오류")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "기존 관리자 화면 열기" })).not.toBeInTheDocument();
  });
});
