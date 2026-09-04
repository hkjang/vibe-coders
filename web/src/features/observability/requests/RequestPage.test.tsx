import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { RequestPage } from "@/features/observability/requests/RequestPage";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import type { AppRequestsResponse } from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({
  credentialPrefixes: ["corp_"],
  featureFallback: true,
  legacyFallback: true,
  legacyPath: "/admin#/requests" as `/admin${string}`,
  scopes: ["admin:read"] as string[],
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    credentialPrefixes: authRuntime.credentialPrefixes,
    features: [
      {
        appPath: "/app/observability/requests",
        fallbackEnabled: authRuntime.featureFallback,
        featureId: "observability.requests",
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
const requestRef = `req_${"a".repeat(22)}.${"a".repeat(21)}`;
const nextCursor = `djE6dGVzdA.${"n".repeat(43)}`;
const row = {
  request_id: "req-001",
  request_ref: requestRef,
  request_filterable: true,
  trace_id: "trace-001",
  trace_filterable: true,
  session_id: "session-001",
  api_key_id: "key-001",
  ip: "192.0.2.10",
  method: "POST",
  model: "gpt-test",
  provider_ref: providerRef,
  provider_display: "Provider 1",
  endpoint: "/v1/chat/completions",
  stream: true,
  status_code: 200,
  latency_ms: 123,
  first_chunk_ms: 40,
  prompt_tokens: 3,
  completion_tokens: 4,
  total_tokens: 7,
  cached_tokens: 1,
  reasoning_tokens: 0,
  estimated_cost: 1.25,
  currency: "KRW",
  finish_reason: "stop",
  created_at: "2026-09-03T01:02:03Z",
} as const;

const response = {
  request_contract_version: 2,
  requests: [row],
  limit: 50,
  next_cursor: nextCursor,
  generated_at: "2026-09-03T01:03:00Z",
} satisfies AppRequestsResponse;

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(initialEntry = "/observability/requests") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/observability/requests"
            element={
              <>
                <RequestPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RequestPage", () => {
  beforeEach(() => {
    authRuntime.featureFallback = true;
    authRuntime.legacyFallback = true;
    authRuntime.legacyPath = "/admin#/requests";
    authRuntime.scopes = ["admin:read"];
    usePreferences.setState({ refreshInterval: 0 });
  });

  it("restores URL filters, pages by cursor, opens safe detail and restores focus", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    const view = renderPage(
      `/observability/requests?model=gpt-test&status=success&provider_ref=${providerRef}`,
    );

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    expect(screen.getByLabelText("모델")).toHaveValue("gpt-test");
    expect(screen.getByLabelText("상태")).toHaveValue("success");
    await waitFor(() => {
      const options = request.mock.calls[0]?.[1] as {
        headers?: Record<string, string>;
        query?: Record<string, unknown>;
      };
      expect(options.headers).toEqual({ "X-Vibe-App-Requests-Version": "2" });
      expect(options.query).toMatchObject({
        model: "gpt-test",
        status: "success",
        provider_ref: providerRef,
      });
    });

    await user.click(screen.getByText("req-001"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const detail = screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" });
    await user.click(detail);
    expect(screen.getByRole("dialog")).toHaveTextContent("프롬프트, 응답 본문, 원시 오류");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("raw-secret");
    expect(screen.getByRole("link", { name: "기존 요청 화면 열기" })).toHaveAttribute(
      "href",
      "/admin#/requests",
    );
    expect(screen.getByRole("link", { name: "이 요청의 추적 보기" })).toHaveAttribute(
      "href",
      "/observability/traces?trace_id=trace-001&selected_request=req-001",
    );
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(detail).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getByTestId("location")).toHaveTextContent(`cursor=${nextCursor}`);
    await waitFor(() => expect(screen.getByRole("heading", { name: "요청 조회 결과" })).toHaveFocus());
    const results = await axe.run(view.container);
    expect(results.violations).toHaveLength(0);
  });

  it("페이지 이동이 최종 실패하면 오류 제목으로 포커스를 옮긴다", async () => {
    let rejectRetry: ((reason?: unknown) => void) | undefined;
    vi.spyOn(apiClient, "request")
      .mockResolvedValueOnce(response as never)
      .mockRejectedValueOnce(
        new AppError("페이지 이동 실패", { kind: "http", requestId: "gateway-page-error" }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRetry = reject;
          }) as never,
      )
      .mockResolvedValueOnce(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다음" }));

    const errorHeading = await screen.findByRole("heading", {
      name: "화면을 불러오지 못했습니다.",
    });
    await waitFor(() => expect(errorHeading).toHaveFocus());
    expect(screen.getByText("요청 ID: gateway-page-error")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(rejectRetry).toBeDefined();
    await act(async () => {
      rejectRetry?.(
        new AppError("페이지 재시도 실패", {
          kind: "http",
          requestId: "gateway-page-retry-error",
        }),
      );
    });
    expect(await screen.findByText("요청 ID: gateway-page-retry-error")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 시도" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("req-001")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("heading", { name: "요청 조회 결과" })).toHaveFocus());
  });

  it("keeps the last good page visible when refresh fails", async () => {
    const request = vi
      .spyOn(apiClient, "request")
      .mockResolvedValueOnce(response as never)
      .mockRejectedValueOnce(new AppError("갱신 실패", { kind: "http", requestId: "gateway-request-1" }));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("req-001")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /새로고침/u }));
    expect(await screen.findByText("갱신에 실패해 마지막 정상 데이터를 표시합니다.")).toBeInTheDocument();
    expect(screen.getByText("req-001")).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("validates the IP filter inline and never sends an invalid deep link value", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage("/observability/requests?ip=not-an-ip");

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "클라이언트 IP" });
    expect(input).toHaveValue("not-an-ip");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("올바른 IP 주소를 입력하세요.")).toHaveAttribute("role", "alert");
    expect((request.mock.calls[0]?.[1] as { query?: Record<string, unknown> }).query).not.toHaveProperty(
      "ip",
    );

    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(input).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(1);

    await user.clear(input);
    await user.type(input, "::ffff:192.0.2.10");
    expect(input).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(screen.getByTestId("location")).toHaveTextContent("ip=%3A%3Affff%3A192.0.2.10");
    await waitFor(() => {
      const latest = request.mock.calls.at(-1)?.[1] as { query?: Record<string, unknown> };
      expect(latest.query?.ip).toBe("::ffff:192.0.2.10");
    });
  });

  it("keeps a configured credential out of the API query and browser URL", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    const model = screen.getByRole("textbox", { name: "모델" });
    await user.type(model, `corp_${"A".repeat(43)}`);
    await user.click(screen.getByRole("button", { name: "조회" }));

    expect(model).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("비밀정보를 제거한 뒤 검색하세요.");
    expect(screen.getByTestId("location")).not.toHaveTextContent("corp_");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates request date-time and timezone filters before querying", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    const from = screen.getByRole("textbox", { name: "시작 시각" });
    await user.type(from, "2026-09-04T25:00");
    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(from).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("날짜와 시각");
    expect(request).toHaveBeenCalledTimes(1);

    await user.clear(from);
    const timeZone = screen.getByRole("textbox", { name: "시간대" });
    await user.clear(timeZone);
    await user.type(timeZone, "Not/AZone");
    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(timeZone).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("IANA 시간대");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates bounded text and provider reference filters before querying", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    const model = screen.getByRole("textbox", { name: "모델" });
    fireEvent.change(model, { target: { value: "한".repeat(86) } });
    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(model).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("UTF-8 기준 256바이트");
    expect(request).toHaveBeenCalledTimes(1);

    fireEvent.change(model, { target: { value: "" } });
    const provider = screen.getByRole("textbox", { name: "공급자 참조" });
    await user.type(provider, "typo");
    await user.click(screen.getByRole("button", { name: "조회" }));
    expect(provider).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("공급자 참조 형식");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never sends oversized free-text or cursor values restored from a deep link", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    renderPage(
      `/observability/requests?model=${encodeURIComponent("한".repeat(86))}&language=${encodeURIComponent("한".repeat(22))}&cursor=${"a".repeat(4_097)}`,
    );

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    await waitFor(() => {
      const options = request.mock.calls[0]?.[1] as { query?: Record<string, unknown> };
      expect(options.query).not.toHaveProperty("model");
      expect(options.query).not.toHaveProperty("language");
      expect(options.query).not.toHaveProperty("cursor");
    });
  });

  it("renders list and detail times in the timezone selected by the filter", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    const utcPage = renderPage("/observability/requests?tz=UTC");

    const utcListExpected = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(row.created_at));
    const utcDetailExpected = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(row.created_at));
    const utcGeneratedExpected = new Intl.DateTimeFormat("ko-KR", {
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(response.generated_at));

    expect(await screen.findByTestId("request-created-at-req-001")).toHaveTextContent(utcListExpected);
    expect(screen.getByTestId("requests-generated-at")).toHaveTextContent(utcGeneratedExpected);
    await waitFor(() => {
      const options = request.mock.calls[0]?.[1] as { query?: Record<string, unknown> };
      expect(options.query?.tz).toBe("UTC");
    });
    await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
    expect(screen.getByTestId("request-detail-created-at")).toHaveTextContent(utcDetailExpected);
    utcPage.unmount();

    renderPage("/observability/requests?tz=Asia%2FSeoul");
    const seoulListExpected = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "Asia/Seoul",
    }).format(new Date(row.created_at));
    const seoulDetailExpected = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "Asia/Seoul",
    }).format(new Date(row.created_at));
    const seoulGeneratedExpected = new Intl.DateTimeFormat("ko-KR", {
      timeStyle: "medium",
      timeZone: "Asia/Seoul",
    }).format(new Date(response.generated_at));

    expect(await screen.findByTestId("request-created-at-req-001")).toHaveTextContent(seoulListExpected);
    expect(screen.getByTestId("requests-generated-at")).toHaveTextContent(seoulGeneratedExpected);
    await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
    expect(screen.getByTestId("request-detail-created-at")).toHaveTextContent(seoulDetailExpected);
  });

  it.each([
    [0, "muted"],
    [100, "muted"],
    [200, "success"],
    [399, "success"],
    [400, "warning"],
    [500, "danger"],
    [599, "danger"],
    [600, "muted"],
  ] as const)("renders HTTP status %i with the %s tone", async (status, tone) => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      requests: [{ ...row, status_code: status }],
    } as never);
    renderPage();

    const badge = await screen.findByText(String(status), { selector: ".badge" });
    expect(badge).toHaveClass(`badge-${tone}`);
  });

  it.each(["", "[값 비공개]", "[값 생략]"])(
    "does not offer a broken Trace handoff when trace ID %j is not filterable",
    async (traceID) => {
      vi.spyOn(apiClient, "request").mockResolvedValue({
        ...response,
        requests: [{ ...row, trace_id: traceID, trace_filterable: false }],
      } as never);
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
      expect(screen.queryByRole("link", { name: "이 요청의 추적 보기" })).not.toBeInTheDocument();
    },
  );

  it("hands off a projected request through its opaque selection reference", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      requests: [{ ...row, request_id: "[값 비공개]", request_filterable: false }],
    } as never);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "1번째 요청 [값 비공개] 상세 보기" }));
    expect(screen.getByRole("link", { name: "이 요청의 추적 보기" })).toHaveAttribute(
      "href",
      `/observability/traces?trace_id=trace-001&selected_ref=${requestRef}`,
    );
  });

  it("같은 비공개 ID로 투영된 요청도 순서별 접근성 이름과 상세를 구분한다", async () => {
    const secondRequestRef = `req_${"b".repeat(22)}.${"b".repeat(21)}`;
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      requests: [
        {
          ...row,
          request_id: "[값 비공개]",
          request_filterable: false,
          model: "비공개 요청 모델 1",
        },
        {
          ...row,
          request_id: "[값 비공개]",
          request_ref: secondRequestRef,
          request_filterable: false,
          trace_id: "trace-002",
          model: "비공개 요청 모델 2",
        },
      ],
    } as never);
    const user = userEvent.setup();
    renderPage();

    const firstDetail = await screen.findByRole("button", {
      name: "1번째 요청 [값 비공개] 상세 보기",
    });
    const secondDetail = screen.getByRole("button", {
      name: "2번째 요청 [값 비공개] 상세 보기",
    });
    expect(firstDetail).toBeVisible();
    expect(secondDetail).toBeVisible();

    await user.click(secondDetail);
    const dialog = screen.getByRole("dialog", { name: "2번째 요청 [값 비공개]" });
    expect(dialog).toHaveTextContent("비공개 요청 모델 2");
    expect(dialog).not.toHaveTextContent("비공개 요청 모델 1");

    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(secondDetail).toHaveFocus());
  });

  it("v1 호환 응답은 배포 경고를 표시하고 로컬 상세만 제공한다", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...response,
      request_contract_version: 1,
      requests: [
        {
          ...row,
          request_ref: `req_${"0".repeat(22)}.${"0".repeat(21)}`,
          request_filterable: false,
          trace_filterable: false,
        },
      ],
    } as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("서버 배포 버전을 맞추는 중입니다.")).toBeVisible();
    expect(screen.getByText(/v0\.83\.0 이상이 된 뒤 제공됩니다/u)).toBeVisible();
    const detailTrigger = screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" });
    expect(detailTrigger).toBeEnabled();

    await user.click(detailTrigger);
    expect(screen.getByRole("dialog", { name: "1번째 요청 req-001" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "이 요청의 추적 보기" })).not.toBeInTheDocument();
  });

  it("열린 v2 상세는 v1 호환 응답으로 전환되면 즉시 닫고 추적 연결을 제거한다", async () => {
    vi.spyOn(apiClient, "request")
      .mockResolvedValueOnce(response as never)
      .mockResolvedValueOnce({
        ...response,
        request_contract_version: 1,
        requests: [
          {
            ...row,
            request_ref: `req_${"0".repeat(22)}.${"0".repeat(21)}`,
            request_filterable: false,
            trace_filterable: false,
          },
        ],
      } as never)
      .mockResolvedValueOnce(response as never);
    const user = userEvent.setup();
    renderPage();

    const refresh = await screen.findByRole("button", { name: "새로고침" });
    await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
    expect(screen.getByRole("link", { name: "이 요청의 추적 보기" })).toBeVisible();

    fireEvent.click(refresh);
    expect(await screen.findByText("서버 배포 버전을 맞추는 중입니다.")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "이 요청의 추적 보기" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() =>
      expect(screen.queryByText("서버 배포 버전을 맞추는 중입니다.")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("v1 상세는 새 응답의 같은 순번 행으로 바뀌지 않고 닫힌다", async () => {
    const v1RequestRef = `req_${"0".repeat(22)}.${"0".repeat(21)}`;
    vi.spyOn(apiClient, "request")
      .mockResolvedValueOnce({
        ...response,
        request_contract_version: 1,
        requests: [
          {
            ...row,
            request_ref: v1RequestRef,
            request_filterable: false,
            trace_filterable: false,
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        ...response,
        request_contract_version: 1,
        requests: [
          {
            ...row,
            request_id: "req-new",
            request_ref: v1RequestRef,
            request_filterable: false,
            trace_filterable: false,
          },
        ],
      } as never);
    const user = userEvent.setup();
    renderPage();

    const refresh = await screen.findByRole("button", { name: "새로고침" });
    await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
    expect(screen.getByRole("dialog", { name: "1번째 요청 req-001" })).toBeVisible();

    fireEvent.click(refresh);
    expect(await screen.findByText("req-new")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "1번째 요청 req-new" })).not.toBeInTheDocument();
  });

  it.each([
    ["100", "1"],
    ["503", "75"],
    ["599", "200"],
  ])(
    "preserves exact HTTP status %s, limit %s and RFC3339 bounds from a Trace handoff",
    async (status, limit) => {
      const request = vi.spyOn(apiClient, "request").mockResolvedValue({
        ...response,
        limit: Number(limit),
      } as never);
      const user = userEvent.setup();
      const from = "2026-09-04T01:00:00Z";
      const to = "2026-09-04T02:00:00+00:00";
      renderPage(
        `/observability/requests?${new URLSearchParams({
          from,
          to,
          status,
          limit,
          trace_id: "Trace-Mixed_Case:001",
          tz: "UTC",
        }).toString()}`,
      );

      expect(await screen.findByLabelText("상태")).toHaveValue(status);
      expect(screen.getByLabelText("표시 건수")).toHaveValue(limit);
      expect(screen.getByLabelText("시작 시각")).toHaveValue(from);
      expect(screen.getByLabelText("종료 시각")).toHaveValue(to);
      await waitFor(() => {
        const options = request.mock.calls[0]?.[1] as { query?: Record<string, unknown> };
        expect(options.query).toMatchObject({
          from,
          to,
          status,
          limit: Number(limit),
          trace_id: "Trace-Mixed_Case:001",
          tz: "UTC",
        });
      });

      await user.click(screen.getByRole("button", { name: "조회" }));
      const location = new URL(
        screen.getByTestId("location").textContent ?? "",
        "https://app.example.invalid",
      );
      expect(location.searchParams.get("status")).toBe(status);
      expect(location.searchParams.get("limit")).toBe(limit);
      expect(location.searchParams.get("from")).toBe(from);
      expect(location.searchParams.get("to")).toBe(to);
    },
  );

  it("hides every existing-screen bridge when fallback is disabled or permission is missing", async () => {
    authRuntime.legacyFallback = false;
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    const page = renderPage();

    expect(await screen.findByText("req-001")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "기존 화면 보기" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
    expect(screen.queryByRole("link", { name: "기존 요청 화면 열기" })).not.toBeInTheDocument();
    page.unmount();

    authRuntime.legacyFallback = true;
    authRuntime.scopes = ["requests:read"];
    request.mockRejectedValueOnce(
      new AppError("목록 실패", { kind: "http", requestId: "gateway-request-no-legacy" }),
    );
    renderPage();
    expect(await screen.findByText("요청 목록을 확인할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("목록 실패")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "기존 관리자 화면 열기" })).not.toBeInTheDocument();
  });

  it("uses the runtime request Legacy path and honors its feature fallback toggle", async () => {
    authRuntime.legacyPath = "/admin#/runtime-requests";
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
    const user = userEvent.setup();
    const page = renderPage();

    expect(await screen.findByRole("link", { name: "기존 화면 보기" })).toHaveAttribute(
      "href",
      "/admin#/runtime-requests",
    );
    await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
    expect(screen.getByRole("link", { name: "기존 요청 화면 열기" })).toHaveAttribute(
      "href",
      "/admin#/runtime-requests",
    );
    page.unmount();

    authRuntime.featureFallback = false;
    request.mockResolvedValueOnce(response as never);
    renderPage();
    expect(await screen.findByText("req-001")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "기존 화면 보기" })).not.toBeInTheDocument();
  });

  it("uses the runtime request Legacy path in a terminal error", async () => {
    authRuntime.legacyPath = "/admin#/runtime-requests";
    vi.spyOn(apiClient, "request").mockRejectedValueOnce(
      new AppError("내부 오류", { kind: "http", requestId: "gateway-request-runtime" }),
    );
    renderPage();

    expect(await screen.findByRole("link", { name: "기존 관리자 화면 열기" })).toHaveAttribute(
      "href",
      "/admin#/runtime-requests",
    );
  });

  it("uses the global automatic refresh interval and pauses request polling while hidden", async () => {
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "visible";
    let poll: (() => void) | undefined;
    let pollRegistrations = 0;
    let unmount: (() => void) | undefined;

    try {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === 60_000 && typeof handler === "function") {
          poll = handler as () => void;
          pollRegistrations += 1;
        }
        return 1;
      });
      usePreferences.setState({ refreshInterval: 60 });
      const request = vi.spyOn(apiClient, "request").mockResolvedValue(response as never);
      const user = userEvent.setup();
      const page = renderPage();
      unmount = page.unmount;

      expect(await screen.findByText("req-001")).toBeInTheDocument();
      expect(poll).toBeDefined();
      const registrationsBeforeDetail = pollRegistrations;
      const refresh = screen.getByRole("button", { name: "새로고침" });
      await user.click(screen.getByRole("button", { name: "1번째 요청 req-001 상세 보기" }));
      expect(screen.getByRole("dialog", { name: "1번째 요청 req-001" })).toBeVisible();
      fireEvent.click(refresh);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(pollRegistrations).toBeGreaterThan(registrationsBeforeDetail));
      request.mockClear();

      visibility = "hidden";
      act(() => poll?.());
      await act(async () => Promise.resolve());
      expect(request).not.toHaveBeenCalled();

      visibility = "visible";
      act(() => poll?.());
      await waitFor(() => expect(request).toHaveBeenCalledOnce());
    } finally {
      unmount?.();
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
      act(() => usePreferences.setState({ refreshInterval: 0 }));
    }
  });

  it("distinguishes loading, empty and terminal error states", async () => {
    let resolvePending: ((value: AppRequestsResponse) => void) | undefined;
    vi.spyOn(apiClient, "request").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve as (value: AppRequestsResponse) => void;
        }) as never,
    );
    const loading = renderPage();
    expect(screen.getByText("최근 요청을 불러오는 중입니다.")).toBeInTheDocument();
    resolvePending?.({ ...response, requests: [], next_cursor: undefined });
    expect(
      await screen.findByText("조건에 맞는 요청이 없습니다. 기간이나 필터를 조정해 보세요."),
    ).toBeInTheDocument();
    loading.unmount();

    vi.spyOn(apiClient, "request").mockRejectedValueOnce(
      new AppError("목록 실패", { kind: "http", requestId: "gateway-request-2" }),
    );
    renderPage();
    expect(await screen.findByText("요청 목록을 확인할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("목록 실패")).not.toBeInTheDocument();
    expect(screen.getByText("요청 ID: gateway-request-2")).toBeInTheDocument();
  });
});
