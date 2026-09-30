import { act } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runActionDefaults,
  type RunActionKind,
  type RunActionSnapshot,
  type RunActionValues,
} from "./run-action-state";
import { useCompareAccess } from "./use-compare-access";
import { useRunActionSubmit } from "./use-run-action-submit";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastSpy }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
beforeEach(() => {
  tokenStore.clearAll();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(kind: RunActionKind, respond: () => unknown = () => ({ status: "saved" })) {
  const target: RunActionSnapshot = {
    kind,
    runId: "public-run-a",
    models: ["public-model"],
    prompt: "공개 실행 A",
  };
  const values = { ...runActionDefaults(target), reason: "공개 사유", workflow_name: "공개 워크플로" };
  const api = mockApi({ [`POST /admin/chat-test/multi-run/runs/public-run-a/${kind}`]: respond });
  let submit!: (input: RunActionValues) => Promise<void>;
  type State = { allowed: boolean; readOnly: boolean; owner: string; known: boolean; replacement: boolean };
  let update!: (next: Partial<State>) => void;
  function Probe({ state }: { state: State }) {
    const access = useCompareAccess(state.allowed, "현재 쓰기 권한이 없습니다.");
    const callback = useRunActionSubmit(
      state.replacement ? { ...target, runId: "public-run-c", prompt: "공개 실행 C" } : target,
      access,
    );
    useLayoutEffect(() => {
      submit = callback;
    });
    return null;
  }
  function Host() {
    const [state, setState] = useState<State>({
      allowed: true,
      readOnly: false,
      owner: "gateway.chat",
      known: true,
      replacement: false,
    });
    update = (next) => setState((old) => ({ ...old, ...next }));
    return (
      <FeatureAccessContext.Provider
        value={
          state.known ? { featureId: state.owner, permitted: true, readOnly: state.readOnly } : undefined
        }
      >
        <Probe state={state} />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return {
    api,
    values,
    view,
    captured: submit,
    latest: () => submit,
    update: (value: Partial<State>) => act(() => update(value)),
  };
}

// Calls the actual submission callback, not a disabled DOM control. mockApi does
// not enforce permissions and is not evidence of the real authenticated Go API.
describe("실행 후 저장의 실제 전송 경계", () => {
  for (const kind of ["feedback", "promote", "golden"] as const) {
    for (const boundary of ["readonly", "scope", "owner", "missing", "epoch", "unmount"] as const) {
      it(`${kind}: captured callback ${boundary} 변경 뒤 API 0`, async () => {
        const current = setup(kind);
        if (boundary === "readonly") current.update({ readOnly: true });
        if (boundary === "scope") current.update({ allowed: false });
        if (boundary === "owner") current.update({ owner: "gateway.models" });
        if (boundary === "missing") current.update({ known: false });
        if (boundary === "epoch") act(() => tokenStore.clearAll());
        if (boundary === "unmount") current.view.unmount();
        await expect(current.captured(current.values)).rejects.toMatchObject({
          kind: expect.stringMatching(/permission|aborted/u),
        });
        expect(current.api.calls).toHaveLength(0);
        expect(toastSpy.success).not.toHaveBeenCalled();
        expect(toastSpy.error).not.toHaveBeenCalled();
        if (boundary === "readonly" || boundary === "scope") {
          current.update({ readOnly: false, allowed: true });
          expect(current.api.calls).toHaveLength(0);
          await current.captured(current.values);
          expect(current.api.calls).toHaveLength(1);
        }
      });
    }

    it(`${kind}: same-tick 중복 1회, 이미 전송된 readonly 성공은 사실대로 완료`, async () => {
      const response = deferred<unknown>();
      const current = setup(kind, () => response.promise);
      const first = current.captured(current.values);
      await expect(current.captured(current.values)).rejects.toMatchObject({ kind: "aborted" });
      expect(current.api.calls).toHaveLength(1);
      current.update({ readOnly: true, allowed: false });
      response.resolve({ status: "saved" });
      await first;
      expect(toastSpy.success).toHaveBeenCalledTimes(1);
      await expect(current.latest()(current.values)).rejects.toMatchObject({ kind: "permission" });
      expect(current.api.calls).toHaveLength(1);
    });

    it(`${kind}: 새로운 props에도 immutable 실행 A만 저장하고 없는 모델 거부`, async () => {
      const current = setup(kind);
      current.update({ replacement: true });
      await expect(current.latest()({ ...current.values, model: "public-model-c" })).rejects.toMatchObject({
        kind: "contract",
      });
      expect(current.api.calls).toHaveLength(0);
      await current.latest()(current.values);
      expect(current.api.calls).toHaveLength(1);
      if (kind === "golden")
        expect(current.api.calls[0]?.options.body).toMatchObject({ prompt: "공개 실행 A" });
    });

    it(`${kind}: body 구성 도중 세션 변경도 실제 API 전에 차단한다`, async () => {
      const current = setup(kind);
      const values = { ...current.values };
      const key = kind === "feedback" ? "comment" : kind === "promote" ? "reason" : "expected";
      Object.defineProperty(values, key, {
        get: () => {
          tokenStore.clearAll();
          return "공개 값";
        },
      });
      await act(async () => {
        await expect(current.captured(values)).rejects.toMatchObject({ kind: "aborted" });
      });
      expect(current.api.calls).toHaveLength(0);
      expect(toastSpy.success).not.toHaveBeenCalled();
    });

    for (const outcome of ["success", "failure"] as const) {
      for (const boundary of ["epoch", "owner", "unmount"] as const) {
        it(`${kind}: ${boundary} 뒤 늦은 ${outcome}는 toast 없이 폐기`, async () => {
          const response = deferred<unknown>();
          const current = setup(kind, () => response.promise);
          const first = current.captured(current.values);
          const result = expect(first).rejects.toMatchObject({ kind: "aborted" });
          if (boundary === "epoch") act(() => tokenStore.clearAll());
          if (boundary === "owner") current.update({ owner: "gateway.models" });
          if (boundary === "unmount") current.view.unmount();
          if (outcome === "success") response.resolve({ status: "saved" });
          else response.reject(apiFailure("공개 합성 실패", 503, "public-old-request"));
          await result;
          expect(current.api.calls).toHaveLength(1);
          expect(toastSpy.success).not.toHaveBeenCalled();
          expect(toastSpy.error).not.toHaveBeenCalled();
        });
      }
    }
  }
});
