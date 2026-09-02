import type {
  AdminModel,
  AdminModelsResponse,
  ModelPrice,
  ModelQualityResponse,
  ModelQualityScore,
  ModelUsageTag,
  PricingResponse,
} from "@/shared/api/schemas";

export const modelStatusFilters = [
  "all",
  "available",
  "virtual",
  "deprecated",
  "retired",
  "stale",
  "shadowed",
] as const;

export type ModelStatusFilter = (typeof modelStatusFilters)[number];
export type ModelStatus = Exclude<ModelStatusFilter, "all">;
export type AdminModelProvider = AdminModelsResponse["providers"][number];
export const modelSources = [
  "live",
  "cache",
  "agent_route",
] as const satisfies readonly AdminModel["source"][];

export interface ModelCatalogRow {
  model: AdminModel;
  price?: ModelPrice;
  provider?: AdminModelProvider;
  quality?: ModelQualityScore;
  status: ModelStatus;
  tag?: ModelUsageTag;
}

export function isModelStatusFilter(value: string | null): value is ModelStatusFilter {
  return value !== null && modelStatusFilters.some((candidate) => candidate === value);
}

export function isModelSource(value: string | null): value is AdminModel["source"] {
  return value !== null && modelSources.some((candidate) => candidate === value);
}

export function modelRowKey(model: Pick<AdminModel, "id" | "provider" | "source">): string {
  return JSON.stringify([model.provider, model.id, model.source]);
}

export function modelStatus(model: AdminModel): ModelStatus {
  if (model.deprecation?.retired) return "retired";
  if (model.shadowed || model.shadowed_by) return "shadowed";
  if (model.deprecation) return "deprecated";
  if (model.stale) return "stale";
  if (model.virtual) return "virtual";
  return "available";
}

function providerKey(provider: string, source: AdminModel["source"]): string {
  return `${provider}\u0000${source}`;
}

export function buildModelRows(
  catalogue: AdminModelsResponse,
  quality?: ModelQualityResponse,
  pricing?: PricingResponse,
  tags: readonly ModelUsageTag[] = [],
): ModelCatalogRow[] {
  const qualityByModel = new Map(quality?.models.map((score) => [score.model, score]) ?? []);
  const tagByModel = new Map(tags.map((tag) => [tag.model, tag]));
  const providerByKey = new Map(
    catalogue.providers.map((provider) => [providerKey(provider.provider, provider.source), provider]),
  );
  const providerByName = new Map(catalogue.providers.map((provider) => [provider.provider, provider]));

  return catalogue.models.map((model) => ({
    model,
    price: pricing?.effective[`${model.provider}/${model.id}`] ?? pricing?.effective[model.id],
    provider:
      providerByKey.get(providerKey(model.provider, model.source)) ?? providerByName.get(model.provider),
    quality: qualityByModel.get(model.id),
    status: modelStatus(model),
    tag: tagByModel.get(model.id),
  }));
}

export function filterModelRows(
  rows: readonly ModelCatalogRow[],
  query: string,
  provider: string,
  status: ModelStatusFilter,
): ModelCatalogRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (provider !== "" && row.model.provider !== provider) return false;
    if (status !== "all" && row.status !== status) return false;
    if (normalizedQuery === "") return true;
    return [
      row.model.id,
      row.model.provider,
      row.model.owned_by,
      row.model.source,
      row.tag?.good_for ?? "",
      row.tag?.avoid_for ?? "",
      row.tag?.risk_note ?? "",
      row.model.deprecation?.replacement ?? "",
      row.model.shadowed_by ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}

export function uniqueModelProviders(catalogue?: AdminModelsResponse): string[] {
  const names = new Set<string>();
  for (const provider of catalogue?.providers ?? []) names.add(provider.provider);
  for (const model of catalogue?.models ?? []) names.add(model.provider);
  return [...names].sort((left, right) => left.localeCompare(right));
}
