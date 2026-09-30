import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareAccess } from "./use-compare-access";
import { useComparisonConsole } from "./use-comparison-console";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";

const runtime = vi.hoisted(() => ({ write: true, read: true, raw: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        scopes: [...(runtime.write ? ["admin:write"] : []), ...(runtime.read ? ["admin:read"] : [])],
        rawPromptView: runtime.raw,
      }),
  };
});
const completed = {
  status: "completed",
  run_id: "public-run-a",
  results: [{ model: "public-model", status: "success", content: "public-result" }],
};
const historyEndpoint = "GET /admin/chat-test/multi-run/runs";
const runEndpoint = "POST /admin/chat-test/multi-run";
beforeEach(() => {
  runtime.write = true;
  runtime.read = true;
  runtime.raw = true;
  tokenStore.clearAll();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
function setup(prepare = () => undefined) {
  const values = {
    models: [{ model: "public-model" }],
    messages: [{ role: "user", content: "public-A" }],
    params: { max_tokens: 12 },
    save_prompt: false,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <FeatureAccessContext.Provider
          value={{ featureId: "gateway.chat", permitted: true, readOnly: false }}
        >
          {children}
        </FeatureAccessContext.Provider>
      </QueryClientProvider>
    );
  }
  const view = renderHook(
    () =>
      useComparisonConsole(useCompareAccess(runtime.write, "admin:write 권한이 필요합니다."), {
        body: () => {
          prepare();
          return values;
        },
        judgeMethod: "rule",
        judgeModel: "",
      }),
    { wrapper: Wrapper },
  );
  return { ...view, values };
}

describe("비교 입력의 승인시점 snapshot과 후속조회", () => {
  it("외부 access가 유지돼도 폐기된 내부 비교 화면의 수동 이력 callback은 GET0이다", async () => {
    const api = mockApi({ [historyEndpoint]: () => ({ runs: [] }) });
    function AccessWrapper({ children }: PropsWithChildren) {
      return (
        <FeatureAccessContext.Provider
          value={{ featureId: "gateway.chat", permitted: true, readOnly: false }}
        >
          {children}
        </FeatureAccessContext.Provider>
      );
    }
    const parent = renderHook(() => useCompareAccess(true, "admin:write 권한이 필요합니다."), {
      wrapper: AccessWrapper,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    function QueryWrapper({ children }: PropsWithChildren) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const child = renderHook(
      () =>
        useComparisonConsole(parent.result.current, {
          body: () => ({ models: [] }),
          judgeMethod: "rule",
          judgeModel: "",
        }),
      { wrapper: QueryWrapper },
    );
    await waitFor(() => expect(child.result.current.history.isSuccess).toBe(true));
    const refresh = child.result.current.refreshHistory;
    child.unmount();
    expect(parent.result.current.isCurrent()).toBe(true);
    await act(async () => refresh());
    expect(api.calls.filter((call) => call.key === historyEndpoint)).toHaveLength(1);
  });

  it("실행 응답 뒤 이력 GET 실패는 완료 결과를 지우거나 비교를 다시 전송하지 않는다", async () => {
    let reads = 0;
    const api = mockApi({
      [historyEndpoint]: () => {
        if (++reads > 1) throw apiFailure("public-history-error", 503, "req_public_history");
        return { runs: [] };
      },
      [runEndpoint]: () => completed,
    });
    const view = setup();
    await waitFor(() => expect(view.result.current.history.isSuccess).toBe(true));
    await act(async () => view.result.current.call("run"));
    await waitFor(() => expect(view.result.current.history.isError).toBe(true));
    expect(view.result.current.run?.run_id).toBe("public-run-a");
    expect(view.result.current.error).toBeUndefined();
    expect(view.result.current.history.error).toMatchObject({ requestId: "req_public_history" });
    expect(api.bodies(runEndpoint)).toHaveLength(1);
    expect(reads).toBe(2);
  });
  it("승인 후 원본 입력 객체가 바뀌어도 요청·응답에 결합한 질문 A는 불변이다", async () => {
    const hold = deferred<typeof completed>();
    const api = mockApi({ [historyEndpoint]: () => ({ runs: [] }), [runEndpoint]: () => hold.promise });
    const view = setup();
    let request!: Promise<void>;
    act(() => {
      request = view.result.current.call("run");
    });
    const message = view.values.messages[0];
    const model = view.values.models[0];
    if (!message || !model) throw new Error("missing public comparison fixture");
    message.content = "public-B";
    model.model = "public-other-model";
    view.values.params.max_tokens = 24;
    await act(async () => {
      hold.resolve(completed);
      await request;
    });
    expect(api.bodies(runEndpoint)).toEqual([
      {
        models: [{ model: "public-model" }],
        messages: [{ role: "user", content: "public-A" }],
        params: { max_tokens: 12 },
        save_prompt: false,
      },
    ]);
    expect(view.result.current.runPrompt).toBe("public-A");
    expect(view.result.current.run?.run_id).toBe("public-run-a");
  });

  it.each(["run", "predict"] as const)(
    "%s body 구성 중 세션이 바뀌면 실제 API 직전 재검사가 전송0을 보장한다",
    async (kind) => {
      const api = mockApi({
        [historyEndpoint]: () => ({ runs: [] }),
        [runEndpoint]: () => completed,
        "POST /admin/chat-test/multi-run/predict": () => ({}),
      });
      const view = setup(() => {
        tokenStore.clearAll();
        return undefined;
      });
      await act(async () => view.result.current.call(kind));
      expect(api.bodies(runEndpoint)).toHaveLength(0);
      expect(api.bodies("POST /admin/chat-test/multi-run/predict")).toHaveLength(0);
    },
  );

  it.each(["run", "predict"] as const)(
    "%s body 구성 중 권한이 회수되면 실제 API 직전 재검사가 전송0을 보장한다",
    async (kind) => {
      const api = mockApi({
        [historyEndpoint]: () => ({ runs: [] }),
        [runEndpoint]: () => completed,
        "POST /admin/chat-test/multi-run/predict": () => ({}),
      });
      let refresh: () => void = () => undefined;
      const view = setup(() => {
        runtime.write = false;
        flushSync(refresh);
        return undefined;
      });
      refresh = view.rerender;
      await act(async () => view.result.current.call(kind));
      expect(api.bodies(runEndpoint)).toHaveLength(0);
      expect(api.bodies("POST /admin/chat-test/multi-run/predict")).toHaveLength(0);
    },
  );

  it.each(["read", "raw"] as const)(
    "응답 대기 중 %s 회수는 이미 완료된 실행을 유지하고 새 이력 GET만 생략한다",
    async (permission) => {
      const hold = deferred<typeof completed>();
      const api = mockApi({ [historyEndpoint]: () => ({ runs: [] }), [runEndpoint]: () => hold.promise });
      const view = setup();
      await waitFor(() => expect(view.result.current.history.isSuccess).toBe(true));
      expect(api.calls.filter((call) => call.key === historyEndpoint)).toHaveLength(1);
      let request!: Promise<void>;
      act(() => {
        request = view.result.current.call("run");
      });
      runtime[permission] = false;
      view.rerender();
      await act(async () => {
        hold.resolve(completed);
        await request;
      });
      expect(view.result.current.run?.run_id).toBe("public-run-a");
      expect(view.result.current.error).toBeUndefined();
      expect(api.calls.filter((call) => call.key === historyEndpoint)).toHaveLength(1);
    },
  );
});
