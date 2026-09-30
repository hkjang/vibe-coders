import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlledChatResponse, deferred } from "./chat-stream-test-support";
import { useChatAccess } from "./use-chat-access";
import { useChatRun } from "./use-chat-run";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { ChatTestRunBody } from "@/shared/api/domains/gateway";

const originalFetch = globalThis.fetch;
beforeEach(() => tokenStore.clearAll());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setup(makeBody?: (messages: ReadonlyArray<{ role: string; content: string }>) => ChatTestRunBody) {
  const policy = {
    owner: "gateway.chat",
    permitted: true,
    readOnly: false,
    write: true,
    preview: true,
    missing: false,
  };
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <FeatureAccessContext.Provider
        value={
          policy.missing
            ? undefined
            : { featureId: policy.owner, permitted: policy.permitted, readOnly: policy.readOnly }
        }
      >
        {children}
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderHook(
    () => {
      const access = useChatAccess(policy.write, policy.preview, "admin:write 권한이 필요합니다.");
      return useChatRun(access, makeBody ?? ((messages) => ({ model: "public-model", messages })));
    },
    { wrapper: Wrapper },
  );
  return { ...view, policy };
}

describe("실제 단일 send callback과 direct fetch 경계", () => {
  it.each(["readonly", "permission", "owner", "missing", "permitted", "session"])(
    "캡처된 send도 최신 %s에서 false/0fetch이고 복구 뒤 수동1",
    async (boundary) => {
      const stream = controlledChatResponse();
      const fetch = vi.fn(async () => stream.response);
      globalThis.fetch = fetch;
      const view = setup(),
        send = view.result.current.send;
      if (boundary === "readonly") view.policy.readOnly = true;
      if (boundary === "permission") view.policy.write = false;
      if (boundary === "owner") view.policy.owner = "gateway.models";
      if (boundary === "missing") view.policy.missing = true;
      if (boundary === "permitted") view.policy.permitted = false;
      if (boundary === "session") act(() => tokenStore.clearAll());
      view.rerender();
      act(() => expect(send("보존할 입력")).toBe(false));
      expect(fetch).not.toHaveBeenCalled();
      expect(view.result.current.turns).toEqual([]);
      Object.assign(view.policy, {
        owner: "gateway.chat",
        permitted: true,
        readOnly: false,
        write: true,
        missing: false,
      });
      view.rerender();
      expect(fetch).not.toHaveBeenCalled();
      act(() => expect(view.result.current.send("수동 복구")).toBe(true));
      expect(fetch).toHaveBeenCalledTimes(1);
      await act(async () => stream.finish());
    },
  );
  it("동기 중복은 한 flight만 허가하고 body를 한 번만 만든다", async () => {
    const stream = controlledChatResponse(),
      body = vi.fn((messages) => ({ model: "public-model", messages }));
    const fetch = vi.fn(async () => stream.response);
    globalThis.fetch = fetch;
    const view = setup(body),
      send = view.result.current.send;
    act(() => {
      expect(send("첫 입력")).toBe(true);
      expect(send("중복 입력")).toBe(false);
    });
    expect(body).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => stream.finish());
  });
  it.each(["throw", "session"])("body 준비 %s는 승인 false/입력 이력0/전송0", (boundary) => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    const view = setup((messages) => {
      if (boundary === "throw") throw new Error("public body preparation failure");
      tokenStore.clearAll();
      return { model: "public-model", messages };
    });
    act(() => expect(view.result.current.send("아직 허가되지 않은 입력")).toBe(false));
    expect(fetch).not.toHaveBeenCalled();
    expect(view.result.current.turns).toEqual([]);
    expect(view.result.current.streaming).toBe(false);
  });
  it("unmount 뒤 캡처된 send는 전송하지 않는다", () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    const view = setup(),
      send = view.result.current.send;
    view.unmount();
    expect(send("폐기된 화면 입력")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("readonly와 쓰기권한 철회는 admitted 부분 응답·추론·헤더·사용량의 정상 완료를 막지 않는다", async () => {
    const stream = controlledChatResponse();
    const fetch = vi.fn(async () => stream.response);
    globalThis.fetch = fetch;
    const view = setup();
    act(() => view.result.current.send("공개 입력"));
    await act(async () => stream.chunk("첫 응답", "첫 추론", 4));
    Object.assign(view.policy, { readOnly: true, write: false });
    view.rerender();
    await act(async () => {
      stream.chunk(" 마지막", " 이후", 9);
      stream.finish();
    });
    expect(view.result.current.turns.at(-1)).toMatchObject({
      content: "첫 응답 마지막",
      reasoning: "첫 추론 이후",
      pending: false,
    });
    expect(view.result.current.usage.total).toBe(9);
    expect(view.result.current.headers["x-public-trace"]).toBe("public-diagnostic");
    expect(view.result.current.error).toBeUndefined();
    expect(view.result.current.streaming).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "중단한 old fetch 실패=%s의 finally는 새 수신·상태를 건드리지 않는다",
    async (failure) => {
      const old = deferred<Response>(),
        first = controlledChatResponse("old-header"),
        next = controlledChatResponse("new-header");
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValueOnce(next.response);
      globalThis.fetch = fetch;
      const view = setup();
      act(() => view.result.current.send("이전 요청"));
      act(() => view.result.current.stop());
      act(() => expect(view.result.current.send("새 요청")).toBe(true));
      await act(async () => next.chunk("새 부분", "새 추론", 7));
      await act(async () => {
        if (failure) old.reject(new Error("old network"));
        else old.resolve(first.response);
      });
      expect(view.result.current.streaming).toBe(true);
      expect(view.result.current.error).toBeUndefined();
      expect(view.result.current.headers["x-public-trace"]).toBe("new-header");
      expect(view.result.current.usage.total).toBe(7);
      expect(view.result.current.turns.at(-1)).toMatchObject({
        content: "새 부분",
        reasoning: "새 추론",
        pending: true,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      if (!failure) expect(first.cancel).toHaveBeenCalledTimes(1);
      await act(async () => {
        next.chunk(" 완료");
        next.finish();
      });
      expect(view.result.current.streaming).toBe(false);
    },
  );
  it.each(["session", "owner", "unmount"])(
    "%s 뒤 늦은 chunk와 실패는 state callback에 도달하지 않는다",
    async (boundary) => {
      const stream = controlledChatResponse();
      globalThis.fetch = vi.fn(async () => stream.response);
      const view = setup();
      act(() => view.result.current.send("공개 요청"));
      await act(async () => stream.chunk("현재 응답", "현재 추론", 4));
      const baseline = view.result.current;
      if (boundary === "session") act(() => tokenStore.clearAll());
      if (boundary === "owner") {
        view.policy.owner = "gateway.models";
        view.rerender();
      }
      if (boundary === "unmount") view.unmount();
      if (boundary !== "unmount")
        await act(async () => {
          stream.chunk("오래된 chunk", "오래된 추론", 999);
          stream.fail(new Error("old failure"));
        });
      else await waitFor(() => expect(stream.cancel).toHaveBeenCalledTimes(1));
      expect(view.result.current.turns).toEqual(baseline.turns);
      expect(view.result.current.usage).toEqual(baseline.usage);
      expect(view.result.current.error).toBeUndefined();
    },
  );
});
