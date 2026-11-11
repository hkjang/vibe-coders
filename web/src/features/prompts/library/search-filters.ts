import type { PromptSearchQuery } from "@/shared/api/domains/prompts";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { libraryError } from "./library-model";

export const promptSearchKeys = ["q", "language", "ip", "api_key_id", "since", "limit"] as const;
export const limitFrom = (value: string | null): number => {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 100;
};
export function searchQueryFrom(params: URLSearchParams): PromptSearchQuery {
  const query: PromptSearchQuery = { limit: limitFrom(params.get("limit")) };
  for (const key of promptSearchKeys) {
    if (key === "limit") continue;
    const value = params.get(key)?.trim();
    if (value)
      Object.assign(query, {
        [key]: key === "since" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value,
      });
  }
  return query;
}
export function filterQueryString(params: URLSearchParams): string {
  return new URLSearchParams(
    Object.entries(searchQueryFrom(params)).map(([key, value]) => [key, String(value)]),
  ).toString();
}
export function searchUpdatesFrom(params: URLSearchParams, prefixes: readonly string[]) {
  const query = searchQueryFrom(params);
  if (
    Object.values(query).some(
      (value) => typeof value === "string" && containsPotentialSecret(value, prefixes),
    ) ||
    (query.since && !Number.isFinite(Date.parse(query.since)))
  )
    throw libraryError();
  return Object.fromEntries(
    promptSearchKeys.map((key) => [key, query[key] === undefined ? undefined : String(query[key])]),
  );
}
export function localSearchTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export const libraryWindowLabel = (value: string) =>
  value.endsWith("h") ? `최근 ${value.slice(0, -1)}시간` : `최근 ${value.slice(0, -1)}일`;
