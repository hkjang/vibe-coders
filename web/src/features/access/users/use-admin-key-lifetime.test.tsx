import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAdminKeyLifetime } from "./use-admin-key-lifetime";

it("조회 권한을 잃은 즉시 재렌더 전에도 변경 요청과 늦은 결과를 차단한다", () => {
  let readable = true;
  const writable = vi.fn();
  const { result, unmount } = renderHook(() => useAdminKeyLifetime(null, writable, () => readable));
  expect(result.current.ownsResult()).toBe(true);
  expect(() => result.current.assertCurrent()).not.toThrow();
  readable = false;
  expect(result.current.ownsResult()).toBe(false);
  expect(() => result.current.assertCurrent()).toThrow();
  unmount();
  readable = true;
  expect(result.current.ownsResult()).toBe(false);
});
