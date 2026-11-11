import { libraryNumber, libraryCost, libraryPercent } from "./library-model";
import { useAuth } from "@/app/auth/AuthProvider";
import { LibraryCsvButton } from "./LibraryCsvButton";
import { SavedPromptFilters } from "./SavedPromptFilters";
import {
  searchQueryFrom,
  filterQueryString,
  limitFrom,
  promptSearchKeys,
  searchUpdatesFrom,
  localSearchTime,
  libraryWindowLabel,
} from "./search-filters";
import { useLibraryQuery } from "./use-library-query";
import { readLibrarySearch, readLibraryFingerprints } from "./library-api";
import { Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { PanelFailure, PromptTable, type PromptColumn } from "@/features/prompts/library/prompt-parts";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { Input } from "@/shared/components/ui/Input";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, shortId } from "@/shared/utils/format";
import { httpStatusTone } from "@/shared/utils/http-status";

const fingerprintWindows = ["24h", "7d", "30d", "90d"] as const;

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

export function PromptSearchTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const { credentialPrefixes } = useAuth();
  const [params, updateSearch] = useSearchState();
  const [searchError, setSearchError] = useState<string | undefined>();
  const keywordRef = useRef<HTMLInputElement>(null);

  const query = useMemo(() => searchQueryFrom(params), [params]);
  const queryString = useMemo(() => filterQueryString(params), [params]);
  const requestedWindow = params.get("fp_window") ?? "";
  const fingerprintWindow = (fingerprintWindows as readonly string[]).includes(requestedWindow)
    ? requestedWindow
    : "7d";

  const prompts = useLibraryQuery({
    key: ["prompts", "search", queryString],
    read: (prefixes, signal) => readLibrarySearch(query, prefixes, signal),
  });
  const fingerprints = useLibraryQuery({
    key: ["prompts", "fingerprints", fingerprintWindow],
    read: (prefixes, signal) => readLibraryFingerprints(fingerprintWindow, prefixes, signal),
  });
  const rows = (prompts.data?.requests ?? []) as ReadonlyArray<PromptRow>;
  const fingerprintRows = fingerprints.data?.fingerprints ?? [];

  const columns: ReadonlyArray<PromptColumn<PromptRow>> = [
    {
      id: "created_at",
      sortValue: (row) => row.created_at,
      header: "시각",
      cell: (row) => <span title={row.created_at}>{formatDateTime(row.created_at)}</span>,
    },
    {
      id: "id",
      sortValue: (row) => row.id,
      header: "요청",
      cell: (row) => (
        <span className="mono" title={row.id}>
          {shortId(row.id)}
        </span>
      ),
    },
    { id: "model", sortValue: (row) => row.model, header: "모델", cell: (row) => row.model || "—" },
    {
      id: "status",
      sortValue: (row) => row.status_code,
      header: "상태",
      cell: (row) => <Badge tone={httpStatusTone(row.status_code ?? 0)}>{row.status_code ?? "—"}</Badge>,
    },
    {
      id: "latency",
      sortValue: (row) => row.latency_ms,
      header: "지연(ms)",
      cell: (row) => <span className="cell-number">{libraryNumber(row.latency_ms)}</span>,
    },
    {
      id: "tokens",
      sortValue: (row) => row.total_tokens,
      header: "토큰",
      cell: (row) => <span className="cell-number">{libraryNumber(row.total_tokens)}</span>,
    },
    {
      id: "cost",
      sortValue: (row) => row.estimated_cost,
      header: "비용",
      cell: (row) => <span className="cell-number">{libraryCost(row.estimated_cost)}</span>,
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
    {
      id: "task_type",
      sortValue: (row) => row.task_type,
      header: "유형",
      cell: (row) => row.task_type || "—",
    },
    {
      id: "requests",
      sortValue: (row) => row.requests,
      header: "건수",
      cell: (row) => <span className="cell-number">{libraryNumber(row.requests)}</span>,
    },
    {
      id: "success",
      sortValue: (row) => row.success_rate,
      header: "성공률",
      cell: (row) => <span className="cell-number">{libraryPercent(row.success_rate)}</span>,
    },
    {
      id: "cost",
      sortValue: (row) => row.avg_cost_krw,
      header: "평균 비용",
      cell: (row) => <span className="cell-number">{libraryCost(row.avg_cost_krw)}</span>,
    },
    {
      id: "top_model",
      sortValue: (row) => row.top_model,
      header: "주 사용 모델",
      cell: (row) => row.top_model || "—",
    },
    {
      id: "cheapest",
      sortValue: (row) => row.cheapest_model,
      header: "최저비용 모델",
      cell: (row) => row.cheapest_model || "—",
    },
  ];

  const applyFilters = (form: HTMLFormElement): void => {
    const data = new FormData(form);
    const submitted = new URLSearchParams(
      promptSearchKeys.map((key) => [key, String(data.get(key) ?? "").trim()]),
    );
    try {
      updateSearch({ ...searchUpdatesFrom(submitted, credentialPrefixes), search_page: undefined });
      setSearchError(undefined);
    } catch {
      setSearchError("비밀정보가 포함되었거나 검색 조건이 올바르지 않습니다. 입력값을 확인하세요.");
      keywordRef.current?.focus();
    }
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
                defaultValue={localSearchTime(params.get("since"))}
              />
            )}
          </FormField>
          <FormField label="최대 건수" id="prompt-limit">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={200}
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
                  search_page: undefined,
                })
              }
            >
              필터 초기화
            </Button>
            <LibraryCsvButton key={queryString} query={query} />
          </div>
        </form>

        <p className="muted">
          검색과 내보내기는 선택한 조건의 최근 최대 {query.limit}건입니다. CSV에는 요청 메타데이터가 포함되며
          프롬프트 본문은 포함되지 않습니다.
        </p>
        <SavedPromptFilters canWrite={canWrite} queryString={queryString} />

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
            tableId="search"
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
                  {libraryWindowLabel(value)}
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
          tableId="fingerprints"
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
    </div>
  );
}
