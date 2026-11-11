import { type RefObject } from "react";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import {
  formatDateTime,
  formatDuration,
  formatKRW,
  formatNumber,
  formatPercent,
} from "@/shared/utils/format";
import { RegressionText } from "../RegressionText";
import { compareRunModels, runRows, type RunComparison, type RunRow } from "./run-results";
import type { RunReceipt } from "./run-model";

const models = createDataTableColumnHelper<RunComparison>();
const modelColumns = [
  models.display({
    id: "model",
    header: "모델",
    cell: ({ row }) => (
      <>
        {row.original.model} {row.original.baseline ? <Badge>비교 기준</Badge> : null}
      </>
    ),
  }),
  models.display({ id: "count", header: "완료 검사", cell: ({ row }) => formatNumber(row.original.count) }),
  models.display({ id: "pass", header: "통과율", cell: ({ row }) => formatPercent(row.original.passRate) }),
  models.display({
    id: "delta",
    header: "기준 대비 (%p)",
    cell: ({ row }) =>
      row.original.rateDelta === undefined
        ? "—"
        : `${row.original.rateDelta > 0 ? "+" : ""}${formatNumber(row.original.rateDelta * 100, 1)}`,
  }),
  models.display({ id: "errors", header: "실행 실패", cell: ({ row }) => formatNumber(row.original.errors) }),
  models.display({ id: "cost", header: "합계 비용 (원)", cell: ({ row }) => formatKRW(row.original.cost) }),
  models.display({
    id: "latency",
    header: "평균 지연",
    cell: ({ row }) => formatDuration(row.original.latency),
  }),
];
const details = createDataTableColumnHelper<RunRow>();
const detailColumns = [
  details.display({ id: "target", header: "검사", cell: ({ row }) => row.original.target }),
  details.display({ id: "model", header: "모델", cell: ({ row }) => row.original.model }),
  details.display({
    id: "outcome",
    header: "결과",
    cell: ({ row }) => (
      <Badge tone={row.original.passed ? "success" : "danger"}>
        {row.original.error ? "실행 실패" : row.original.passed ? "통과" : "기대 내용 미충족"}
      </Badge>
    ),
  }),
  details.display({
    id: "score",
    header: "일치 점수 (0–1)",
    cell: ({ row }) => formatNumber(row.original.score, 2),
  }),
  details.display({ id: "cost", header: "비용 (원)", cell: ({ row }) => formatKRW(row.original.cost) }),
  details.display({ id: "latency", header: "지연", cell: ({ row }) => formatDuration(row.original.latency) }),
  details.display({
    id: "response",
    header: "응답",
    cell: ({ row }) =>
      row.original.response === undefined ? (
        "응답 원문 미제공"
      ) : row.original.error ? (
        "모델 호출을 완료하지 못했습니다."
      ) : (
        <details>
          <summary>응답 보기</summary>
          <RegressionText label="이번 실행 응답" value={row.original.response} />
        </details>
      ),
  }),
];

export function RunResults({
  receipt,
  close,
  returnFocusRef,
}: {
  receipt: RunReceipt;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { result } = receipt;
  return (
    <Dialog
      open
      title="회귀 검사 실행 결과"
      description={`결과 수신 ${formatDateTime(new Date(receipt.receivedAt).toISOString())}`}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      returnFocusRef={returnFocusRef}
      scrollBody
      wide
      footer={<Button onClick={close}>결과 닫기</Button>}
    >
      <div className="page-stack">
        <InlineNotice
          tone={!result.complete ? "warning" : result.regressed ? "warning" : "info"}
          title={
            !result.complete
              ? "일부 검사만 완료되었습니다"
              : result.regressed
                ? "통과 기준을 충족하지 못했습니다"
                : "검토한 검사를 완료했습니다"
          }
        >
          예정 {result.planned_total}건 중 {result.total}건의 결과를 받았습니다. 통과 {result.passed}건,
          미통과 {result.failed}건이며 통과 기준은 {formatPercent(result.min_pass_rate)}입니다.{" "}
          {result.complete ? "" : "미실행 검사를 통과로 집계하지 않으며 자동으로 다시 실행하지 않습니다."}
        </InlineNotice>
        {receipt.kind === "prompt" && !receipt.result.results_saved ? (
          <InlineNotice tone="warning">
            일부 결과를 이력에 저장하지 못했습니다. 아래 응답 결과를 확인하세요. 다시 실행하면 모델 호출과
            비용이 중복될 수 있습니다.
          </InlineNotice>
        ) : null}
        <p className="muted">
          {receipt.kind === "workflow"
            ? "워크플로 결과는 별도 이력에 저장되지 않습니다. "
            : "프롬프트 최근 결과는 별도로 다시 조회할 수 있습니다. "}
          이 비교 화면은 메모리에만 남으며 화면 이동·새로고침 시 사라집니다. 비용은 공급자 사용량 또는
          추정값에 따른 계산이며 0원은 무료 호출 보장이 아닙니다.
        </p>
        <DataTable
          caption="모델별 회귀 검사 비교"
          columns={modelColumns}
          data={compareRunModels(receipt)}
          getRowId={(row) => row.model}
        />
        <h3>검사별 상세 결과</h3>
        <DataTable
          caption="이번 실행의 검사별 결과"
          columns={detailColumns}
          data={runRows(receipt)}
          getRowId={(row) => row.id}
          emptyMessage="수신된 검사 결과가 없습니다."
        />
      </div>
    </Dialog>
  );
}
