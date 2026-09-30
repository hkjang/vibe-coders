import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyFitnessForm, fitnessKey } from "./skill-fitness-state";
import { useSkillFitnessEditor } from "./use-skill-fitness-editor";
import { tokenStore } from "@/shared/auth/token-store";
import { UnsavedChangesContext } from "@/shared/unsaved/context";
import { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";

const access = vi.hoisted(() => ({ write: true }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: access.write ? ["admin:read", "admin:write"] : ["admin:read"] }),
  };
});
const data = { skill: "skill", evidence: [], passing_count: 0, required: 2 };
const post = "POST /admin/skills/fitness";
const values = { ...emptyFitnessForm, ref_id: "reference" };
beforeEach(() => {
  access.write = true;
  tokenStore.clearAll();
  toast.success.mockClear();
});
function setup(write: ApiHandler = () => ({ skill_name: "skill" })) {
  const api = mockApi({ [post]: write });
  // The direct hook has no query observer; retain its injected prerequisite
  // while deferred mutations exercise the instance/session boundary.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const coordinator = new UnsavedChangesCoordinator();
  client.setQueryData(fitnessKey("skill", tokenStore.getSessionEpoch()), data);
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <UnsavedChangesContext.Provider value={coordinator}>{children}</UnsavedChangesContext.Provider>
      </QueryClientProvider>
    );
  }
  const hook = renderHook(() => useSkillFitnessEditor(), { wrapper: Wrapper });
  act(() =>
    hook.result.current.open({ name: "skill", description: "original" }, document.createElement("button")),
  );
  const target = hook.result.current.target;
  if (!target) throw new Error("missing fitness draft");
  return { ...hook, target, api, client, coordinator };
}
describe("스킬 근거 실제 제출 경계", () => {
  it("대상이 다른 성공 응답은 새 기록을 재전송하거나 완료로 알리지 않는다", async () => {
    const { result, target, api, client } = setup(() => ({ skill_name: "other" }));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await expect(result.current.submit(target, values)).rejects.toMatchObject({ kind: "contract" });
    });
    expect(api.bodies(post)).toHaveLength(1);
    expect(result.current.target).toBe(target);
    expect(result.current.pending).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("고정 스킬·기준·인스턴스를 다른 스킬로 재지정할 수 없다", async () => {
    const { result, target, client, api } = setup();
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.skill)).toBe(true);
    expect(Object.isFrozen(target.baseline)).toBe(true);
    act(() => client.setQueryData(fitnessKey("skill", target.epoch), { ...data, required: 3 }));
    expect(target.baseline.required).toBe(2);
    await expect(
      result.current.submit({ ...target, skill: { name: "other" } }, values),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(api.bodies(post)).toEqual([]);
  });
  it.each(["permission", "invalidation", "identity", "malformed", "session"])(
    "최신 %s가 달라지면 직접 submit도 전송하지 않는다",
    async (boundary) => {
      const { result, target, rerender, client, api } = setup();
      const submit = result.current.submit;
      if (boundary === "permission") {
        access.write = false;
        rerender();
      }
      await act(async () => {
        if (boundary === "invalidation")
          await client.invalidateQueries({
            queryKey: fitnessKey("skill", target.epoch),
            refetchType: "none",
          });
        if (boundary === "identity")
          client.setQueryData(fitnessKey("skill", target.epoch), { ...data, skill: "other" });
        if (boundary === "malformed")
          client.setQueryData(fitnessKey("skill", target.epoch), { ...data, evidence: null });
        if (boundary === "session") tokenStore.clearAll();
        await expect(submit(target, values)).rejects.toBeDefined();
      });
      expect(api.bodies(post)).toEqual([]);
    },
  );
  it("동기 중복·pending 부모 닫기·다른 폼 열기를 막고 body를 고정한다", async () => {
    let resolve!: (value: unknown) => void;
    const { result, target, api } = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const input = { ...values, note: "처음 초안" };
    let flight!: Promise<void>;
    act(() => {
      flight = result.current.submit(target, input);
    });
    input.note = "변경된 초안";
    await expect(result.current.submit(target, values)).rejects.toMatchObject({ kind: "aborted" });
    const leave = vi.fn();
    act(() => {
      result.current.requestLeave(leave);
      result.current.open({ name: "other" }, document.createElement("button"));
    });
    expect(leave).not.toHaveBeenCalled();
    expect(result.current.target).toBe(target);
    expect(api.bodies(post)).toEqual([{ skill: "skill", ...values, score: 0, note: "처음 초안" }]);
    expect(Object.isFrozen(api.bodies(post)[0])).toBe(true);
    await act(async () => {
      resolve({ skill_name: "skill" });
      await flight;
    });
  });
  it.each(["same-session-success", "same-session-error", "new-session-success", "new-session-error"])(
    "이전 %s는 새 초안·toast·query·새 flight를 바꾸지 않는다",
    async (outcome) => {
      const completions: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
      const { result, target, client } = setup(
        () => new Promise((resolve, reject) => completions.push({ resolve, reject })),
      );
      let old!: Promise<void>;
      act(() => {
        old = result.current.submit(target, values);
      });
      const caught = old.catch(() => undefined);
      act(() => {
        if (outcome.startsWith("new-session")) tokenStore.clearAll();
        else result.current.close(target.instance);
      });
      act(() => {
        client.setQueryData(fitnessKey("skill", tokenStore.getSessionEpoch()), data);
        result.current.open({ name: "skill" }, document.createElement("button"));
      });
      const newer = result.current.target;
      if (!newer) throw new Error("missing fresh draft");
      expect(newer.instance).not.toBe(target.instance);
      let fresh!: Promise<void>;
      act(() => {
        fresh = result.current.submit(newer, { ...values, ref_id: "new reference" });
      });
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        if (outcome.endsWith("error")) completions[0]?.reject(apiFailure("old failure"));
        else completions[0]?.resolve({ skill_name: "skill" });
        await caught;
      });
      expect(result.current.target).toBe(newer);
      expect(result.current.pending).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      await expect(result.current.submit(newer, values)).rejects.toMatchObject({ kind: "aborted" });
      await act(async () => {
        completions[1]?.resolve({ skill_name: "skill" });
        await fresh;
      });
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(result.current.pending).toBe(false);
    },
  );
  it("부모 keep 이후 직접 취소는 이전 부모 행동을 재개하지 않는다", () => {
    const { result, target, coordinator } = setup();
    const leave = vi.fn();
    act(() => result.current.setDirty(true));
    act(() => result.current.requestLeave(leave));
    expect(coordinator.getSnapshot().confirmation).toBeDefined();
    act(() => coordinator.keepEditing());
    act(() => result.current.close(target.instance));
    expect(leave).not.toHaveBeenCalled();
  });
  it.each([" skill", "skill ", "\ufeffskill", "\u0085skill", "skill\u0085"])(
    "기존 %j 대상은 확정 DTO를 주입해도 열지 않는다",
    (name) => {
      const { result, target, client } = setup();
      act(() => result.current.close(target.instance));
      act(() => {
        client.setQueryData(fitnessKey(name, target.epoch), { ...data, skill: name });
        result.current.open({ name }, document.createElement("button"));
      });
      expect(result.current.target).toBeUndefined();
    },
  );
});
