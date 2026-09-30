import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRunPanel } from "./ChatRunPanel";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write", "routing:read"] }) };
});

// Real direct fetch + controllable ReadableStream, not the apiClient mock. No
// provider is contacted and local abort is not evidence of server cancellation.
function response() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream", "X-Request-ID": "req_public_stream" },
    }),
    send(content: string) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
      );
    },
    close: () => controller.close(),
    cancel,
  };
}
const originalFetch = globalThis.fetch;
beforeEach(() => tokenStore.clearAll());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function setup(readOnly = false) {
  const api = mockApi({
    "GET /admin/chat-test/targets": () => ({ targets: [], grouped: {} }),
    "POST /admin/routing/preview": () => ({ requested_model: "vibe/auto", selected_model: "public-model" }),
    "POST /admin/code-verify": () => ({ risk: "none", block_count: 0, blocks: [] }),
  });
  let update: (value: boolean) => void = () => undefined;
  let updateWrite: (value: boolean) => void = () => undefined;
  function Host() {
    const [readonly, setReadonly] = useState(readOnly);
    const [write, setWrite] = useState(true);
    update = setReadonly;
    updateWrite = setWrite;
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "gateway.chat", permitted: true, readOnly: readonly }}
      >
        <ChatRunPanel canWrite={write} canPreviewRouting writeDeniedReason="admin:write 권한이 필요합니다." />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  await screen.findByLabelText("테스트 대상");
  return {
    ...view,
    api,
    user: userEvent.setup(),
    readonly: (value: boolean) => act(() => update(value)),
    write: (value: boolean) => act(() => updateWrite(value)),
  };
}

describe("단일 채팅 실제 전송·수신 경계", () => {
  it("runtime readonly는 실제 fetch를 막으며 작성한 프롬프트를 유지한다", async () => {
    const stream = response();
    const fetch = vi.fn(async () => stream.response);
    globalThis.fetch = fetch;
    const view = await setup(true);
    const prompt = screen.getByLabelText(/^프롬프트/u);
    await view.user.clear(prompt);
    await view.user.type(prompt, "유지할 공개 입력");
    const send = screen.getByRole("button", { name: /Chat 호출|모델 호출/u });
    expect(send).toBeDisabled();
    expect(prompt).toHaveValue("유지할 공개 입력");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("같은 tick의 실제 클릭 두 번은 하나의 fetch만 시작한다", async () => {
    const first = response(),
      second = response();
    let calls = 0;
    const fetch = vi.fn(async () => (calls++ === 0 ? first.response : second.response));
    globalThis.fetch = fetch;
    await setup();
    const send = screen.getByRole("button", { name: /Chat 호출|모델 호출/u });
    act(() => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("readonly로 바뀌어도 이미 시작한 응답을 읽고 수동 수신중단을 제공한다", async () => {
    const stream = response();
    globalThis.fetch = vi.fn(async () => stream.response);
    const view = await setup();
    await view.user.click(screen.getByRole("button", { name: /Chat 호출|모델 호출/u }));
    await act(async () => stream.send("공개 부분 응답"));
    view.readonly(true);
    await act(async () => stream.send(" 이어 받음"));
    expect(screen.getByText("공개 부분 응답 이어 받음")).toBeVisible();
    const stop = screen.getByRole("button", { name: "응답 수신 중단" });
    expect(stop).toBeEnabled();
    await view.user.click(stop);
    await waitFor(() => expect(stream.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByText("공개 부분 응답 이어 받음")).toBeVisible();
    expect(screen.getByText(/공급자의 실행이나 비용 발생이 중단된다는 뜻은 아닙니다/u)).toBeVisible();
  });
  it("같은 Host의 새 세션은 이전 스트림과 민감한 입력 상태를 버리고 늦은 수신을 격리한다", async () => {
    const stream = response();
    globalThis.fetch = vi.fn(async () => stream.response);
    const view = await setup();
    await view.user.type(screen.getByLabelText("프록시 인증 토큰 (Bearer)"), "public-sensitive-input");
    await view.user.click(screen.getByRole("button", { name: /Chat 호출|모델 호출/u }));
    await act(async () => stream.send("이전 계정 공개 응답"));
    act(() => tokenStore.clearAll());
    await waitFor(() => expect(screen.queryByText("이전 계정 공개 응답")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "응답 수신 중단" })).not.toBeInTheDocument();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("프록시 인증 토큰 (Bearer)")).toHaveValue("");
  });
  it.each(["readonly", "scope"])(
    "%s Enter는 이유를 입력옆에 설명하고 복구 뒤 수동 Enter만 전송한다",
    async (boundary) => {
      const first = response(),
        second = response();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(second.response);
      globalThis.fetch = fetch;
      const view = await setup();
      await view.user.click(screen.getByRole("button", { name: "모델 호출" }));
      await act(async () => {
        first.send("공개 첫 응답");
        first.close();
      });
      const followup = screen.getByLabelText("이어서 질문");
      await view.user.type(followup, "보존할 이어질문");
      if (boundary === "readonly") view.readonly(true);
      else view.write(false);
      expect(followup).toBeEnabled();
      expect(followup).toHaveAccessibleDescription(
        boundary === "readonly"
          ? "읽기 전용에서는 새 질문을 전송할 수 없습니다. 입력은 유지됩니다."
          : "새 질문 전송에는 admin:write 권한이 필요합니다. 입력은 유지됩니다.",
      );
      await view.user.type(followup, "{Enter}");
      expect(followup).toHaveValue("보존할 이어질문");
      expect(fetch).toHaveBeenCalledTimes(1);
      view.readonly(false);
      view.write(true);
      expect(followup).not.toHaveAccessibleDescription();
      expect(fetch).toHaveBeenCalledTimes(1);
      await view.user.type(followup, "{Enter}");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(followup).toHaveValue("");
      await act(async () => second.close());
    },
  );
  it("단일 readonly는 기존 routing:read 미리보기와 admin:write 코드검증의 실제 API 호출을 유지한다", async () => {
    const stream = response();
    globalThis.fetch = vi.fn(async () => stream.response);
    const view = await setup();
    await view.user.click(screen.getByRole("button", { name: "모델 호출" }));
    await act(async () => {
      stream.send("공개 응답");
      stream.close();
    });
    view.readonly(true);
    await view.user.click(screen.getByRole("button", { name: "라우팅 미리보기" }));
    await screen.findByText("선택 모델");
    await view.user.click(screen.getByRole("button", { name: "코드 검증" }));
    await screen.findByText("코드 검증 결과");
    expect(view.api.bodies("POST /admin/routing/preview")).toHaveLength(1);
    expect(view.api.bodies("POST /admin/code-verify")).toEqual([{ text: "공개 응답" }]);
    view.write(false);
    expect(screen.getByRole("button", { name: "코드 검증" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "라우팅 미리보기" })).toBeEnabled();
  });
});
