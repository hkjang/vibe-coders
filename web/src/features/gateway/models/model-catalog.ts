import type {
  AdminModel,
  AdminModelsResponse,
  ModelPrice,
  ModelQualityResponse,
  ModelQualityScore,
  ModelUsageTag,
  PricingResponse,
} from "@/shared/api/schemas";
import { providerDisplayLabel, providerDisplayLabels } from "@/shared/api/provider-ref";

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
  providerLabel: string;
  quality?: ModelQualityScore;
  status: ModelStatus;
  tag?: ModelUsageTag;
}

export interface ModelProviderOption {
  label: string;
  value: string;
}

export function isModelStatusFilter(value: string | null): value is ModelStatusFilter {
  return value !== null && modelStatusFilters.some((candidate) => candidate === value);
}

export function isModelSource(value: string | null): value is AdminModel["source"] {
  return value !== null && modelSources.some((candidate) => candidate === value);
}

export function modelRowKey(model: Pick<AdminModel, "id" | "provider_ref" | "source">): string {
  return JSON.stringify([model.provider_ref, model.id, model.source]);
}

export function modelStatus(model: AdminModel): ModelStatus {
  if (model.deprecation?.retired) return "retired";
  if (model.shadowed || model.shadowed_by) return "shadowed";
  if (model.deprecation) return "deprecated";
  if (model.stale) return "stale";
  if (model.virtual) return "virtual";
  return "available";
}

function providerKey(providerRef: string, source: AdminModel["source"]): string {
  return `${providerRef}\u0000${source}`;
}

function providerLabels(catalogue: AdminModelsResponse): Map<string, string> {
  return providerDisplayLabels(
    [...catalogue.providers, ...catalogue.models].map((item) => ({
      name: item.provider,
      providerRef: item.provider_ref,
    })),
  );
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
    catalogue.providers.map((provider) => [providerKey(provider.provider_ref, provider.source), provider]),
  );
  const providerByRef = new Map(catalogue.providers.map((provider) => [provider.provider_ref, provider]));
  const labels = providerLabels(catalogue);

  return catalogue.models.map((model) => ({
    model,
    price: pricing?.effective[`${model.provider}/${model.id}`] ?? pricing?.effective[model.id],
    provider:
      providerByKey.get(providerKey(model.provider_ref, model.source)) ??
      providerByRef.get(model.provider_ref),
    providerLabel:
      labels.get(model.provider_ref) ?? providerDisplayLabel(model.provider, model.provider_ref, true),
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
    if (provider !== "" && row.model.provider_ref !== provider) return false;
    if (status !== "all" && row.status !== status) return false;
    if (normalizedQuery === "") return true;
    return [
      row.model.id,
      row.providerLabel,
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

export function uniqueModelProviders(catalogue?: AdminModelsResponse): ModelProviderOption[] {
  if (!catalogue) return [];
  const labels = providerLabels(catalogue);
  return [...labels]
    .map(([value, label]) => ({ label, value }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
}
