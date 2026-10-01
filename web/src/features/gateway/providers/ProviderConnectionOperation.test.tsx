import { act, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderConnection } from "./use-provider-connection";
import {
  connectionEndpoint,
  connectionOutcome,
  connectionProvider,
} from "./provider-connection-test-harness";
import {
  providerEditSchema,
  providerFormValues,
  type ProviderFormInput,
  type ProviderFormOutput,
} from "./provider-form";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { FeatureAccess } from "@/shared/feature-access/policy";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import { tokenStore } from "@/shared/auth/token-store";
import { mockApi, apiFailure } from "@/test/api";

const auth = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: auth.scopes }) };
});
const writable: FeatureAccess = { featureId: "gateway.providers", permitted: true, readOnly: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Captured = {
  connection: ReturnType<typeof useProviderConnection>;
  form: ReturnType<typeof useZodForm<ProviderFormInput, ProviderFormOutput>>;
  guard: ReturnType<typeof useDraftGuard>;
};
function setup() {
  let current: Captured | undefined;
  function Inner() {
    const form = useZodForm<ProviderFormInput, ProviderFormOutput>(
      providerEditSchema(connectionProvider),
      providerFormValues(connectionProvider),
    );
    const guard = useDraftGuard({ dirty: form.formState.isDirty, onDiscard: () => undefined });
    const connection = useProviderConnection(form, connectionProvider, guard);
    useLayoutEffect(() => {
      current = { form, guard, connection };
    });
    return (
      <>
        <input aria-label="API 키" {...form.register("api_key")} />
        <output>{connection.result?.value.model_count ?? "결과 없음"}</output>
      </>
    );
  }
  function Harness({ access = writable, child = true }: { access?: FeatureAccess; child?: boolean }) {
    return (
      <FeatureAccessContext.Provider value={access}>
        <UnsavedChangesProvider>{child ? <Inner /> : null}</UnsavedChangesProvider>
      </FeatureAccessContext.Provider>
    );
  }
  const rendered = render(<Harness />);
  return {
    ...rendered,
    read: () => {
      if (!current) throw new Error("missing hook");
      return current;
    },
    access: (access: FeatureAccess) => rendered.rerender(<Harness access={access} />),
    remove: () => rendered.rerender(<Harness child={false} />),
  };
}
beforeEach(() => {
  auth.scopes = ["admin:read", "admin:write"];
});

describe("연결 테스트 실제 콜백 경계 (물리 클릭·실제 Go 증거 아님)", () => {
  it("동일 tick 중복과 저장은 한 draft flight에서 막는다", async () => {
    const gate = deferred<typeof connectionOutcome>();
    const api = mockApi({ [connectionEndpoint]: () => gate.promise });
    const view = setup();
    const old = view.read();
    const save = vi.fn(async () => undefined);
    act(() => {
      old.connection.run();
      old.connection.run();
      void old.guard.run(save, () => undefined);
    });
    await waitFor(() => expect(api.bodies(connectionEndpoint)).toHaveLength(1));
    expect(save).not.toHaveBeenCalled();
    await act(async () => gate.resolve(connectionOutcome));
    expect(await screen.findByText("2")).toBeVisible();
  });
  it.each(["readonly", "scope", "owner", "unpermitted"])(
    "검증 await 중 %s 변경 후 전송0, 복구 후 수동1",
    async (change) => {
      const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
      const view = setup();
      const gate = deferred<undefined>();
      const actual = view.read().form.trigger;
      const spy = vi.spyOn(view.read().form, "trigger").mockImplementationOnce(async (...args) => {
        await gate.promise;
        return actual(...args);
      });
      act(() => view.read().connection.run());
      expect(spy).toHaveBeenCalledOnce();
      if (change === "scope") {
        auth.scopes = ["admin:read"];
        view.access({ ...writable });
      } else
        view.access({
          ...writable,
          ...(change === "readonly"
            ? { readOnly: true }
            : change === "owner"
              ? { featureId: "gateway.models" }
              : { permitted: false }),
        });
      await act(async () => gate.resolve(undefined));
      expect(api.bodies(connectionEndpoint)).toHaveLength(0);
      auth.scopes = ["admin:read", "admin:write"];
      view.access({ ...writable });
      expect(api.bodies(connectionEndpoint)).toHaveLength(0);
      expect(view.read().guard.pending).toBe(false);
      expect(view.read().connection.phase).toBe("idle");
      act(() => view.read().connection.run());
      await waitFor(() => expect(api.bodies(connectionEndpoint)).toHaveLength(1));
    },
  );
  it("검증 동안 입력을 바꿨다가 원복해도 이전 admission은 폐기한다", async () => {
    const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
    const view = setup();
    const gate = deferred<undefined>();
    const actual = view.read().form.trigger;
    vi.spyOn(view.read().form, "trigger").mockImplementationOnce(async (...args) => {
      await gate.promise;
      return actual(...args);
    });
    act(() => view.read().connection.run());
    act(() => {
      view.read().form.setValue("api_key", "public-new-key");
      view.read().form.setValue("api_key", "");
    });
    await act(async () => gate.resolve(undefined));
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    act(() => view.read().connection.run());
    await waitFor(() => expect(api.bodies(connectionEndpoint)).toHaveLength(1));
  });
  it("본문 구성 중 세션이 바뀌어도 실제 API 직전 다시 막는다", async () => {
    const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
    const view = setup();
    const actual = view.read().form.getValues;
    vi.spyOn(view.read().form, "getValues").mockImplementationOnce((...args) => {
      const values = actual(...args);
      tokenStore.clearAll();
      return values;
    });
    act(() => view.read().connection.run());
    await waitFor(() => expect(view.read().guard.pending).toBe(false));
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
  });
  it.each(["readonly", "scope", "owner", "unpermitted"])(
    "전송 후 %s 회수 중 도착한 결과는 공개하지 않고 복구도 자동 실행하지 않는다",
    async (change) => {
      const gate = deferred<typeof connectionOutcome>();
      const api = mockApi({ [connectionEndpoint]: () => gate.promise });
      const view = setup();
      act(() => view.read().connection.run());
      await waitFor(() => expect(api.bodies(connectionEndpoint)).toHaveLength(1));
      if (change === "scope") {
        auth.scopes = ["admin:read"];
        view.access({ ...writable });
      } else
        view.access({
          ...writable,
          ...(change === "readonly"
            ? { readOnly: true }
            : change === "owner"
              ? { featureId: "gateway.models" }
              : { permitted: false }),
        });
      await act(async () => gate.resolve(connectionOutcome));
      expect(screen.getByText("결과 없음")).toBeVisible();
      auth.scopes = ["admin:read", "admin:write"];
      view.access({ ...writable });
      expect(api.bodies(connectionEndpoint)).toHaveLength(1);
      expect(view.read().guard.pending).toBe(false);
      expect(view.read().connection.phase).toBe("idle");
      act(() => view.read().connection.run());
      await waitFor(() => expect(api.bodies(connectionEndpoint)).toHaveLength(2));
      expect(await screen.findByText("2")).toBeVisible();
    },
  );
  it.each(["success", "failure"])("사라진 내부 폼의 늦은 %s와 이전 콜백은 부수효과0", async (outcome) => {
    const gate = deferred<typeof connectionOutcome>();
    const api = mockApi({ [connectionEndpoint]: () => gate.promise });
    const view = setup();
    const old = view.read().connection.run;
    act(() => old());
    await waitFor(() => expect(api.bodies(connectionEndpoint)).toHaveLength(1));
    view.remove();
    act(() => old());
    await act(async () => {
      if (outcome === "success") gate.resolve(connectionOutcome);
      else gate.reject(apiFailure("private raw error"));
    });
    expect(api.bodies(connectionEndpoint)).toHaveLength(1);
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });
});
