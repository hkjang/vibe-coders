import { afterEach, expect, it, vi } from "vitest";
import { keyExpiryISO, keyExpirySchema } from "./key-expiry";

afterEach(() => vi.useRealTimers());

it("converts local form time to a timezone-bearing instant without dropping expiry", () => {
  const local = "2099-10-13T09:30";
  const value = keyExpiryISO(local);
  expect(value.endsWith("Z")).toBe(true);
  expect(Date.parse(value)).toBe(new Date(2099, 9, 13, 9, 30).getTime());
  expect(keyExpirySchema.safeParse(local).success).toBe(true);
  expect(keyExpirySchema.safeParse("").success).toBe(true);
});

it("rejects impossible calendar values, invalid formats and past or exact-now expiry", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2099, 0, 1, 9, 30));
  for (const value of [
    "invalid",
    "2099-02-30T12:00",
    "2099-13-01T12:00",
    "2099-01-01T24:30",
    "2000-01-01T00:00",
    "2099-01-01T09:30",
  ]) {
    expect(keyExpirySchema.safeParse(value).success).toBe(false);
  }
  expect(() => keyExpiryISO("invalid")).toThrow();
  expect(() => keyExpiryISO("2099-02-30T12:00")).toThrow();
});
