import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { meKeyLifecycle } from "./me-key-lifecycle";
import { useKeyExpiryClock } from "./use-key-expiry-clock";

const now = Date.parse("2026-10-13T00:00:00Z");
const key = apiKeyPublicSchema.parse({ id: "fixture", status: "active" });
afterEach(() => vi.useRealTimers());

it("distinguishes expiry, grace, retirement and invalid deadlines without trusting active status", () => {
  expect(meKeyLifecycle(key, now)).toMatchObject({ usable: true, label: "사용", days: undefined });
  expect(meKeyLifecycle({ ...key, expires_at: new Date(now).toISOString() }, now)).toMatchObject({
    usable: false,
    label: "만료",
  });
  const rotating = { ...key, replaced_by: "next", grace_ends_at: new Date(now + 1000).toISOString() };
  expect(meKeyLifecycle(rotating, now)).toMatchObject({ usable: true, label: "교체 유예 중", days: 1 });
  expect(meKeyLifecycle(rotating, now + 1000)).toMatchObject({ usable: false, label: "유예 종료" });
  expect(meKeyLifecycle({ ...rotating, expires_at: new Date(now).toISOString() }, now).usable).toBe(false);
  for (const invalid of [
    { ...key, expires_at: "invalid" },
    { ...rotating, grace_ends_at: "" },
  ]) {
    expect(meKeyLifecycle(invalid, now)).toMatchObject({ usable: false, label: "만료 시각 확인 필요" });
  }
  expect(meKeyLifecycle({ ...key, revoked_at: new Date(now).toISOString() }, now).label).toBe("폐기");
  expect(meKeyLifecycle({ ...key, status: "disabled" }, now).usable).toBe(false);
});

it("updates at the grace deadline without a request or reload and cleans up timers", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const rotating = { ...key, replaced_by: "next", grace_ends_at: new Date(now + 1000).toISOString() };
  const keys = [rotating];
  const view = renderHook(() => useKeyExpiryClock(keys));
  expect(meKeyLifecycle(rotating, view.result.current).usable).toBe(true);
  act(() => vi.advanceTimersByTime(1000));
  expect(meKeyLifecycle(rotating, view.result.current).label).toBe("유예 종료");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("catches up after returning to the tab and reschedules when keys change", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const view = renderHook(({ keys }) => useKeyExpiryClock(keys), { initialProps: { keys: [key] } });
  const changed = { ...key, expires_at: new Date(now + 500).toISOString() };
  view.rerender({ keys: [changed] });
  act(() => vi.advanceTimersByTime(500));
  expect(meKeyLifecycle(changed, view.result.current).usable).toBe(false);
  vi.setSystemTime(now + 2000);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(view.result.current).toBe(now + 2000);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
