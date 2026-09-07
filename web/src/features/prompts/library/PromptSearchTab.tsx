import { useQuery } from "@tanstack/react-query";
import { Download, Save, Search, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { PanelFailure, PromptTable, type PromptColumn } from "@/features/prompts/library/prompt-parts";
import { downloadServerCsv } from "@/features/prompts/library/prompt-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { PromptSearchQuery } from "@/shared/api/domains/prompts";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { Input } from "@/shared/components/ui/Input";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber, formatPercent, shortId } from "@/shared/utils/format";
import { httpStatusTone } from "@/shared/utils/http-status";

const routeId = "prompts.library";
const savedFilterView = "prompts";
const fingerprintWindows = ["24h", "7d", "30d", "90d"] as const;
const promptSearchKeys = ["q", "language", "ip", "api_key_id", "since", "limit"] as const;

interface PromptRow {
  id: string;
  created_at?: string;
  api_key_id?: string;
  client_ip?: string;
  model?: string;
  status_code?: number;
  latency_ms?: number;
  total_tokens?: number;
  estimated_cost?: number;
  prompts?: ReadonlyArray<{ role?: string; redacted_text?: string }> | null;
  [key: string]: unknown;
}

function limitFrom(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : 100;
}

function searchQueryFrom(params: URLSearchParams): PromptSearchQuery {
  const query: PromptSearchQuery = { limit: limitFrom(params.get("limit")) };
  for (const key of promptSearchKeys) {
    if (key === "limit") continue;
    const value = params.get(key)?.trim();
    if (value) Object.assign(query, { [key]: value });
  }
  return query;
}

/** The filter form as a query string, for saving and for the CSV export URL. */
function filterQueryString(params: URLSearchParams): string {
  const next = new URLSearchParams();
  for (const key of promptSearchKeys) {
    const value = params.get(key)?.trim();
    if (value) next.set(key, value);
  }
  if (!next.has("limit")) next.set("limit", String(limitFrom(params.get("limit"))));
  return next.toString();
}

export function PromptSearchTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const [searchError, setSearchError] = useState<string | undefined>();
  const [savingName, setSavingName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | undefined>();
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const keywordRef = useRef<HTMLInputElement>(null);

  const query = useMemo(() => searchQueryFrom(params), [params]);
  const queryString = useMemo(() => filterQueryString(params), [params]);
  const requestedWindow = params.get("fp_window") ?? "";
  const fingerprintWindow = (fingerprintWindows as readonly string[]).includes(requestedWindow)
    ? requestedWindow
    : "7d";

  const prompts = useQuery({
    queryKey: ["prompts", "search", queryString],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.prompts.search, { query, signal, routeId }),
  });
  const fingerprints = useQuery({
    queryKey: ["prompts", "fingerprints", fingerprintWindow],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.prompts.fingerprints, {
        query: { window: fingerprintWindow, limit: 100 },
        signal,
        routeId,
      }),
  });
  const savedFilters = useQuery({
    queryKey: ["prompts", "saved-filters", savedFilterView],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.prompts.savedFilters.list, {
        query: { view: savedFilterView },
        signal,
        routeId,
      }),
  });

  const saveFilter = useMutationFeedback({
    mutate: (name: string) =>
      apiClient.request(endpoints.domains.prompts.savedFilters.create, {
        body: { name, view: savedFilterView, params: queryString },
        routeId,
      }),
    invalidates: [["prompts", "saved-filters"]],
    successMessage: "현재 필터를 저장했습니다.",
    errorMessage: "필터를 저장하지 못했습니다.",
    onSuccess: () => setSavingName(""),
  });
  const removeFilter = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(
        {
          ...endpoints.domains.prompts.savedFilters.remove,
          path: pathWithParams(endpoints.domains.prompts.savedFilters.remove.path, { id }),
        },
        { routeId },
      ),
    invalidates: [["prompts", "saved-filters"]],
    successMessage: "저장된 필터를 삭제했습니다.",
    errorMessage: "저장된 필터를 삭제하지 못했습니다.",
  });

  const rows = (prompts.data?.requests ?? []) as ReadonlyArray<PromptRow>;
  const fingerprintRows = fingerprints.data?.fingerprints ?? [];
  const savedRows = savedFilters.data?.filters ?? [];

  const columns: ReadonlyArray<PromptColumn<PromptRow>> = [
    {
      id: "created_at",
      header: "시각",
      cell: (row) => <span title={row.created_at}>{formatDateTime(row.created_at)}</span>,
    },
    {
      id: "id",
      header: "요청",
      cell: (row) => (
        <span className="mono" title={row.id}>
          {shortId(row.id)}
        </span>
      ),
    },
    { id: "model", header: "모델", cell: (row) => row.model || "—" },
    {
      id: "status",
      header: "상태",
      cell: (row) => <Badge tone={httpStatusTone(row.status_code ?? 0)}>{row.status_code ?? "—"}</Badge>,
    },
    {
      id: "latency",
      header: "지연(ms)",
      cell: (row) => <span className="cell-number">{formatNumber(row.latency_ms)}</span>,
    },
    {
      id: "tokens",
      header: "토큰",
      cell: (row) => <span className="cell-number">{formatNumber(row.total_tokens)}</span>,
    },
    {
      id: "cost",
      header: "비용",
      cell: (row) => <span className="cell-number">{formatKRW(row.estimated_cost)}</span>,
    },
    {
      id: "preview",
      header: "프롬프트(마스킹)",
      cell: (row) => {
        const preview = row.prompts?.find((item) => (item.redacted_text ?? "") !== "")?.redacted_text;
        return (
          <span className="prompt-sample" title={preview ?? ""}>
            {preview || "—"}
          </span>
        );
      },
    },
  ];

  const fingerprintColumns: ReadonlyArray<PromptColumn<(typeof fingerprintRows)[number]>> = [
    {
      id: "sample",
      header: "예시(마스킹)",
      cell: (row) => (
        <span className="prompt-sample" title={row.sample_prompt ?? ""}>
          {row.sample_prompt || "—"}
        </span>
      ),
    },
    { id: "task_type", header: "유형", cell: (row) => row.task_type || "—" },
    {
      id: "requests",
      header: "건수",
      cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
    },
    {
      id: "success",
      header: "성공률",
      cell: (row) => <span className="cell-number">{formatPercent(row.success_rate)}</span>,
    },
    {
      id: "cost",
      header: "평균 비용",
      cell: (row) => <span className="cell-number">{formatKRW(row.avg_cost_krw)}</span>,
    },
    { id: "top_model", header: "주 사용 모델", cell: (row) => row.top_model || "—" },
    { id: "cheapest", header: "최저비용 모델", cell: (row) => row.cheapest_model || "—" },
  ];

  const applyFilters = (form: HTMLFormElement): void => {
    const data = new FormData(form);
    const keyword = String(data.get("q") ?? "").trim();
    if (containsPotentialSecret(keyword)) {
      setSearchError(secretSearchMessage);
      keywordRef.current?.focus();
      return;
    }
    setSearchError(undefined);
    updateSearch({
      q: keyword || undefined,
      language: String(data.get("language") ?? "").trim() || undefined,
      ip: String(data.get("ip") ?? "").trim() || undefined,
      api_key_id: String(data.get("api_key_id") ?? "").trim() || undefined,
      since: String(data.get("since") ?? "").trim() || undefined,
      limit: String(data.get("limit") ?? "").trim() || undefined,
    });
  };

  return (
    <div className="page-stack">
      <SectionCard
        title="프롬프트 검색"
        description="키워드(#태그 포함)와 조건으로 프롬프트가 포함된 호출을 찾습니다. 프롬프트 원문은 마스킹된 형태로만 표시됩니다."
      >
        <form
          className="prompt-filter-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters(event.currentTarget);
          }}
        >
          <FormField label="키워드" error={searchError} id="prompt-keyword">
            {(control) => (
              <Input
                {...control}
                ref={keywordRef}
                name="q"
                key={params.get("q") ?? ""}
                defaultValue={params.get("q") ?? ""}
                placeholder="예: refactor 또는 #security"
                onChange={() => setSearchError(undefined)}
              />
            )}
          </FormField>
          <FormField label="언어" id="prompt-language">
            {(control) => (
              <Input
                {...control}
                name="language"
                key={params.get("language") ?? ""}
                defaultValue={params.get("language") ?? ""}
                placeholder="예: java"
              />
            )}
          </FormField>
          <FormField label="클라이언트 IP" id="prompt-ip">
            {(control) => (
              <Input
                {...control}
                name="ip"
                key={params.get("ip") ?? ""}
                defaultValue={params.get("ip") ?? ""}
              />
            )}
          </FormField>
          <FormField label="API 키 ID" id="prompt-key">
            {(control) => (
              <Input
                {...control}
                name="api_key_id"
                key={params.get("api_key_id") ?? ""}
                defaultValue={params.get("api_key_id") ?? ""}
              />
            )}
          </FormField>
          <FormField label="이후 시각" id="prompt-since">
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                name="since"
                key={params.get("since") ?? ""}
                defaultValue={params.get("since") ?? ""}
              />
            )}
          </FormField>
          <FormField label="최대 건수" id="prompt-limit">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={10000}
                name="limit"
                key={params.get("limit") ?? ""}
                defaultValue={String(limitFrom(params.get("limit")))}
              />
            )}
          </FormField>
          <div className="prompt-filter-actions">
            <Button type="submit" variant="primary">
              <Search aria-hidden="true" /> 검색
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                updateSearch({
                  q: undefined,
                  language: undefined,
                  ip: undefined,
                  api_key_id: undefined,
                  since: undefined,
                  limit: undefined,
                })
              }
            >
              필터 초기화
            </Button>
            <Button
              onClick={() => {
                void downloadServerCsv(
                  `/admin/export.csv${queryString ? `?${queryString}` : ""}`,
                  `prompts-${new Date().toISOString().slice(0, 10)}.csv`,
                ).catch((cause: unknown) =>
                  toast.error(cause instanceof Error ? cause.message : "내보내기에 실패했습니다."),
                );
              }}
            >
              <Download aria-hidden="true" /> CSV 다운로드
            </Button>
          </div>
        </form>

        <div className="prompt-filter-actions">
          <FormField label="저장된 필터" id="prompt-saved">
            {(control) => (
              <Select
                {...control}
                value=""
                onChange={(event) => {
                  const selected = savedRows.find((filter) => filter.id === event.target.value);
                  if (!selected?.params) return;
                  const restored = new URLSearchParams(selected.params);
                  updateSearch({
                    q: restored.get("q") ?? undefined,
                    language: restored.get("language") ?? undefined,
                    ip: restored.get("ip") ?? undefined,
                    api_key_id: restored.get("api_key_id") ?? undefined,
                    since: restored.get("since") ?? undefined,
                    limit: restored.get("limit") ?? undefined,
                  });
                }}
              >
                <option value="">불러올 필터를 선택하세요</option>
                {savedRows.map((filter) => (
                  <option key={filter.id} value={filter.id}>
                    {filter.name ?? filter.id}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="저장할 이름" id="prompt-save-name">
            {(control) => (
              <Input
                {...control}
                value={savingName}
                onChange={(event) => setSavingName(event.target.value)}
                placeholder="예: 보안 리뷰 프롬프트"
              />
            )}
          </FormField>
          <Button
            disabled={!canWrite || savingName.trim() === "" || saveFilter.isPending}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            onClick={() => saveFilter.mutate(savingName.trim())}
          >
            <Save aria-hidden="true" /> 현재 필터 저장
          </Button>
        </div>

        {savedRows.length > 0 ? (
          <ul className="prompt-filter-actions" aria-label="저장된 필터 목록">
            {savedRows.map((filter) => (
              <li key={filter.id}>
                <Badge>{filter.name ?? filter.id}</Badge>{" "}
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!canWrite}
                  title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
                  aria-label={`저장된 필터 ${filter.name ?? filter.id} 삭제`}
                  onClick={(event) => {
                    deleteTriggerRef.current = event.currentTarget;
                    setPendingDelete({ id: filter.id, name: filter.name ?? filter.id });
                  }}
                >
                  <Trash2 aria-hidden="true" /> 삭제
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {savedFilters.isError ? (
          <PanelFailure
            error={savedFilters.error}
            hasData={Boolean(savedFilters.data)}
            label="저장된 필터"
            onRetry={() => void savedFilters.refetch()}
          />
        ) : null}
        {prompts.isError ? (
          <PanelFailure
            error={prompts.error}
            hasData={Boolean(prompts.data)}
            label="프롬프트 검색 결과"
            onRetry={() => void prompts.refetch()}
          />
        ) : null}

        {!prompts.isPending && !prompts.isError && rows.length === 0 ? (
          <EmptyState
            title="조건에 맞는 프롬프트가 없습니다."
            description="게이트웨이를 통해 프롬프트가 포함된 호출이 기록되면 이곳에서 검색할 수 있습니다. 조건을 넓혀 다시 검색해 보세요."
          />
        ) : (
          <PromptTable
            caption="프롬프트 검색 결과"
            columns={columns}
            rows={rows}
            loading={prompts.isPending}
            error={prompts.isError && !prompts.data ? "결과를 불러오지 못했습니다." : undefined}
            onRetry={() => void prompts.refetch()}
          />
        )}
      </SectionCard>

      <SectionCard
        title="프롬프트 지문"
        description="거의 동일한 프롬프트를 묶어 반복 사용 패턴과 모델 낭비를 보여줍니다."
        actions={
          <label className="toolbar">
            <span>기간</span>
            <Select
              aria-label="프롬프트 지문 기간"
              value={fingerprintWindow}
              onChange={(event) => updateSearch({ fp_window: event.target.value })}
            >
              {fingerprintWindows.map((value) => (
                <option key={value} value={value}>
                  최근 {value}
                </option>
              ))}
            </Select>
          </label>
        }
      >
        {fingerprints.isError ? (
          <PanelFailure
            error={fingerprints.error}
            hasData={Boolean(fingerprints.data)}
            label="프롬프트 지문"
            onRetry={() => void fingerprints.refetch()}
          />
        ) : null}
        <PromptTable
          caption="프롬프트 지문 클러스터"
          columns={fingerprintColumns}
          rows={fingerprintRows}
          loading={fingerprints.isPending}
          emptyMessage="반복되는 프롬프트 묶음이 아직 없습니다."
        />
      </SectionCard>

      <InlineNotice tone="info" title="이 화면에서 제공하지 않는 기능">
        요청 상세·XView 설명 등 호출 단위 분석은 관측 화면에서 제공합니다.
      </InlineNotice>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        returnFocusRef={deleteTriggerRef}
        title="저장된 필터를 삭제할까요?"
        description={`저장된 필터 "${pendingDelete?.name ?? ""}"을(를) 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        onConfirm={async () => {
          if (pendingDelete) await removeFilter.mutateAsync(pendingDelete.id);
        }}
      />
    </div>
  );
}
