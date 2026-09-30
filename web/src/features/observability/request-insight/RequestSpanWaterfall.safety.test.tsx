import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { apiFailure } from "@/test/api";
import {
  deferred,
  firstRequest,
  flowCard,
  flowRow,
  linksFixture,
  linksKey,
  rootName,
  rootSpan,
  setupFlow,
  text2sqlSpan,
  toolName,
  traceFixture,
  traceKey,
} from "./request-flow-test-harness";

describe("request flow existing controls", () => {
  it.each(["preview", "read_only", "preview_read_only"] as const)(
    "%s keeps authorized GET-only request metadata",
    async (mode) => {
      const flow = setupFlow({ mode });
      await screen.findByText(rootName, { selector: "code" });
      await screen.findByRole("link", { name: "세션 흐름 보기" });
      expect(screen.getByTestId("flow-access")).toHaveTextContent(
        `observability.llm:${String(mode !== "preview")}`,
      );
      expect(flow.attempts).toHaveLength(2);
      expect(flow.attempts.every((item) => item.method === "GET" && item.signal && item.routeId)).toBe(true);
      expect(within(flowRow(rootName)).getByText("정상")).toBeVisible();
      expect(within(flowCard()).getByText("MCP 1건")).toBeVisible();
    },
  );

  it("keeps a valid recorded root zero rather than inventing a nonzero measurement", async () => {
    setupFlow({ trace: () => traceFixture({ total_ms: 0, spans: [rootSpan({ duration_ms: 0 })] }) });
    await screen.findByText(rootName, { selector: "code" });
    expect(flowRow(rootName)).toHaveTextContent("0ms");
    expect(within(flowRow(rootName)).getByText("정상")).toBeVisible();
    // Zero is a stored value, not proof that MCP/cache work took zero time.
  });

  it("keeps known error state and authorized ordinary error detail", async () => {
    setupFlow({
      trace: () => traceFixture({ spans: [rootSpan({ status: "error", error: "공개 오류 설명" })] }),
    });
    await screen.findByText(rootName, { selector: "code" });
    expect(within(flowRow(rootName)).getByText("오류")).toBeVisible();
    expect(within(flowRow(rootName)).getByText("공개 오류 설명")).toBeVisible();
  });

  it("shows pending trace separately while linked metadata can already succeed", async () => {
    const held = deferred<unknown>();
    setupFlow({ trace: () => held.promise });
    expect(screen.getByText("처리 흐름을 불러오는 중입니다.")).toBeVisible();
    expect(await screen.findByText("MCP 1건")).toBeVisible();
    expect(screen.queryByText("표시할 스팬이 없습니다.")).not.toBeInTheDocument();
    await act(async () => held.resolve(traceFixture()));
    expect(await screen.findByText(rootName, { selector: "code" })).toBeVisible();
  });

  it("preserves query abort and keyed request isolation when the selected request changes", async () => {
    const held = deferred<unknown>();
    const flow = setupFlow({
      trace: (id) =>
        id === firstRequest
          ? held.promise
          : traceFixture({ request_id: id, spans: [rootSpan({ name: "새 요청 기록" }, id)] }),
    });
    await waitFor(() => expect(flow.count("trace")).toBe(1));
    const oldSignal = flow.attempts.find((item) => item.path.endsWith("/trace"))?.signal;
    flow.selectRequest("flow-request-b");
    expect(await screen.findByText("새 요청 기록", { selector: "code" })).toBeVisible();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => held.resolve(traceFixture({ spans: [rootSpan({ name: "이전 요청 기록" })] })));
    expect(screen.queryByText("이전 요청 기록")).not.toBeInTheDocument();
  });

  it("preserves existing client epoch rejection after cache discard and a new session", async () => {
    const held = deferred<unknown>();
    const flow = setupFlow({
      trace: (id) =>
        id === firstRequest
          ? held.promise
          : traceFixture({ request_id: id, spans: [rootSpan({ name: "다른 세션 기록" }, id)] }),
    });
    await waitFor(() => expect(flow.count("trace")).toBe(1));
    flow.nextSession("flow-request-b");
    expect(await screen.findByText("다른 세션 기록", { selector: "code" })).toBeVisible();
    await act(async () => held.resolve(traceFixture({ spans: [rootSpan({ name: "종료된 세션 원문" })] })));
    expect(screen.queryByText("종료된 세션 원문")).not.toBeInTheDocument();
  });
});

