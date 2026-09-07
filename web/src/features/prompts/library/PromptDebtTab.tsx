import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { PanelFailure, PromptTable, type PromptColumn } from "@/features/prompts/library/prompt-parts";
import { debtTypeLabel, debtTypeTone } from "@/features/prompts/library/prompt-utils";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

const routeId = "prompts.library";
const debtWindows = ["7d", "30d", "90d"] as const;

export function PromptDebtTab(): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const requested = params.get("debt_window") ?? "";
  const window = (debtWindows as readonly string[]).includes(requested) ? requested : "30d";

  const debt = useQuery({
    queryKey: ["prompts", "debt", window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.prompts.debt, {
        query: { window, limit: 50 },
        signal,
        routeId,
      }),
  });

  const rows = debt.data?.items ?? [];

  const columns: ReadonlyArray<PromptColumn<(typeof rows)[number]>> = [
    {
      id: "debt_score",
      header: "부채 점수",
      cell: (row) => <span className="cell-number">{formatNumber(row.debt_score, 1)}</span>,
    },
    {
      id: "debt_type",
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
    { id: "task_type", header: "작업 유형", cell: (row) => row.task_type || "—" },
    {
      id: "requests",
      header: "건수",
      cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
    },
    {
      id: "success_rate",
      header: "성공률",
      // The server already returns a percentage for this field.
      cell: (row) => <span className="cell-number">{formatNumber(row.success_rate, 1)}%</span>,
    },
    {
      id: "total_cost",
      header: "누적 비용",
      cell: (row) => <span className="cell-number">{formatKRW(row.total_cost_krw)}</span>,
    },
    { id: "top_model", header: "주 사용 모델", cell: (row) => row.top_model || "—" },
    { id: "cheaper_model", header: "대체 모델", cell: (row) => row.cheaper_model || "—" },
    { id: "action", header: "권장 조치", cell: (row) => row.action || "—" },
    {
      id: "last_seen",
      header: "최근 발생",
      cell: (row) => formatDateTime(row.last_seen),
    },
  ];

  return (
    <div className="page-stack">
      <StatGrid label="프롬프트 부채 요약">
        <StatCard label="부채 항목" value={formatNumber(debt.data?.count ?? rows.length)} />
        <StatCard label="부채 누적 비용" value={formatKRW(debt.data?.total_debt_cost_krw)} tone="warning" />
        <StatCard
          label="실패 다발"
          value={formatNumber(rows.filter((row) => row.debt_type === "failing").length)}
          tone="danger"
        />
        <StatCard
          label="모델 낭비"
          value={formatNumber(rows.filter((row) => row.debt_type === "model_waste").length)}
          tone="info"
        />
      </StatGrid>

      <SectionCard
        title="프롬프트 부채"
        description="반복 프롬프트를 품질·비용·모델 낭비·볼륨 기준으로 부채화한 목록입니다. 점수가 높을수록 먼저 개선하세요."
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
                    최근 {value}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              disabled={rows.length === 0}
              onClick={() => {
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
