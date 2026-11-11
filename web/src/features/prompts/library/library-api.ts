import { z } from "zod";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import type { PromptAssetQuery, PromptSearchQuery } from "@/shared/api/domains/prompts";
import { containsPotentialSecret } from "@/shared/security/secrets";
import {
  assertLibraryIDs,
  libraryAssetSchema,
  libraryDebtSchema,
  libraryError,
  libraryFilterSchema,
  libraryFingerprintSchema,
  libraryHistorySchema,
  libraryID,
  libraryRouteId,
  librarySearchSchema,
  libraryUsageSchema,
  projectLibrary,
} from "./library-model";

const api = endpoints.domains.prompts;
const options = (signal?: AbortSignal) => ({ signal, cache: "no-store" as const, routeId: libraryRouteId });
const labelSchema = z.object({ key: z.string(), label: z.string().optional() });
export function validateLibraryQuery(query: object, prefixes: readonly string[]) {
  if (
    Object.values(query).some(
      (value) => typeof value === "string" && containsPotentialSecret(value, prefixes),
    )
  )
    throw libraryError();
  if ("since" in query && typeof query.since === "string" && !Number.isFinite(Date.parse(query.since)))
    throw libraryError();
}
export async function readLibraryAssets(
  query: PromptAssetQuery,
  prefixes: readonly string[],
  signal?: AbortSignal,
) {
  validateLibraryQuery(query, prefixes);
  const data = await apiClient.request(api.assets.list, { ...options(signal), query });
  assertLibraryIDs(data.assets ?? [], prefixes);
  return {
    assets: (data.assets ?? []).map((row) => projectLibrary(libraryAssetSchema, row, prefixes)),
    stats: z.record(z.string(), z.number()).parse(data.stats ?? {}),
    categories: (data.categories ?? []).map((row) => projectLibrary(labelSchema, row, prefixes)),
    known_tags: (data.known_tags ?? []).map((row) => projectLibrary(labelSchema, row, prefixes)),
  };
}
export async function readLibraryHistory(id: string, prefixes: readonly string[], signal?: AbortSignal) {
  if (!libraryID(id, prefixes)) throw libraryError();
  const data = await apiClient.request(withPathParams(api.assets.history, { id }), options(signal));
  const rows = data.history ?? [];
  assertLibraryIDs(rows, prefixes);
  if (
    rows.some(
      (row) =>
        row.template_id !== id ||
        (row.has_snapshot && (!Number.isSafeInteger(row.version_num) || Number(row.version_num) <= 0)),
    )
  )
    throw libraryError();
  const versions = rows.filter((row) => row.has_snapshot).map((row) => row.version_num);
  if (new Set(versions).size !== versions.length) throw libraryError();
  return { history: rows.map((row) => projectLibrary(libraryHistorySchema, row, prefixes)) };
}
export async function readLibraryUsage(id: string, prefixes: readonly string[], signal?: AbortSignal) {
  if (!libraryID(id, prefixes)) throw libraryError();
  const data = await apiClient.request(withPathParams(api.assets.usage, { id }), options(signal));
  return { usage: (data.usage ?? []).map((row) => projectLibrary(libraryUsageSchema, row, prefixes)) };
}
export async function readLibrarySearch(
  query: PromptSearchQuery,
  prefixes: readonly string[],
  signal?: AbortSignal,
) {
  validateLibraryQuery(query, prefixes);
  const data = await apiClient.request(api.search, { ...options(signal), query });
  assertLibraryIDs(data.requests ?? [], prefixes);
  return projectLibrary(librarySearchSchema, data, prefixes);
}
export async function readLibraryFingerprints(
  window: string,
  prefixes: readonly string[],
  signal?: AbortSignal,
) {
  const data = await apiClient.request(api.fingerprints, {
    ...options(signal),
    query: { window, limit: 100 },
  });
  return projectLibrary(libraryFingerprintSchema, data, prefixes);
}
export async function readLibraryDebt(window: string, prefixes: readonly string[], signal?: AbortSignal) {
  const data = await apiClient.request(api.debt, { ...options(signal), query: { window, limit: 50 } });
  return projectLibrary(libraryDebtSchema, data, prefixes);
}
export async function readLibraryFilters(prefixes: readonly string[], signal?: AbortSignal) {
  const data = await apiClient.request(api.savedFilters.list, {
    ...options(signal),
    query: { view: "prompts" },
  });
  const rows = data.filters ?? [];
  assertLibraryIDs(rows, prefixes);
  if (rows.some((row) => row.view !== "prompts")) throw libraryError();
  return { filters: rows.map((row) => projectLibrary(libraryFilterSchema, row, prefixes)) };
}