describe("request flow bounded clarity gaps", () => {
  it("never fetches an empty request ID through either manual retry", async () => {
    const flow = setupFlow({ initialRequestId: "" });
    await flow.user.click(screen.getByRole("button", { name: "처리 흐름 다시 조회" }));
    await flow.user.click(screen.getByRole("button", { name: "연결 기록 다시 조회" }));
    expect(flow.attempts).toEqual([]);
    expect(screen.getByRole("button", { name: "처리 흐름 다시 조회" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "연결 기록 다시 조회" })).toBeDisabled();
  });
  it("does not claim no records when trace lookup failed", async () => {
    setupFlow({
      trace: () => {
        throw apiFailure("synthetic trace failure", 503, "flow-trace-error");
      },
    });
    await screen.findByText("처리 흐름을 불러오지 못했습니다.");
    expect(screen.queryByText("표시할 스팬이 없습니다.")).not.toBeInTheDocument();
    expect(screen.queryByText(/단계가 기록되지 않았습니다/u)).not.toBeInTheDocument();
  });

  it("shows the safe trace error request ID for manual diagnosis", async () => {
    setupFlow({
      trace: () => {
        throw apiFailure("synthetic trace failure", 503, "flow-trace-error");
      },
    });
    await screen.findByText("처리 흐름을 불러오지 못했습니다.");
    expect(flowCard()).toHaveTextContent("flow-trace-error");
  });

  it("offers one deliberate trace retry without automatically replaying the successful links query", async () => {
    const flow = setupFlow({
      trace: () => {
        throw apiFailure("synthetic trace failure");
      },
    });
    await screen.findByText("처리 흐름을 불러오지 못했습니다.");
    flow.response.trace = () => traceFixture();
    expect(flow.count("trace")).toBe(1);
    await flow.user.click(within(flowCard()).getByRole("button", { name: /처리 흐름.*다시/u }));
    expect(await screen.findByText(rootName, { selector: "code" })).toBeVisible();
    expect(flow.count("trace")).toBe(2);
    expect(flow.count("links")).toBe(1);
  });

  it("reports links failure independently while keeping the successful trace", async () => {
    setupFlow({
      links: () => {
        throw apiFailure("synthetic links failure", 503, "flow-links-error");
      },
    });
    await screen.findByText(rootName, { selector: "code" });
    expect(flowCard()).toHaveTextContent(/연결.*불러오지 못했습니다/u);
    expect(flowCard()).toHaveTextContent("flow-links-error");
    expect(screen.queryByText("처리 흐름을 불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("allows independent links retry without refetching the successful trace", async () => {
    const flow = setupFlow({
      links: () => {
        throw apiFailure("synthetic links failure");
      },
    });
    await screen.findByText(rootName, { selector: "code" });
    flow.response.links = () => linksFixture();
    await flow.user.click(within(flowCard()).getByRole("button", { name: /연결.*다시/u }));
    expect(await screen.findByText("MCP 1건")).toBeVisible();
    expect(flow.count("links")).toBe(2);
    expect(flow.count("trace")).toBe(1);
  });

  it("does not turn omitted linked counts into known zero", async () => {
    setupFlow({ links: () => linksFixture({ counts: { tools: 1 } }) });
    await screen.findByText(rootName, { selector: "code" });
    expect(screen.queryByText("MCP 0건")).not.toBeInTheDocument();
    expect(screen.queryByText("Text2SQL 0단계")).not.toBeInTheDocument();
    expect(flowCard()).toHaveTextContent(/확인할 수 없|미확인/u);
  });

  it("marks cached links as previous data when their own refresh fails", async () => {
    const flow = setupFlow();
    await screen.findByText("MCP 1건");
    flow.response.links = () => {
      throw apiFailure("synthetic refresh failure");
    };
    await act(async () => flow.client.refetchQueries({ queryKey: linksKey(), exact: true }));
    expect(flow.count("links")).toBe(2);
    expect(flow.client.getQueryState(linksKey())?.status).toBe("error");
    await waitFor(() => expect(flowCard()).toHaveTextContent(/이전.*연결|연결.*이전/u));
    expect(screen.getByText(rootName, { selector: "code" })).toBeVisible();
  });

  it("marks retained trace rows as previous results when refreshing them fails", async () => {
    const flow = setupFlow();
    await screen.findByText(rootName, { selector: "code" });
    flow.response.trace = () => {
      throw apiFailure("synthetic refresh failure");
    };
    await act(async () => flow.client.refetchQueries({ queryKey: traceKey(), exact: true }));
    expect(screen.getByText(rootName, { selector: "code" })).toBeVisible();
    expect(flow.client.getQueryState(traceKey())?.status).toBe("error");
    await waitFor(() => expect(flowCard()).toHaveTextContent(/이전.*흐름|흐름.*이전/u));
  });

  it("does not present retained empty rows as an empty lookup when refreshing them fails", async () => {
    const flow = setupFlow({ trace: () => traceFixture({ spans: [] }) });
    await screen.findByText("표시할 스팬이 없습니다.");
    flow.response.trace = () => {
      throw apiFailure("synthetic empty refresh failure");
    };
    await act(async () => flow.client.refetchQueries({ queryKey: traceKey(), exact: true }));
    expect(flow.client.getQueryState(traceKey())?.status).toBe("error");
    await screen.findByText("처리 흐름을 불러오지 못했습니다.");
    expect(screen.queryByText("표시할 스팬이 없습니다.")).not.toBeInTheDocument();
    expect(flowCard()).toHaveTextContent("이전 처리 흐름을 표시합니다.");
    expect(flow.count("trace")).toBe(2);
    expect(flow.count("links")).toBe(1);
  });

  it.each([
    { label: "omitted", spans: undefined },
    { label: "null", spans: null },
    { label: "empty array", spans: [] },
  ])("does not claim missing work from the loose adapter's empty spans ($label)", async ({ spans }) => {
    setupFlow({ trace: () => traceFixture({ spans }) });
    await screen.findByRole("link", { name: "세션 흐름 보기" });
    await waitFor(() => expect(screen.queryByText("처리 흐름을 불러오는 중입니다.")).not.toBeInTheDocument());
    expect(screen.queryByText(/단계가 기록되지 않았습니다/u)).not.toBeInTheDocument();
    expect(flowCard()).toHaveTextContent(/확인할.*단계|표시할.*스팬/u);
  });

  it("labels actual Text2SQL skipped status as skipped, even with a reason", async () => {
    setupFlow({
      trace: () =>
        traceFixture({
          spans: [
            rootSpan(),
            text2sqlSpan({
              status: "skipped",
              error: "explain_guard_failed",
              start_offset_ms: 0,
              duration_ms: 0,
            }),
          ],
        }),
    });
    await screen.findByText("text2sql:execute", { selector: "code" });
    expect(within(flowRow("text2sql:execute")).queryByText("정상")).not.toBeInTheDocument();
    expect(within(flowRow("text2sql:execute")).getByText(/건너뜀|생략/u)).toBeVisible();
  });

  it("does not translate an unknown server status to normal", async () => {
    setupFlow({ trace: () => traceFixture({ spans: [rootSpan({ status: "future_status" })] }) });
    await screen.findByText(rootName, { selector: "code" });
    expect(within(flowRow(rootName)).queryByText("정상")).not.toBeInTheDocument();
    expect(flowRow(rootName)).toHaveTextContent(/알 수 없|미확인/u);
  });

  it("does not let cache hit replace an explicit error status", async () => {
    setupFlow({
      trace: () =>
        traceFixture({ spans: [rootSpan({ status: "error", error: "공개 오류", cache_hit: true })] }),
    });
    await screen.findByText(rootName, { selector: "code" });
    expect(within(flowRow(rootName)).getByText("오류")).toBeVisible();
  });

  it("does not let cache hit certify an unknown status", async () => {
    setupFlow({
      trace: () => traceFixture({ spans: [rootSpan({ status: "future_status", cache_hit: true })] }),
    });
    await screen.findByText(rootName, { selector: "code" });
    expect(flowRow(rootName)).toHaveTextContent(/알 수 없|미확인/u);
  });

  it("describes offsets as recorded relative positions, not actual stage starts", async () => {
    setupFlow({
      trace: () =>
        traceFixture({
          total_ms: 340,
          spans: [rootSpan(), text2sqlSpan()],
        }),
    });
    await screen.findByText("text2sql:execute", { selector: "code" });
    expect(flowRow("text2sql:execute")).not.toHaveTextContent("시작 +");
    expect(flowRow("text2sql:execute")).toHaveTextContent(/기록.*상대|상대.*기록/u);
    expect(flowRow("text2sql:execute")).toHaveTextContent("40ms");
    // 300+40 is not asserted to be the actual finish or a critical-path total.
  });

  it("distinguishes unrecorded tool duration from a zero-duration measurement", async () => {
    setupFlow();
    await screen.findByText(toolName, { selector: "code" });
    expect(flowRow(toolName)).toHaveTextContent(/소요 시간.*미기록|소요 시간.*기록되지/u);
  });

  it("labels the root zero as recorded latency without asserting a measured elapsed time", async () => {
    setupFlow({ trace: () => traceFixture({ total_ms: 0, spans: [rootSpan({ duration_ms: 0 })] }) });
    await screen.findByText(rootName, { selector: "code" });
    expect(flowRow(rootName)).toHaveTextContent(/기록.*지연/u);
    expect(flowRow(rootName)).toHaveTextContent("0ms");
  });

  it("does not promise that authorized error metadata contains no prompt or SQL originals", async () => {
    setupFlow();
    await screen.findByText(rootName, { selector: "code" });
    expect(flowCard()).not.toHaveTextContent("프롬프트나 SQL 원문은 포함하지 않습니다.");
    expect(flowCard()).toHaveTextContent(/오류.*원문|민감.*포함/u);
  });

  it("uses current runtime credential prefixes for displayed metadata without claiming all PII is removed", async () => {
    const marker = `flow_runtime_${"a".repeat(36)}`;
    const flow = setupFlow({
      trace: () =>
        traceFixture({ spans: [rootSpan({ name: `공개 이름 ${marker}`, error: `공개 사유 ${marker}` })] }),
    });
    await screen.findByText(`공개 이름 ${marker}`, { selector: "code" });
    flow.update({ credentialPrefixes: ["flow_runtime_"] });
    expect(flowCard().outerHTML).not.toContain(marker);
    expect(flow.count("trace")).toBe(1);
    // This is display-only credential protection, not new server masking or PII proof.
  });

  it("does not put a credential-shaped returned session ID into a link target", async () => {
    const marker = `vc_sk_${"b".repeat(36)}`;
    setupFlow({ links: () => linksFixture({ session_id: marker }) });
    await screen.findByText(rootName, { selector: "code" });
    await waitFor(() => expect(screen.queryByText("처리 흐름을 불러오는 중입니다.")).not.toBeInTheDocument());
    expect(flowCard().outerHTML).not.toContain(marker);
    expect(flowCard().outerHTML).not.toContain(encodeURIComponent(marker));
  });

  it("resolves the existing session link once under the production /app basename", async () => {
    const flow = setupFlow();
    const link = await screen.findByRole("link", { name: "세션 흐름 보기" });
    const href = link.getAttribute("href");
    await flow.user.click(link);
    expect(screen.getByRole("heading", { name: "기존 세션 화면 경로" })).toBeVisible();
    expect(href).toBe("/app/observability/xview?session_id=flow-session-public");
    expect(screen.getByTestId("flow-location")).toHaveTextContent(
      "/observability/xview?session_id=flow-session-public",
    );
    // Target route only: this does not assert that XView's waterfall tab opens.
  });
});

describe("request flow expanded display and retry boundaries", () => {
  it.each(["span_id", "kind", "status"])(
    "protects the displayed %s with current runtime prefixes",
    async (field) => {
      const marker = `flow_field_${"c".repeat(36)}`;
      const flow = setupFlow({
        trace: () =>
          traceFixture({
            spans: [rootSpan({ [field]: marker, ...(field === "span_id" ? { name: "" } : {}) })],
          }),
      });
      await screen.findByRole("list", { name: "요청 스팬 흐름" });
      expect(flowCard()).toHaveTextContent(marker);
      flow.update({ credentialPrefixes: ["flow_field_"] });
      expect(flowCard().outerHTML).not.toContain(marker);
      expect(flow.count("trace")).toBe(1);
      // Display-only: the existing parsed response is not rewritten.
      expect(
        flow.client.getQueryData<{ spans: Array<Record<string, unknown>> }>(traceKey())?.spans[0]?.[field],
      ).toBe(marker);
    },
  );

  it.each(["trace", "links"] as const)(
    "protects %s error Request ID when runtime prefixes change",
    async (kind) => {
      const marker = `flow_diagnostic_${"d".repeat(36)}`;
      const flow = setupFlow({
        [kind]: () => {
          throw apiFailure("untrusted upstream message", 503, marker);
        },
      });
      expect(await screen.findByText(`요청 ID: ${marker}`)).toBeVisible();
      flow.update({ credentialPrefixes: ["flow_diagnostic_"] });
      expect(flowCard().outerHTML).not.toContain(marker);
      expect(flowCard()).not.toHaveTextContent("untrusted upstream message");
      expect(flow.count(kind)).toBe(1);
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "keeps parsed invalid numeric %s unknown with no fabricated bar",
    async (value) => {
      setupFlow({
        trace: () =>
          traceFixture({
            total_ms: value,
            spans: [rootSpan({ start_offset_ms: value, duration_ms: value, tokens: value })],
          }),
        links: () =>
          linksFixture({
            counts: { tools: value, mcp_tools: value, text2sql_spans: value, tool_errors: value },
          }),
      });
      await screen.findByText(rootName, { selector: "code" });
      expect(flowRow(rootName)).toHaveTextContent("기록된 상대 위치 미확인");
      expect(flowRow(rootName)).toHaveTextContent("기록된 지연 미확인");
      expect(flowRow(rootName)).toHaveTextContent("토큰 미확인");
      expect(flowRow(rootName).querySelector(".obs-span-track")).toBeNull();
      expect(screen.getByText("도구 미확인")).toBeVisible();
      expect(screen.getByText("MCP 미확인")).toBeVisible();
      expect(flowCard().outerHTML).not.toMatch(/NaN%|Infinity%/u);
    },
  );

  it("shows explicit zero linked counts without calling omitted values zero", async () => {
    setupFlow({
      links: () => linksFixture({ counts: { tools: 0, mcp_tools: 0, text2sql_spans: 0, tool_errors: 0 } }),
    });
    expect(await screen.findByText("MCP 0건")).toBeVisible();
    expect(screen.getByText("도구 0건")).toBeVisible();
    expect(screen.getByText("Text2SQL 0단계")).toBeVisible();
    expect(screen.getByText("도구 오류 0건")).toBeVisible();
  });

  it("locks only the pending retry and does not duplicate its user-triggered GET", async () => {
    const flow = setupFlow();
    await screen.findByText(rootName, { selector: "code" });
    const held = deferred<unknown>();
    flow.response.trace = () => held.promise;
    const retry = screen.getByRole("button", { name: "처리 흐름 다시 조회" });
    await flow.user.click(retry);
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(retry).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "연결 기록 다시 조회" })).toBeEnabled();
    expect(flowCard()).toHaveTextContent("이전 처리 흐름을 표시합니다.");
    await flow.user.click(retry);
    expect(flow.count("trace")).toBe(2);
    expect(flow.count("links")).toBe(1);
    await act(async () => held.resolve(traceFixture({ spans: [rootSpan({ name: "다시 받은 기록" })] })));
    expect(await screen.findByText("다시 받은 기록", { selector: "code" })).toBeVisible();
    await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "false"));
    expect(retry).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("이전 처리 흐름을 표시합니다.")).not.toBeInTheDocument();
  });

  it.each(["trace", "links"] as const)(
    "keeps %s retry keyboard focus while ignoring pending Enter repeats",
    async (kind) => {
      const flow = setupFlow();
      await screen.findByText(rootName, { selector: "code" });
      await screen.findByText("MCP 1건");
      const held = deferred<unknown>();
      flow.response[kind] = () => held.promise;
      const retry = screen.getByRole("button", {
        name: kind === "trace" ? "처리 흐름 다시 조회" : "연결 기록 다시 조회",
      });
      // Controlled initial focus for the component test; actual mobile Tab
      // continuity is independently exercised in the browser regression.
      retry.focus();
      await flow.user.keyboard("{Enter}");
      await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "true"));
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveFocus();
      await flow.user.keyboard("{Enter}{Enter}");
      expect(flow.count(kind)).toBe(2);
      expect(flow.count(kind === "trace" ? "links" : "trace")).toBe(1);
      await act(async () => held.resolve(kind === "trace" ? traceFixture() : linksFixture()));
      await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "false"));
      expect(retry).toHaveAttribute("aria-busy", "false");
      expect(retry).toHaveFocus();
      await flow.user.tab();
      expect(
        kind === "trace"
          ? screen.getByRole("button", { name: "연결 기록 다시 조회" })
          : screen.getByRole("link", { name: "세션 흐름 보기" }),
      ).toHaveFocus();
      expect(flow.count(kind)).toBe(2);
    },
  );

  it("retains long public names and ordinary error text in the text alternative", async () => {
    const name = "공개긴모델이름".repeat(80);
    const detail = "공개오류설명".repeat(80);
    setupFlow({ trace: () => traceFixture({ spans: [rootSpan({ name, status: "error", error: detail })] }) });
    await screen.findByText(name, { selector: "code" });
    expect(flowRow(name)).toHaveTextContent(name);
    expect(within(flowRow(name)).getByText(detail)).toBeVisible();
    // DOM text only; visual wrapping/overflow is a separate real-browser check.
  });
});
