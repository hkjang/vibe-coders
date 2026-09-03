import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { ModelDetailDialog } from "@/features/gateway/models/ModelDetailDialog";
import { ModelPageHeader } from "@/features/gateway/models/ModelPageHeader";
import { ModelToolbar } from "@/features/gateway/models/ModelToolbar";
import {
  buildModelRows,
  filterModelRows,
  isModelSource,
  isModelStatusFilter,
  modelRowKey,
  uniqueModelProviders,
  type ModelCatalogRow,
} from "@/features/gateway/models/model-catalog";
import { ModelPartialFailureNotice, ModelTable } from "@/features/gateway/models/ModelTableParts";
import { useModelCatalogQueries } from "@/features/gateway/models/use-model-catalog";
import { useModelDialogFocus } from "@/features/gateway/models/use-model-dialog-focus";
import { QueryFailureNotice } from "@/features/gateway/providers/ProviderTableParts";
import { isHealthRange, maxUpdatedAt, type HealthRange } from "@/features/health/health-utils";
import { isProviderRef, isSafeLegacyProviderName } from "@/shared/api/provider-ref";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { containsPotentialSecret } from "@/shared/security/secrets";

const pageSize = 10;
const defaultRange: HealthRange = "24h";

function positivePage(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function ModelPage(): React.JSX.Element {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedRange = searchParams.get("range");
  const requestedStatus = searchParams.get("status");
  const requestedPage = searchParams.get("page");
  const requestedProviderFilter = searchParams.get("provider")?.trim() ?? "";
  const requestedModelProvider = searchParams.get("model_provider")?.trim() ?? "";
  const requestedSource = searchParams.get("source");
  const requestedQuery = searchParams.get("q") ?? "";
  const range = isHealthRange(requestedRange) ? requestedRange : defaultRange;
  const status = isModelStatusFilter(requestedStatus) ? requestedStatus : "all";
  const unsafeStoredQuery = containsPotentialSecret(requestedQuery);
  const query = unsafeStoredQuery ? "" : requestedQuery;
  const providerFilter = isProviderRef(requestedProviderFilter) ? requestedProviderFilter : "";
  const providerFilterInvalid = requestedProviderFilter !== "" && !isProviderRef(requestedProviderFilter);
  const selectedModel = searchParams.get("model")?.trim() ?? "";
  const selectedProviderInvalid = requestedModelProvider !== "" && !isProviderRef(requestedModelProvider);
  const selectedProvider = isProviderRef(requestedModelProvider)
    ? requestedModelProvider
    : selectedModel !== ""
      ? providerFilter
      : "";
  const selectedSource = isModelSource(requestedSource) ? requestedSource : undefined;
  const currentPage = positivePage(requestedPage);
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const { models, pricing, quality, tags } = useModelCatalogQueries(range);

  const updateSearch = useCallback(
    (updates: Readonly<Record<string, string | undefined>>, replace = true): void => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === "") next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    const updates: Record<string, string | undefined> = {};
    if (requestedRange !== null && !isHealthRange(requestedRange)) updates.range = defaultRange;
    if (requestedStatus !== null && !isModelStatusFilter(requestedStatus)) updates.status = undefined;
    if (requestedSource !== null && !isModelSource(requestedSource)) updates.source = undefined;
    if (unsafeStoredQuery) updates.q = undefined;
    if (
      requestedProviderFilter !== "" &&
      !isProviderRef(requestedProviderFilter) &&
      !isSafeLegacyProviderName(requestedProviderFilter)
    ) {
      updates.provider = undefined;
    }
    if (
      requestedModelProvider !== "" &&
      !isProviderRef(requestedModelProvider) &&
      !isSafeLegacyProviderName(requestedModelProvider)
    ) {
      updates.model_provider = undefined;
    }
    if (requestedModelProvider !== "" && selectedModel === "") {
      updates.model_provider = undefined;
    }
    if (requestedPage !== null && positivePage(requestedPage) === 1 && requestedPage !== "1") {
      updates.page = undefined;
    }
    if (Object.keys(updates).length > 0) updateSearch(updates);
  }, [
    requestedModelProvider,
    requestedPage,
    requestedProviderFilter,
    requestedRange,
    requestedSource,
    requestedStatus,
    selectedModel,
    unsafeStoredQuery,
    updateSearch,
  ]);

  const allRows = useMemo(
    () =>
      models.data
        ? buildModelRows(models.data, quality.data, pricing.data, tags.data?.tags).sort(
            (left, right) =>
              left.providerLabel.localeCompare(right.providerLabel) ||
              left.model.id.localeCompare(right.model.id) ||
              left.model.source.localeCompare(right.model.source),
          )
        : [],
    [models.data, pricing.data, quality.data, tags.data?.tags],
  );
  const providers = useMemo(() => uniqueModelProviders(models.data), [models.data]);
  const filteredRows = useMemo(
    () => (providerFilterInvalid ? [] : filterModelRows(allRows, query, providerFilter, status)),
    [allRows, providerFilter, providerFilterInvalid, query, status],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const page = Math.min(currentPage, pageCount);
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);
  const selectedMatches =
    selectedModel && !selectedProviderInvalid
      ? allRows.filter(
          (row) =>
            row.model.id === selectedModel &&
            (selectedProvider === "" || row.model.provider_ref === selectedProvider) &&
            (selectedSource === undefined || row.model.source === selectedSource),
        )
      : [];
  const selectedRow = selectedMatches.length === 1 ? selectedMatches[0] : undefined;
  const updatedAt = maxUpdatedAt(
    models.dataUpdatedAt,
    quality.dataUpdatedAt,
    pricing.dataUpdatedAt,
    tags.dataUpdatedAt,
  );
  const refreshing = models.isFetching || quality.isFetching || pricing.isFetching || tags.isFetching;
  const catalogueAvailable = models.data !== undefined;
  const enrichmentLoading = useMemo(
    () => ({ pricing: pricing.isPending, quality: quality.isPending, tags: tags.isPending }),
    [pricing.isPending, quality.isPending, tags.isPending],
  );

  useEffect(() => {
    if (!models.data || currentPage <= pageCount) return;
    updateSearch({ page: pageCount === 1 ? undefined : String(pageCount) });
  }, [currentPage, models.data, pageCount, updateSearch]);

  useEffect(() => {
    if (!models.data) return;
    const resolveLegacyRef = (candidate: string): string | undefined => {
      if (!isSafeLegacyProviderName(candidate)) return undefined;
      const refs = new Set(
        [...models.data.providers, ...models.data.models]
          .filter((item) => item.provider === candidate)
          .map((item) => item.provider_ref),
      );
      return refs.size === 1 ? [...refs][0] : undefined;
    };
    const updates: Record<string, string | undefined> = {};
    if (requestedProviderFilter !== "" && !isProviderRef(requestedProviderFilter)) {
      updates.provider = resolveLegacyRef(requestedProviderFilter);
    }
    if (requestedModelProvider !== "" && !isProviderRef(requestedModelProvider)) {
      updates.model_provider = selectedModel === "" ? undefined : resolveLegacyRef(requestedModelProvider);
    }
    if (Object.keys(updates).length > 0) updateSearch(updates);
  }, [models.data, requestedModelProvider, requestedProviderFilter, selectedModel, updateSearch]);

  const { closeModel, rememberRowTrigger, rememberTrigger, returnFocusRef } = useModelDialogFocus(
    selectedModel,
    updateSearch,
  );
  const openModel = useCallback(
    (row: ModelCatalogRow): void => {
      rememberRowTrigger(modelRowKey(row.model));
      updateSearch(
        { model: row.model.id, model_provider: row.model.provider_ref, source: row.model.source },
        false,
      );
    },
    [rememberRowTrigger, updateSearch],
  );
  const detailSearch = useCallback(
    (row: ModelCatalogRow): string => {
      const next = new URLSearchParams(searchParams);
      next.set("model", row.model.id);
      next.set("model_provider", row.model.provider_ref);
      next.set("source", row.model.source);
      return `?${next.toString()}`;
    },
    [searchParams],
  );
  const refreshAll = (): void => {
    void Promise.all([models.refetch(), quality.refetch(), pricing.refetch(), tags.refetch()]);
  };

  const availableCount = allRows.filter((row) => row.status === "available").length;
  const virtualCount = allRows.filter((row) => row.status === "virtual").length;
  const attentionCount = allRows.filter((row) =>
    ["deprecated", "retired", "stale", "shadowed"].includes(row.status),
  ).length;

  return (
    <div className="page-stack">
      <ModelPageHeader
        attentionCount={attentionCount}
        availableCount={availableCount}
        catalogueAvailable={catalogueAvailable}
        loading={models.isPending}
        onRefresh={refreshAll}
        refreshing={refreshing}
        showLegacyAdmin={showLegacyAdmin}
        totalCount={allRows.length}
        virtualCount={virtualCount}
      />

      <ModelToolbar
        onUpdate={updateSearch}
        provider={providerFilter}
        providers={providers}
        query={query}
        range={range}
        status={status}
        unsafeStoredQuery={unsafeStoredQuery}
      />

      {models.isError ? (
        <QueryFailureNotice
          error={models.error}
          hasPreviousData={Boolean(models.data)}
          label="모델 목록"
          onRetry={() => void models.refetch()}
        />
      ) : null}
      {quality.isError ? (
        <QueryFailureNotice
          error={quality.error}
          hasPreviousData={Boolean(quality.data)}
          label="모델 품질"
          onRetry={() => void quality.refetch()}
        />
      ) : null}
      {pricing.isError ? (
        <QueryFailureNotice
          error={pricing.error}
          hasPreviousData={Boolean(pricing.data)}
          label="모델 가격"
          onRetry={() => void pricing.refetch()}
        />
      ) : null}
      {tags.isError ? (
        <QueryFailureNotice
          error={tags.error}
          hasPreviousData={Boolean(tags.data)}
          label="모델 사용 지침"
          onRetry={() => void tags.refetch()}
        />
      ) : null}
      <ModelPartialFailureNotice
        failures={models.data?.partial_failures ?? []}
        requestId={models.data?.request_id ?? ""}
      />

      <ModelTable
        allRowCount={allRows.length}
        catalogueAvailable={catalogueAvailable}
        detailSearch={detailSearch}
        enrichmentLoading={enrichmentLoading}
        filteredRowCount={filteredRows.length}
        loading={models.isPending}
        modelUnavailable={models.isError && !models.data}
        onPageChange={(pageIndex) =>
          updateSearch({
            page: pageIndex === 0 ? undefined : String(pageIndex + 1),
            model: undefined,
            model_provider: undefined,
            source: undefined,
          })
        }
        onRowClick={openModel}
        pageCount={pageCount}
        pageIndex={page - 1}
        rememberTrigger={rememberTrigger}
        rows={pageRows}
        updatedAt={updatedAt}
      />

      <ModelDetailDialog
        candidates={selectedMatches}
        catalogue={{
          error: models.error,
          fetching: models.isFetching,
          hasResponse: models.data !== undefined,
          partialFailures: models.data?.partial_failures ?? [],
          pending: models.isPending,
          requestId: models.data?.request_id ?? "",
          retry: () => void models.refetch(),
        }}
        detailSearch={detailSearch}
        enrichment={{
          pricing: {
            error: pricing.error,
            fetching: pricing.isFetching,
            hasResponse: pricing.data !== undefined,
            pending: pricing.isPending,
            retry: () => void pricing.refetch(),
          },
          quality: {
            error: quality.error,
            fetching: quality.isFetching,
            hasResponse: quality.data !== undefined,
            pending: quality.isPending,
            retry: () => void quality.refetch(),
          },
          tags: {
            error: tags.error,
            fetching: tags.isFetching,
            hasResponse: tags.data !== undefined,
            pending: tags.isPending,
            retry: () => void tags.refetch(),
          },
        }}
        onOpenChange={(open) => {
          if (!open) closeModel();
        }}
        open={selectedModel !== ""}
        requestedModel={selectedModel}
        requestedProvider={selectedProvider}
        returnFocusRef={returnFocusRef}
        row={selectedRow}
        showLegacyAdmin={showLegacyAdmin}
      />
    </div>
  );
}
