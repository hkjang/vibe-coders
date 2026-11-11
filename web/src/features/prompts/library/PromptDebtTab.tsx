import { libraryWindowLabel } from "./search-filters";
import { libraryNumber, libraryCost } from "./library-model";
import { useLibraryQuery } from "./use-library-query";
import { readLibraryDebt } from "./library-api";
import { useLibraryOwner } from "./library-context";
import { assertFeatureRead } from "@/shared/hooks/use-feature-read-owner";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { PanelFailure, PromptTable, type PromptColumn } from "@/features/prompts/library/prompt-parts";
import { debtTypeLabel, debtTypeTone } from "@/features/prompts/library/prompt-utils";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime } from "@/shared/utils/format";

const debtWindows = ["7d", "30d", "90d"] as const;

export function PromptDebtTab(): React.JSX.Element {
  const owner = useLibraryOwner();
  const [params, updateSearch] = useSearchState();
  const requested = params.get("debt_window") ?? "";
  const window = (debtWindows as readonly string[]).includes(requested) ? requested : "30d";

  const debt = useLibraryQuery({
    key: ["prompts", "debt", window],
    read: (prefixes, signal) => readLibraryDebt(window, prefixes, signal),
  });

  const rows = debt.data?.items ?? [];

  const columns: ReadonlyArray<PromptColumn<(typeof rows)[number]>> = [
    {
      id: "debt_score",
      sortValue: (row) => row.debt_score,
      header: "부채 점수",
      cell: (row) => <span className="cell-number">{libraryNumber(row.debt_score, 1)}</span>,
    },
    {
      id: "debt_type",
      sortValue: (row) => row.debt_type,
      header: "유형",
      cell: (row) => <Badge tone={debtTypeTone(row.debt_type)}>{debtTypeLabel(row.debt_type)}</Badge>,
    },
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
      header: "작업 유형",
      cell: (row) => row.task_type || "—",
    },
    {
      id: "requests",
      sortValue: (row) => row.requests,
      header: "건수",
      cell: (row) => <span className="cell-number">{libraryNumber(row.requests)}</span>,
    },
    {
      id: "success_rate",
      sortValue: (row) => row.success_rate,
      header: "성공률",
      // The server already returns a percentage for this field.
      cell: (row) => (
        <span className="cell-number">
          {libraryNumber(row.success_rate, 1)}
          {row.success_rate === undefined ? "" : "%"}
        </span>
      ),
    },
    {
      id: "total_cost",
      sortValue: (row) => row.total_cost_krw,
      header: "누적 비용",
      cell: (row) => <span className="cell-number">{libraryCost(row.total_cost_krw)}</span>,
    },
    { id: "top_model", header: "주 사용 모델", cell: (row) => row.top_model || "—" },
    { id: "cheaper_model", header: "대체 모델", cell: (row) => row.cheaper_model || "—" },
    { id: "action", header: "권장 조치", cell: (row) => row.action || "—" },
    {
      id: "last_seen",
      sortValue: (row) => row.last_seen,
      header: "최근 발생",
      cell: (row) => formatDateTime(row.last_seen),
    },
  ];

  return (
    <div className="page-stack">
      <StatGrid label="프롬프트 부채 요약">
        <StatCard label="조회된 개선 후보" value={libraryNumber(debt.data?.count)} />
        <StatCard
          label="전체 후보 누적 비용"
          value={libraryCost(debt.data?.total_debt_cost_krw)}
          tone="warning"
        />
        <StatCard
          label="실패 다발"
          value={libraryNumber(rows.filter((row) => row.debt_type === "failing").length)}
          tone="danger"
        />
        <StatCard
          label="모델 낭비"
          value={libraryNumber(rows.filter((row) => row.debt_type === "model_waste").length)}
          tone="info"
        />
      </StatGrid>

      <SectionCard
        title="프롬프트 부채"
        description="반복 프롬프트의 품질·비용·모델 낭비를 분석한 상위 50개 후보입니다. 항목 수와 유형별 수치는 조회된 후보 기준이며, 누적 비용은 전체 후보 기준입니다."
        actions={
          <div className="prompt-filter-actions">
            <label className="toolbar">
              <span>기간</span>
              <Select
                aria-label="프롬프트 부채 기간"
                value={window}
                onChange={(event) => updateSearch({ debt_window: event.target.value })}
              >
                {debtWindows.map((value) => (
                  <option key={value} value={value}>
                    {libraryWindowLabel(value)}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              disabled={rows.length === 0}
              onClick={() => {
                if (!owner.isCurrent()) return;
                assertFeatureRead(owner);
                downloadCsv(
                  `prompt-debt-${window}`,
                  toCsv(rows, [
                    { header: "debt_score", value: (row) => row.debt_score ?? "" },
                    { header: "debt_type", value: (row) => row.debt_type ?? "" },
                    { header: "task_type", value: (row) => row.task_type ?? "" },
                    { header: "requests", value: (row) => row.requests ?? "" },
                    { header: "success_rate", value: (row) => row.success_rate ?? "" },
                    { header: "total_cost_krw", value: (row) => row.total_cost_krw ?? "" },
                    { header: "top_model", value: (row) => row.top_model ?? "" },
                    { header: "cheaper_model", value: (row) => row.cheaper_model ?? "" },
                    { header: "action", value: (row) => row.action ?? "" },
                  ]),
                );
                toast.success("프롬프트 부채 목록을 CSV로 저장했습니다.");
              }}
            >
              <Download aria-hidden="true" /> CSV 내보내기
            </Button>
          </div>
        }
      >
        {debt.isError ? (
          <PanelFailure
            error={debt.error}
            hasData={Boolean(debt.data)}
            label="프롬프트 부채"
            onRetry={() => void debt.refetch()}
          />
        ) : null}
        {!debt.isPending && !debt.isError && rows.length === 0 ? (
          <EmptyState
            title="정리할 프롬프트 부채가 없습니다."
            description="반복 호출되는 프롬프트가 쌓이면 실패율·비용·모델 낭비를 기준으로 개선 후보가 표시됩니다."
          />
        ) : (
          <PromptTable
            tableId="debt"
            caption="프롬프트 부채 목록"
            columns={columns}
            rows={rows}
            loading={debt.isPending}
            error={debt.isError && !debt.data ? "부채 목록을 불러오지 못했습니다." : undefined}
            onRetry={() => void debt.refetch()}
          />
        )}
        {debt.data?.note ? <p className="muted">{debt.data.note}</p> : null}
      </SectionCard>
    </div>
  );
}
