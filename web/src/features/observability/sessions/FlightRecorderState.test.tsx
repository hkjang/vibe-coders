import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { tokenStore } from "@/shared/auth/token-store";
import { deferred, failure, renderRecorder, response, runtime } from "./flight-recorder-test-harness";

const exportName = "CSV 내보내기";
const retryName = "비행기록 다시 조회";
const ready = () => screen.findByRole("button", { name: exportName });
type View = ReturnType<typeof renderRecorder>;
function capturedQuery(view: View) {
  const query = view.query();
  const fn = query.options.queryFn;
  if (typeof fn !== "function") throw new Error("Expected actual active Query function");
  return {
    query,
    invoke: () =>
      Promise.resolve().then(() =>
        fn({
          client: view.client,
          queryKey: query.queryKey,
          signal: new AbortController().signal,
          meta: undefined,
        }),
      ),
  };
}

describe("기존 상세·CSV 정상 대조", () => {
  it.each(["authenticated", "legacy", "open"] as const)(
    "실제 FeatureRoute %s + readonly GET과 현재 CSV",
    async (mode) => {
      const view = renderRecorder({ auth: { mode } });
      await userEvent.click(await ready());
      expect(view.readOnly()).toBe(true);
      expect(view.details()).toHaveLength(1);
      expect(view.downloads).toHaveLength(1);
      expect(view.details()[0]?.routeId).toBe("observability.sessions.flight-recorder");
    },
  );
  it("정상 마스킹 표시 ID는 허용하고 실제 Query.fetch는 원래 경로를 유지한다", async () => {
    const view = renderRecorder({
      target: "reader@example.test",
      reply: async () => response("[REDACTED_EMAIL]"),
    });
    await userEvent.click(await ready());
    expect(screen.getByText("[REDACTED_EMAIL]")).toBeVisible();
    const { query } = capturedQuery(view);
    await act(async () => {
      await query.fetch();
    });
    expect(view.details()).toHaveLength(2);
    expect(
      view.details().every((call) => call.path === "/admin/sessions/reader%40example.test/flight-recorder"),
    ).toBe(true);
    await userEvent.click(await ready());
    expect(view.downloads).toHaveLength(2);
  });
  it("실제 toCsv의 기존 15열/BOM/수식·쉼표·따옴표 escaping을 유지한다", async () => {
    const body = response();
    const event = body.events[0];
    if (!event) throw new Error("Expected fixture event");
    event.request_id = "=SUM(1,2)";
    event.model = 'quoted "model",one';
    const view = renderRecorder({ reply: async () => body });
    await userEvent.click(await ready());
    const content = view.downloads[0]?.content;
    expect(content).toBeDefined();
    expect(content?.split("\r\n")[0]).toBe(
      "\uFEFFcreated_at,request_id,trace_id,kind,endpoint,model,provider,status_code,latency_ms,total_tokens,cost_krw,tool_count,secret_events,policy_blocks,code_risk",
    );
    expect(content).toContain('"\'=SUM(1,2)"');
    expect(content).toContain('"quoted ""model"",one"');
    expect(content).not.toContain("NOT_A_CSV_COLUMN");
    // The browser lane owns actual Blob/anchor/revoke assertions; filenames are deliberately not asserted.
  });
  it("목록 밖 직접 상세는 days/q 변경·미캐시 목록 실패와 별개로 유지한다", async () => {
    const view = renderRecorder({ page: true, route: "?session_id=outside" });
    const button = await ready();
    const dialog = screen.getByRole("dialog", { name: "세션 비행기록" });
    view.listReply(async () => {
      throw failure();
    });
    await act(async () => view.navigate("?days=30&q=unmatched&session_id=outside"));
    await waitFor(() => {
      const list = view.client
        .getQueryCache()
        .findAll({ queryKey: ["observability", "sessions"] })
        .find((query) => query.queryKey[2] !== "flight-recorder" && query.getObserversCount() > 0);
      expect(list?.state.status).toBe("error");
    });
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("safe-request-1");
    expect(screen.getByRole("dialog", { name: "세션 비행기록" })).toBe(dialog);
    expect(screen.getByRole("button", { name: exportName })).toBe(button);
    expect(view.details()).toHaveLength(1);
    await userEvent.click(button);
    expect(view.downloads).toHaveLength(1);
  });
  it("실제 SessionPage의 read 회수는 열린 Sheet를 제거한다(기존 부모 보호)", async () => {
    const view = renderRecorder({ page: true, route: "?session_id=outside" });
    await ready();
    await act(async () => {
      runtime.scopes = [];
      view.rerenderRuntime();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(view.details()).toHaveLength(1);
    expect(screen.getByText("현재 세션 목록 조회 권한을 확인하세요.")).toBeVisible();
  });
  it.each([
    { verdict: "정상", tone: "success" },
    { verdict: "주의", tone: "warning" },
    { verdict: "위험", tone: "danger" },
  ])("기존 알려진 $verdict 판정은 서버 요약의 $tone 표시를 유지한다", async ({ verdict, tone }) => {
    const body = response();
    body.summary.verdict = verdict;
    renderRecorder({ reply: async () => body });
    await ready();
    expect(screen.getByText(`판정: ${verdict}`).closest(".inline-notice")).toHaveClass(
      `inline-notice-${tone}`,
    );
  });
});

describe("상세 조회·한국어 결과 목표", () => {
  it("첫 오류의 수동 재조회는 보류·성공 동안 같은 버튼과 키보드 초점을 유지한다", async () => {
    const view = renderRecorder({
      reply: async () => {
        throw failure();
      },
    });
    await screen.findByRole("alert");
    const button = screen.getByRole("button", { name: retryName });
    button.focus();
    const gate = deferred<unknown>();
    view.reply(() => gate.promise);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(view.details()).toHaveLength(2));
    expect(screen.getByRole("button", { name: retryName })).toBe(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.keyboard("{Enter}");
    await act(async () => {
      view.captured(retryName)();
      view.captured(retryName)();
    });
    expect(view.details()).toHaveLength(2);
    expect(view.downloads).toHaveLength(0);
    await act(async () => gate.resolve(response()));
    await ready();
    expect(screen.getByRole("button", { name: retryName })).toBe(button);
    expect(button).toHaveFocus();
    await userEvent.click(await ready());
    expect(view.downloads).toHaveLength(1);
  });
  it("성공 화면에도 명시 재조회가 있고 중복 activation은 1개 요청만 시작한다", async () => {
    const view = renderRecorder();
    await ready();
    const gate = deferred<unknown>();
    view.reply(() => gate.promise);
    const button = screen.getByRole("button", { name: retryName });
    const run = view.captured(retryName);
    await act(async () => {
      run();
      run();
    });
    await waitFor(() => expect(view.details()).toHaveLength(2));
    expect(button).toHaveAttribute("aria-busy", "true");
    await act(async () => gate.resolve(response()));
    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy", "true"));
  });
  it("로컬 자동 retry와 창 focus 재조회를 끄되 실제 mount GET은 수행한다", async () => {
    const view = renderRecorder();
    await ready();
    const { query } = capturedQuery(view);
    expect(view.details()).toHaveLength(1);
    expect.soft(query.options.retry).toBe(false);
    expect.soft("refetchOnWindowFocus" in query.options && query.options.refetchOnWindowFocus).toBe(false);
  });
  it("retryable 첫 오류도 자동 반복하지 않고 명시 재조회로 복구한다", async () => {
    const view = renderRecorder({
      reply: async () => {
        throw failure("safe-first-error", true);
      },
    });
    await screen.findByRole("alert");
    expect(view.details()).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("safe-first-error");
    view.reply(async () => response());
    await userEvent.click(screen.getByRole("button", { name: retryName }));
    await ready();
    expect(view.details()).toHaveLength(2);
  });
  it.each(["future-verdict", ""])("unknown 판정 %s를 정상으로 꾸미지 않는다", async (verdict) => {
    const body = response();
    body.summary.verdict = verdict;
    renderRecorder({ reply: async () => body });
    await ready();
    const label = screen.getByText("판정 확인 불가");
    expect(label.closest(".inline-notice")).not.toHaveClass("inline-notice-success");
  });
  it("공급자와 첫/마지막 기록 시각을 한글로 표시한다", async () => {
    renderRecorder();
    await ready();
    expect(screen.getByText("공급자")).toBeVisible();
    expect(screen.getByText("첫 기록 시각")).toBeVisible();
    expect(screen.getByText("마지막 기록 시각")).toBeVisible();
    expect(screen.queryByText("Provider")).not.toBeInTheDocument();
  });
  it.each([
    { kind: "chat", risk: "high", kindLabel: "대화", riskLabel: "높음" },
    { kind: "unknown-future", risk: "unknown-future", kindLabel: "기타 요청", riskLabel: "확인 불가" },
  ])(
    "종류 $kind 와 위험 $risk 는 표시만 한글화하고 CSV 원본값은 유지한다",
    async ({ kind, risk, kindLabel, riskLabel }) => {
      const body = response();
      const event = body.events[0];
      if (!event) throw new Error("Expected synthetic event");
      event.kind = kind;
      event.code_risk = risk;
      const view = renderRecorder({ reply: async () => body });
      await ready();
      expect(screen.getByText(kindLabel)).toBeVisible();
      expect(screen.getByText(`코드 위험 ${riskLabel}`)).toBeVisible();
      expect(screen.getByText(`코드 위험 ${riskLabel}`)).toHaveClass(
        risk === "unknown-future" ? "badge-info" : "badge-warning",
      );
      expect(screen.getByText("첫 기록 대비 +0ms")).toBeVisible();
      expect(
        screen.getByText("상대 위치는 첫 기록 시각과의 차이이며 실제 실행 시작·종료를 뜻하지 않습니다."),
      ).toBeVisible();
      await userEvent.click(await ready());
      expect(view.downloads[0]?.content).toContain(`,${kind},`);
      expect(view.downloads[0]?.content).toContain(`,${risk}\r\n`);
    },
  );
  it.each([undefined, "최대 500건입니다. 프롬프트 원문은 포함되지 않습니다."])(
    "서버 note %s를 완전성·무원문 보장으로 복창하지 않는다",
    async (note) => {
      renderRecorder({ reply: async () => ({ ...response(), note }) });
      await ready();
      expect(screen.getByText("목록 기간과 별개인 세션의 제한된 최근 요청을 보여줍니다.")).toBeVisible();
      expect(document.body).not.toHaveTextContent("500");
      expect(document.body).not.toHaveTextContent("원문은 포함되지 않습니다");
    },
  );
  it.each([
    { label: "빈 배열", events: [] },
    { label: "null", events: null },
    { label: "생략", events: undefined },
  ])("events $label 는 이 응답의 확인 범위만 말한다", async ({ events }) => {
    renderRecorder({ reply: async () => ({ ...response(), events }) });
    await ready();
    expect(screen.getByText("이 응답에서 확인할 기록이 없습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: exportName })).toBeDisabled();
    expect(document.body).not.toHaveTextContent("요청이 아직 없습니다");
  });
  it("동적 credential prefix 오류 ID를 숨기고 일반 오류 ID는 표시한다", async () => {
    const marker = `corp_${"x".repeat(40)}`;
    const view = renderRecorder({
      auth: { prefixes: ["other_"] },
      reply: async () => {
        throw failure(marker);
      },
    });
    await screen.findByRole("alert");
    await act(async () => {
      runtime.prefixes = ["corp_"];
      view.rerenderRuntime();
    });
    expect(document.body.outerHTML).not.toContain(marker);
    view.reply(async () => {
      throw failure("safe-request-visible");
    });
    await act(async () => {
      await view
        .query()
        .fetch()
        .catch(() => undefined);
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("safe-request-visible"));
  });
  it("보류 중 이전 타임라인 DOM/초점은 유지하고 CSV 현재·캡처 콜백을 잠근다", async () => {
    const view = renderRecorder();
    const button = await ready();
    button.focus();
    const line = screen.getByText("req-a");
    const old = view.captured();
    const gate = deferred<unknown>();
    view.reply(() => gate.promise);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = view.query().fetch();
    });
    expect(screen.getByText("req-a")).toBe(line);
    expect(screen.getByRole("button", { name: exportName })).toBe(button);
    expect(button).toHaveFocus();
    expect(button.matches(":disabled") || button.getAttribute("aria-disabled") === "true").toBe(true);
    await act(async () => old());
    expect(view.downloads).toHaveLength(0);
    await act(async () => {
      gate.resolve(response());
      await pending;
    });
    await userEvent.click(await ready());
    expect(view.downloads).toHaveLength(1);
  });
  it("같은 대상 갱신 실패는 이전 행을 유지하되 CSV는 잠그고 수동 성공 후 복구한다", async () => {
    const view = renderRecorder();
    await ready();
    const row = screen.getByText("req-a");
    const old = view.captured();
    view.reply(async () => {
      throw failure();
    });
    await act(async () => {
      await view
        .query()
        .fetch()
        .catch(() => undefined);
    });
    await waitFor(() => expect(view.query().state.status).toBe("error"));
    expect(screen.getByText("req-a")).toBe(row);
    expect(screen.getByRole("alert")).toHaveTextContent("safe-request-1");
    await act(async () => old());
    expect(view.downloads).toHaveLength(0);
    view.reply(async () => response());
    await userEvent.click(screen.getByRole("button", { name: retryName }));
    await userEvent.click(await ready());
    expect(view.downloads).toHaveLength(1);
  });
});

describe("Panel 자체의 요청·CSV 수명(부모 remount 보호와 별도)", () => {
  it("같은 key·data·count로 Query를 재생성해도 옛 CSV는 거부하고 현재 조회는 복구한다", async () => {
    const view = renderRecorder();
    await ready();
    const { query } = capturedQuery(view);
    const old = view.captured();
    const data = query.state.data;
    const count = query.state.dataUpdateCount;
    expect(count).toBe(1);
    await act(async () => {
      view.client.removeQueries({ queryKey: query.queryKey, exact: true });
      view.client.setQueryData(query.queryKey, data);
      const replacement = view.client.getQueryCache().find({ queryKey: query.queryKey, exact: true });
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(query);
      expect(replacement?.state.data).toBe(data);
      expect(replacement?.state.dataUpdateCount).toBe(count);
      old();
    });
    expect(view.downloads).toHaveLength(0);
    await act(async () => {
      await view.query().fetch();
    });
    expect(view.details()).toHaveLength(2);
    await userEvent.click(await ready());
    expect(view.downloads).toHaveLength(1);
  });
  it.each(["scope", "team", "target", "committed-close", "unmount"] as const)(
    "%s 뒤 CSV 콜백 자체의 폐기(옛 queryFn 단언과 독립)",
    async (boundary) => {
      const view = renderRecorder();
      await ready();
      const exportOld = view.captured();
      await act(async () => {
        if (boundary === "scope") {
          runtime.scopes = [];
          view.rerenderRuntime();
        }
        if (boundary === "team") {
          runtime.team = "team-b";
          view.rerenderRuntime();
        }
        if (boundary === "target") view.target("sess-beta");
        if (boundary === "committed-close") view.open(false);
        if (boundary === "unmount") view.unmount();
      });
      await act(async () => exportOld());
      expect(view.downloads).toHaveLength(0);
      if (boundary !== "unmount") {
        await act(async () => {
          runtime.scopes = ["admin:read"];
          runtime.team = "team-a";
          view.target("sess-alpha");
          view.open(true);
          view.rerenderRuntime();
        });
        await userEvent.click(await ready());
        expect(view.downloads).toHaveLength(1);
      }
    },
  );
  it.each(["invalidate", "same-object-success"] as const)(
    "React 알림 전 actual Query %s가 옛 CSV를 폐기한다",
    async (boundary) => {
      const view = renderRecorder();
      await ready();
      const { query } = capturedQuery(view);
      const old = view.captured();
      const data = query.state.data;
      const count = query.state.dataUpdateCount;
      const clock = vi.spyOn(Date, "now").mockReturnValue(query.state.dataUpdatedAt);
      const updatedAt = query.state.dataUpdatedAt;
      await act(async () => {
        if (boundary === "invalidate") query.invalidate();
        else query.setData(data);
        old();
      });
      clock.mockRestore();
      if (boundary === "same-object-success") {
        expect(query.state.data).toBe(data);
        expect(query.state.dataUpdateCount).toBe(count + 1);
        expect(query.state.dataUpdatedAt).toBe(updatedAt);
      }
      expect(view.downloads).toHaveLength(0);
      if (boundary === "invalidate") {
        await act(async () => {
          await query.fetch();
        });
        expect(view.details()).toHaveLength(2);
      }
      await userEvent.click(await ready());
      expect(view.downloads).toHaveLength(1);
    },
  );
  it.each(["scope", "team", "mode", "owner", "epoch"] as const)(
    "%s 왕복 이후 캡처된 실제 queryFn/CSV는 영구 폐기한다",
    async (boundary) => {
      const view = renderRecorder({ actualRoute: boundary !== "owner" });
      await ready();
      const old = capturedQuery(view);
      await act(async () => {
        await old.query.fetch();
      });
      expect(view.details()).toHaveLength(2); // The captured object is an actual callable Query, not a fabricated key.
      await userEvent.click(await ready());
      expect(view.downloads).toHaveLength(1);
      const exportOld = view.captured(); // Capture only after the current post-fetch CSV succeeded.
      await act(async () => {
        if (boundary === "scope") runtime.scopes = [];
        if (boundary === "team") runtime.team = "team-b";
        if (boundary === "mode") runtime.mode = "legacy";
        if (boundary === "owner") runtime.owner = "observability.requests";
        if (boundary === "epoch") tokenStore.clearAll();
        view.rerenderRuntime();
      });
      await act(async () => {
        runtime.scopes = ["admin:read"];
        runtime.team = "team-a";
        runtime.mode = "authenticated";
        runtime.owner = "observability.sessions";
        view.rerenderRuntime();
      });
      await ready();
      const before = view.details().length;
      await expect(old.invoke()).rejects.toMatchObject({ kind: "aborted" });
      await act(async () => exportOld());
      expect(view.details()).toHaveLength(before);
      expect(view.downloads).toHaveLength(1);
      await act(async () => {
        await view.query().fetch();
      });
      expect(view.details()).toHaveLength(before + 1);
      await userEvent.click(await ready());
      expect(view.downloads).toHaveLength(2);
    },
  );
  it.each(["target", "committed-close"] as const)(
    "%s A/B/A는 옛 GET/CSV 콜백을 되살리지 않는다",
    async (boundary) => {
      const view = renderRecorder();
      await ready();
      const old = capturedQuery(view);
      const exportOld = view.captured();
      await act(async () => {
        if (boundary === "target") view.target("sess-beta");
        else view.open(false);
      });
      if (boundary === "target") await screen.findByText("sess-beta");
      await act(async () => {
        if (boundary === "target") view.target("sess-alpha");
        else view.open(true);
      });
      await ready();
      const before = view.details().length;
      await expect(old.invoke()).rejects.toMatchObject({ kind: "aborted" });
      await act(async () => exportOld());
      expect(view.details()).toHaveLength(before);
      expect(view.downloads).toHaveLength(0);
      await userEvent.click(await ready());
      expect(view.downloads).toHaveLength(1);
      // Close is committed here. A synchronous parent close-before-commit lease is not claimed.
    },
  );
  it("unmount 뒤 실제 queryFn과 캡처 CSV가 실행되지 않는다", async () => {
    const view = renderRecorder();
    await ready();
    const old = capturedQuery(view);
    const exportOld = view.captured();
    view.unmount();
    await expect(old.invoke()).rejects.toMatchObject({ kind: "aborted" });
    exportOld();
    expect(view.downloads).toHaveLength(0);
    expect(view.details()).toHaveLength(1);
  });
  it("serverAvailable true라도 admin:read 없는 Panel은 GET하지 않는다", async () => {
    const view = renderRecorder({ auth: { scopes: [] } });
    await act(async () => undefined);
    expect(view.readOnly()).toBe(true);
    expect(view.details()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: exportName })).not.toBeInTheDocument();
  });
  it("현재 read 회수 중 늦은 응답을 DOM/캐시에 게시하지 않는다", async () => {
    const gate = deferred<unknown>();
    const view = renderRecorder({ reply: () => gate.promise });
    await waitFor(() => expect(view.details()).toHaveLength(1));
    const old = view.query();
    await act(async () => {
      runtime.scopes = [];
      view.rerenderRuntime();
    });
    await act(async () => gate.resolve(response("late-private-display")));
    expect(screen.queryByText("late-private-display")).not.toBeInTheDocument();
    expect(old.state.data).toBeUndefined();
    view.reply(async () => response());
    await act(async () => {
      runtime.scopes = ["admin:read"];
      view.rerenderRuntime();
    });
    await userEvent.click(await ready());
    expect(view.downloads).toHaveLength(1);
  });
  it("늦은 이전 target 응답은 새 target 타임라인을 덮지 않는다", async () => {
    const gate = deferred<unknown>();
    const view = renderRecorder({
      reply: (target) => (target === "sess-alpha" ? gate.promise : Promise.resolve(response("beta-display"))),
    });
    await waitFor(() => expect(view.details()).toHaveLength(1));
    await act(async () => view.target("sess-beta"));
    await screen.findByText("beta-display");
    await act(async () => gate.resolve(response("late-alpha-display")));
    expect(screen.queryByText("late-alpha-display")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "수신 기록 집계" })).getByText("요청")).toBeVisible();
    await userEvent.click(await ready());
    expect(view.downloads).toHaveLength(1);
  });
});
