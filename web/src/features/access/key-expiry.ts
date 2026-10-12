import { z } from "zod";

function localExpiry(value: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!parts) return undefined;
  const date = new Date(value);
  const expected = parts.slice(1).map((part) => Number(part ?? 0));
  const actual = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return actual.every((part, index) => part === expected[index]) ? date : undefined;
}

export const keyExpirySchema = z
  .string()
  .refine(
    (value) => value === "" || (localExpiry(value)?.getTime() ?? 0) > Date.now(),
    "현재보다 이후의 올바른 만료 시각을 입력하세요.",
  );

export function keyExpiryISO(value: string): string {
  const date = localExpiry(value);
  if (!date) throw new Error("올바른 만료 시각을 입력하세요.");
  return date.toISOString();
}
