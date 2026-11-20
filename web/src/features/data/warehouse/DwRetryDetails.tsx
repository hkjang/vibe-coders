import type { DwRetryDimensionView } from "@/shared/api/domains/dw-retry";
import { SimpleTable } from "@/features/data/SimpleTable";
import { Badge } from "@/shared/components/ui/Badge";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const dimensionLabels: Readonly<Record<string, string>> = {
  all: "전체",
  model: "모델",
  provider: "공급자",
  project: "프로젝트",
  cost_center: "비용 센터",
  text2sql_fact: "자연어 SQL 실행",
  redteam_fact: "레드팀 검사",
};
const statusLabels: Record<DwRetryDimensionView["status"], string> = {
  queued: "실행 대기",
  blocked: "설정 확인 필요",
  running: "전송 중",
  succeeded: "완료",
  failed: "실패",
  pending: "새 실패 대기",
  not_run: "미실행",
};
const issueLabels: Record<DwRetryDimensionView["issue"], string> = {
  "": "",
  invalid_source_interval: "대상 기간 또는 구분을 확인하세요.",
  not_configured: "ClickHouse 연결 설정이 필요합니다.",
  fact_not_configured: "대상 팩트 테이블 설정이 필요합니다.",
  delivery_incomplete: "전송을 완료하지 못해 대기열을 유지했습니다.",
  completion_unconfirmed: "완료 여부를 확인하지 못했습니다.",
  new_failure_queued: "전송 중 새로 접수된 실패가 남아 있습니다.",
  operation_interrupted: "작업이 중단되어 실행하지 못했습니다.",
};
export function DwRetryDetails({
  rows,
  progress = false,
}: {
  rows: DwRetryDimensionView[];
  progress?: boolean;
}): React.JSX.Element {
  return (
    <SimpleTable<DwRetryDimensionView>
      caption={progress ? "구분별 재처리 결과" : "재처리 대상과 예상 건수"}
      rows={rows}
      emptyMessage="재처리 대기 중인 항목이 없습니다."
      columns={[
        { id: "dimension", header: "대상", cell: (row) => dimensionLabels[row.dimension] ?? row.dimension },
        {
          id: "interval",
          header: "대상 기간",
          cell: (row) => (
            <div>
              {row.since.length === 10 ? row.since : formatDateTime(row.since)}
              <br />~ {row.until.length === 10 ? row.until : formatDateTime(row.until)}
            </div>
          ),
        },
        {
          id: "estimate",
          header: "예상 행",
          cell: (row) => (
            <span className="cell-number">
              {row.status === "blocked" ? "확인 불가" : formatNumber(row.estimated_rows)}
            </span>
          ),
        },
        ...(progress
          ? [
              {
                id: "sent",
                header: "전송 행",
                cell: (row: DwRetryDimensionView) => (
                  <span className="cell-number">{formatNumber(row.sent_rows)}</span>
                ),
              },
            ]
          : []),
        {
          id: "status",
          header: "상태",
          cell: (row) => (
            <div>
              <Badge tone={row.status === "succeeded" ? "success" : row.issue ? "warning" : "muted"}>
                {statusLabels[row.status]}
              </Badge>
              {row.issue ? <p className="text-muted">{issueLabels[row.issue]}</p> : null}
            </div>
          ),
        },
      ]}
    />
  );
}
