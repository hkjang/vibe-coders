import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestNoteDefaults, requestNoteKey } from "./request-note-state";
import { useRequestNoteEditor } from "./use-request-note-editor";
import { tokenStore } from "@/shared/auth/token-store";
import { UnsavedChangesContext } from "@/shared/unsaved/context";
import { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";

const access = vi.hoisted(() => ({ write: true, version: "v0.86.16", readOnly: false }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        backendVersion: access.version,
        scopes: access.write ? ["admin:read", "admin:write"] : ["admin:read"],
      }),
  };
});
const note = {
  request_id: "req-1",
  note: "기존",
  tags: ["태그"],
  created_by: "admin_synthetic",
  updated_at: "2026-01-01T00:00:00Z",
  exists: true,
  redacted_fields: [],
};
const put = "PATCH /admin/requests/req-1/note",
  remove = "DELETE /admin/requests/req-1/note";
beforeEach(() => {
  access.write = true;
  access.readOnly = false;
  access.version = "v0.86.16";
  tokenStore.clearAll();
  toast.success.mockClear();
});
function setup(write: ApiHandler = () => note) {
  const api = mockApi({ [put]: write, [remove]: write });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const coordinator = new UnsavedChangesCoordinator();
  client.setQueryData(requestNoteKey("req-1", tokenStore.getSessionEpoch()), note);
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <FeatureAccessHarness featureId="observability.llm" readOnly={access.readOnly}>
          <UnsavedChangesContext.Provider value={coordinator}>{children}</UnsavedChangesContext.Provider>
        </FeatureAccessHarness>
      </QueryClientProvider>
    );
  }
  const hook = renderHook(() => useRequestNoteEditor(), { wrapper: Wrapper });
  act(() => hook.result.current.open("req-1", "edit", document.createElement("button")));
  const target = hook.result.current.target;
  if (!target) throw new Error("missing note draft");
  return { ...hook, target, api, client, coordinator };
}
describe("요청 메모 실제 제출 경계", () => {
  it("고정 baseline과 대상은 깊게 분리·동결되고 다른 tuple로 재지정할 수 없다", async () => {
    const { result, target, client, api } = setup();
    expect(target.baseline).not.toBe(client.getQueryData(requestNoteKey("req-1", target.epoch)));
    expect(target.baseline.tags).not.toBe(note.tags);
    expect(Object.isFrozen(target.baseline.tags)).toBe(true);
    expect(Object.isFrozen(target)).toBe(true);
    await expect(
      result.current.submit({ ...target, requestId: "req-2" }, requestNoteDefaults(note)),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(api.bodies(put)).toEqual([]);
  });
  it.each(["permission", "readonly", "version", "invalidation", "identity", "session"])(
    "최신 %s가 달라지면 직접 호출도 쓰지 않는다",
    async (boundary) => {
      const { result, target, rerender, client, api } = setup();
      const submit = result.current.submit;
      if (boundary === "permission") {
        access.write = false;
        rerender();
      }
      if (boundary === "readonly") {
        access.readOnly = true;
        rerender();
      }
      if (boundary === "version") {
        access.version = "v0.86.15";
        rerender();
      }
      await act(async () => {
        if (boundary === "invalidation")
          await client.invalidateQueries({
            queryKey: requestNoteKey("req-1", target.epoch),
            refetchType: "none",
          });
        if (boundary === "identity")
          client.setQueryData(requestNoteKey("req-1", target.epoch), { ...note, request_id: "req-2" });
        if (boundary === "session") tokenStore.clearAll();
        await expect(submit(target, requestNoteDefaults(note))).rejects.toBeDefined();
      });
      expect(api.bodies(put)).toEqual([]);
    },
  );
  it("동기 중복과 pending 부모 닫기를 막고 PATCH 동안 DELETE를 열 수 없다", async () => {
    let resolve!: (value: unknown) => void;
    const { result, target, api } = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let flight!: Promise<void>;
    act(() => {
      flight = result.current.submit(target, requestNoteDefaults(note));
    });
    await expect(result.current.submit(target, requestNoteDefaults(note))).rejects.toMatchObject({
      kind: "aborted",
    });
    const leave = vi.fn();
    act(() => {
      result.current.requestLeave(leave);
      result.current.open("req-1", "delete", document.createElement("button"));
    });
    expect(leave).not.toHaveBeenCalled();
    expect(result.current.target).toBe(target);
    expect(api.bodies(put)).toHaveLength(1);
    expect(api.bodies(remove)).toEqual([]);
    await act(async () => {
      resolve(note);
      await flight;
    });
  });
  it.each([false, true])(
    "새 세션 초안 뒤 늦은 응답(error=%s)은 새 초안·조회·toast를 건드리지 않는다",
    async (failure) => {
      let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
      const { result, target, client } = setup(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          }),
      );
      let flight!: Promise<void>;
      act(() => {
        flight = result.current.submit(target, requestNoteDefaults(note));
      });
      const caught = flight.catch(() => undefined);
      act(() => tokenStore.clearAll());
      act(() => {
        client.setQueryData(requestNoteKey("req-1", tokenStore.getSessionEpoch()), note);
        result.current.open("req-1", "edit", document.createElement("button"));
      });
      const newer = result.current.target;
      if (!newer) throw new Error("missing new session draft");
      expect(newer.epoch).not.toBe(target.epoch);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        if (failure) reject(apiFailure("old error"));
        else resolve(note);
        await caught;
      });
      expect(result.current.target).toBe(newer);
      expect(result.current.pending).toBe(false);
      expect(invalidate).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    },
  );
  it("부모 keep 뒤 공통 form close는 과거 부모 동작을 재개하지 않는다", () => {
    const { result, coordinator, target } = setup();
    const leave = vi.fn();
    act(() => result.current.setDirty(true));
    act(() => result.current.requestLeave(leave));
    expect(coordinator.getSnapshot().confirmation).toBeDefined();
    act(() => coordinator.keepEditing());
    act(() => result.current.close(target.instance));
    expect(leave).not.toHaveBeenCalled();
    expect(result.current.target).toBeUndefined();
  });
});
