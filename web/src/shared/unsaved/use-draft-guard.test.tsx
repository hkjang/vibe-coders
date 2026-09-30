import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { UnsavedChangesContext } from "@/shared/unsaved/context";
import { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";

function setup({
  keepMounted = false,
  onDiscard = vi.fn(),
}: { keepMounted?: boolean; onDiscard?: () => void } = {}) {
  const coordinator = new UnsavedChangesCoordinator();
  const wrapper = ({ children }: PropsWithChildren) => (
    <UnsavedChangesContext value={coordinator}>{children}</UnsavedChangesContext>
  );
  return {
    coordinator,
    onDiscard,
    ...renderHook(() => useDraftGuard({ dirty: true, keepMounted, onDiscard }), { wrapper }),
  };
}

describe("useDraftGuard inline 확장", () => {
  it("기존 zero-argument 폐기 callback과 성공 시 닫기를 그대로 유지한다", async () => {
    const { result, onDiscard, coordinator } = setup();
    const operation = vi.fn(async () => "saved");
    await act(async () => result.current.run(operation, vi.fn()));
    expect(operation).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledWith("close");
    // A mounted dirty fixture re-registers on render, as real editors do. No
    // stale submission may remain pending after the default close callback.
    expect(coordinator.getSnapshot().pending).toBe(false);
  });

  it("인라인 성공은 닫지 않고 현재 세대 결과를 전달하며 동일 tick flight는 하나다", async () => {
    const { result, onDiscard, coordinator } = setup({ keepMounted: true });
    let finish!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const saved = vi.fn();
    let first!: Promise<void>;
    act(() => {
      first = result.current.run(operation, vi.fn(), saved);
      void result.current.run(operation, vi.fn(), saved);
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().pending).toBe(true);
    await act(async () => {
      finish("accepted");
      await first;
    });
    expect(saved).toHaveBeenCalledWith("accepted");
    expect(onDiscard).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().pending).toBe(false);
  });

  it("승인된 로컬 폐기만 owner를 즉시 재등록해 후속 조회를 시작한다", async () => {
    const { result, coordinator } = setup({ keepMounted: true });
    const read = vi.fn(async () => "fresh");
    const saved = vi.fn();
    act(() =>
      result.current.requestClose(() => {
        void result.current.run(read, vi.fn(), saved);
      }),
    );
    expect(read).not.toHaveBeenCalled();
    await act(async () => coordinator.discardConfirmed());
    expect(read).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith("fresh");
  });

  it("보안 폐기는 로컬 continuation을 실행하지 않는다", () => {
    const { result, coordinator, onDiscard } = setup({ keepMounted: true });
    const continuation = vi.fn();
    act(() => result.current.requestClose(continuation));
    act(() => coordinator.discardForSecurity());
    expect(continuation).not.toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalledWith("security");
  });

  it("보안 폐기 뒤 늦은 inline 성공은 결과를 전달하지 않는다", async () => {
    const { result, coordinator } = setup({ keepMounted: true });
    let finish!: (value: string) => void;
    const saved = vi.fn();
    let running!: Promise<void>;
    act(() => {
      running = result.current.run(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        vi.fn(),
        saved,
      );
    });
    act(() => coordinator.discardForSecurity());
    await act(async () => {
      finish("old");
      await running;
    });
    expect(saved).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().pending).toBe(false);
  });

  it("unmount 후 resolve는 callback이나 등록을 되살리지 않는다", async () => {
    const { result, coordinator, unmount } = setup({ keepMounted: true });
    let finish!: (value: string) => void;
    const saved = vi.fn();
    let running!: Promise<void>;
    act(() => {
      running = result.current.run(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        vi.fn(),
        saved,
      );
    });
    unmount();
    await act(async () => {
      finish("old");
      await running;
    });
    expect(saved).not.toHaveBeenCalled();
    expect(coordinator.shouldBlock()).toBe(false);
  });
});
