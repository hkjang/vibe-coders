import { categoryPaint } from "@/features/insights/charts/palette";
import type { WorkProductivityRow } from "@/shared/api/domains/insights-usage";
import { Badge } from "@/shared/components/ui/Badge";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

import { useProductivity } from "../use-usage-queries";
import type { UsageTabProps } from "../usage-tab-props";
import { CategoryLabel, Panel, PlainTable, Suppressed, type PlainColumn } from "../usage-ui";

const observed = <Badge tone="info">관측</Badge>;
const estimated = <Badge tone="warning">추정</Badge>;

/** A withheld row keeps its category, baseline and reason; its observed and estimated figures read as 보호됨. */
function productivityColumns(minGroupSize: number): PlainColumn<WorkProductivityRow>[] {
  const measure =
    (write: (row: WorkProductivityRow) => string) =>
    (row: WorkProductivityRow): React.ReactNode =>
      row.suppressed ? <Suppressed minGroupSize={minGroupSize} /> : write(row);
  return [
    {
      id: "category",
      header: "업무",
      cell: (row) => (
        <CategoryLabel name={row.category.name || row.category.id} paint={categoryPaint(row.category.id)} />
      ),
    },
    {
      id: "sessions",
      header: <>세션 {observed}</>,
      numeric: true,
      cell: measure((row) => formatNumber(row.sessions)),
    },
    {
      id: "confirmed",
      header: <>완료 확인 세션 {observed}</>,
      numeric: true,
      help: "긍정 피드백으로 완료가 확인된 세션입니다. API 호출 성공만으로는 세지 않습니다.",
      cell: measure((row) => formatNumber(row.confirmed_sessions)),
    },
    {
      id: "model-time",
      header: <>모델 응답 시간 {observed}</>,
      numeric: true,
      help: "세션에서 모델이 응답하는 데 쓴 시간의 합입니다.",
      cell: measure((row) => formatDuration(row.model_time_ms)),
    },
    {
      id: "baseline",
      header: "기준값",
      help: "분류 정책에 관리자가 넣은 값: 수작업 시간 → AI 사용 시 시간, 시간당 비용",
      cell: (row) =>
        row.baseline
          ? `수작업 ${formatNumber(row.baseline.manual_minutes)}분 → AI ${formatNumber(row.baseline.ai_minutes)}분 · 시간당 ${formatKRW(row.baseline.hourly_cost_krw)}`
          : "없음",
    },
    {
      id: "minutes",
      header: <>절감 시간 {estimated}</>,
      numeric: true,
      cell: measure((row) =>
        row.est_minutes_saved === null ? "추정 불가" : `약 ${formatNumber(row.est_minutes_saved)}분`,
      ),
    },
    {
      id: "cost",
      header: <>절감 비용 {estimated}</>,
      numeric: true,
      cell: measure((row) =>
        row.est_cost_saved_krw === null ? "추정 불가" : `약 ${formatKRW(row.est_cost_saved_krw)}`,
      ),
    },
    { id: "reason", header: "근거·사유", cell: (row) => row.reason || "—" },
  ];
}

export function ProductivityTab({ query, minGroupSize }: UsageTabProps): React.JSX.Element {
  const productivity = useProductivity(query);
  const columns = productivityColumns(minGroupSize);
  return (
    <div className="wi-stack">
      <InlineNotice tone="info" title="관측값과 추정값을 구분해 읽으세요.">
        <strong>관측</strong>은 로그에서 그대로 센 값입니다. <strong>추정</strong>은 관리자가 넣은
        기준값(수작업 시간·AI 사용 시간·시간당 비용)에 완료가 확인된 세션 수를 곱해 계산한 값으로, 실제
        절감액이 아닙니다. 기준값이나 완료 근거가 없는 업무는 추정하지 않고 사유를 표시합니다.
      </InlineNotice>
      <SectionCard
        title="업무별 관측값과 추정 절감"
        description="업무마다 관측된 사용량과, 기준값이 있을 때만 계산한 절감 추정치입니다."
      >
        <Panel
          query={productivity}
          label="생산성"
          isEmpty={(data) => data.rows.length === 0}
          withheld={{ when: (data) => data.suppressed && data.rows.length === 0, minGroupSize }}
        >
          {(data) => (
            <PlainTable
              caption="업무별 관측값과 추정 절감"
              wide
              columns={columns}
              rows={data.rows}
              rowKey={(row) => row.category.id}
            />
          )}
        </Panel>
      </SectionCard>
    </div>
  );
}
