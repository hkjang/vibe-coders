import { useState, type RefObject } from "react";

import { categoryPaint } from "@/features/insights/charts/palette";
import {
  automationReviewStatuses,
  type AutomationReviewStatus,
  type WorkAutomationRow,
} from "@/shared/api/domains/insights-usage";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Textarea } from "@/shared/components/ui/Textarea";
import {
  formatDateTime,
  formatDuration,
  formatKRW,
  formatNumber,
  formatPercent,
} from "@/shared/utils/format";

import type { useUsageWrites } from "../use-usage-queries";
import {
  automationDisclaimer,
  recommendedLabel,
  reviewStatusLabel,
  reviewStatusLabels,
  reviewStatusTone,
  riskLabel,
  riskTone,
} from "../usage-labels";
import { CategoryLabel, PlainTable, Suppressed, type PlainColumn } from "../usage-ui";

interface AutomationTableProps {
  rows: readonly WorkAutomationRow[];
  minGroupSize: number;
  compact?: boolean;
  onOpen: (row: WorkAutomationRow, trigger: HTMLElement) => void;
}

export function AutomationTable({
  rows,
  minGroupSize,
  compact = false,
  onOpen,
}: AutomationTableProps): React.JSX.Element {
  const columns: PlainColumn<WorkAutomationRow>[] = [
    {
      id: "title",
      header: "반복 업무",
      cell: (row) => (
        <Button
          size="small"
          variant="ghost"
          className="wi-row-button"
          aria-label={`${row.title || row.id} 자동화 후보 상세`}
          onClick={(event) => onOpen(row, event.currentTarget)}
        >
          {row.title || row.id}
        </Button>
      ),
    },
    {
      id: "category",
      header: "업무",
      cell: (row) => (
        <CategoryLabel name={row.category.name || row.category.id} paint={categoryPaint(row.category.id)} />
      ),
    },
    { id: "repeats", header: "반복", numeric: true, cell: (row) => `${formatNumber(row.repeats)}회` },
    {
      id: "users",
      header: "사용자",
      numeric: true,
      cell: (row) =>
        row.users === null ? <Suppressed minGroupSize={minGroupSize} /> : `${formatNumber(row.users)}명`,
    },
    { id: "recommended", header: "권장 형태", cell: (row) => recommendedLabel(row.recommended) },
    ...(compact
      ? []
      : ([
          { id: "teams", header: "조직", cell: (row) => row.teams.join(", ") || "—" },
          { id: "sessions", header: "세션", numeric: true, cell: (row) => formatNumber(row.sessions) },
          { id: "cost", header: "비용", numeric: true, cell: (row) => formatKRW(row.cost_krw) },
          {
            id: "feasibility",
            header: "실현 가능성",
            numeric: true,
            help: "반복의 규칙성과 도구 사용 패턴으로 계산한 0~100% 점수",
            cell: (row) => formatPercent(row.feasibility, 0),
          },
          {
            id: "risk",
            header: "위험",
            cell: (row) => (
              <span className="badge-list">
                <Badge tone={riskTone(row.risk)}>위험 {riskLabel(row.risk)}</Badge>
                {row.needs_approval ? <Badge tone="warning">승인 필요</Badge> : null}
              </span>
            ),
          },
        ] satisfies PlainColumn<WorkAutomationRow>[])),
    {
      id: "review",
      header: "검토 상태",
      cell: (row) => (
        <Badge tone={reviewStatusTone(row.review_status)}>{reviewStatusLabel(row.review_status)}</Badge>
      ),
    },
  ];
  return (
    <PlainTable
      caption={compact ? "반복 업무·자동화 후보 (상위)" : "자동화 후보"}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      wide={!compact}
    />
  );
}

interface AutomationSheetProps {
  candidate: WorkAutomationRow | undefined;
  /** The list is still loading, so a missing candidate is not yet "not found". */
  loading: boolean;
  minGroupSize: number;
  writes: ReturnType<typeof useUsageWrites>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

const isReviewStatus = (value: string): value is AutomationReviewStatus =>
  (automationReviewStatuses as readonly string[]).includes(value);

/** One candidate in full, with the review decision. Recording a decision changes nothing else. */
export function AutomationSheet({
  candidate,
  loading,
  minGroupSize,
  writes,
  returnFocusRef,
  onClose,
}: AutomationSheetProps): React.JSX.Element {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={candidate?.title || "자동화 후보"}
      description="반복 업무의 근거와 권장 형태입니다. 검토 상태만 기록합니다."
      returnFocusRef={returnFocusRef}
      scrollLabel="자동화 후보 상세"
    >
      {candidate ? (
        <AutomationDetail
          key={candidate.id}
          candidate={candidate}
          minGroupSize={minGroupSize}
          writes={writes}
        />
      ) : loading ? (
        <p role="status">후보를 불러오는 중입니다.</p>
      ) : (
        <InlineNotice tone="info" title="이 후보를 현재 목록에서 찾을 수 없습니다.">
          필터나 기간이 바뀌었거나 후보가 다시 계산되었습니다. 패널을 닫고 목록에서 다시 선택하세요.
        </InlineNotice>
      )}
    </Sheet>
  );
}

function AutomationDetail({
  candidate,
  minGroupSize,
  writes,
}: {
  candidate: WorkAutomationRow;
  minGroupSize: number;
  writes: ReturnType<typeof useUsageWrites>;
}): React.JSX.Element {
  const current: AutomationReviewStatus = isReviewStatus(candidate.review_status)
    ? candidate.review_status
    : "new";
  const [status, setStatus] = useState<AutomationReviewStatus>(current);
  const [note, setNote] = useState("");
  const { access, review } = writes;
  return (
    <div className="wi-sheet-stack">
      <p className="wi-note">{automationDisclaimer}</p>
      <dl className="kv-list" data-columns="2">
        <div className="kv-item">
          <dt>업무</dt>
          <dd>{candidate.category.name || candidate.category.id}</dd>
        </div>
        <div className="kv-item">
          <dt>권장 형태</dt>
          <dd>{recommendedLabel(candidate.recommended)}</dd>
        </div>
        <div className="kv-item">
          <dt>반복 횟수</dt>
          <dd>{formatNumber(candidate.repeats)}회</dd>
        </div>
        <div className="kv-item">
          <dt>사용자</dt>
          <dd>
            {candidate.users === null ? (
              <Suppressed minGroupSize={minGroupSize} />
            ) : (
              `${formatNumber(candidate.users)}명`
            )}
          </dd>
        </div>
        <div className="kv-item">
          <dt>조직</dt>
          <dd>{candidate.teams.join(", ") || "—"}</dd>
        </div>
        <div className="kv-item">
          <dt>세션 · 비용</dt>
          <dd>
            {formatNumber(candidate.sessions)}세션 · {formatKRW(candidate.cost_krw)}
          </dd>
        </div>
        <div className="kv-item">
          <dt>평균 응답 시간</dt>
          <dd>{formatDuration(candidate.avg_latency_ms)}</dd>
        </div>
        <div className="kv-item">
          <dt>실현 가능성</dt>
          <dd>{formatPercent(candidate.feasibility, 0)}</dd>
        </div>
        <div className="kv-item">
          <dt>위험 수준</dt>
          <dd>
            {riskLabel(candidate.risk)}
            {candidate.needs_approval ? " · 도입 전 승인 필요" : ""}
          </dd>
        </div>
        <div className="kv-item">
          <dt>쓰인 MCP 도구</dt>
          <dd>{candidate.mcp_tools.join(", ") || "없음"}</dd>
        </div>
        <div className="kv-item">
          <dt>예상 효과 (추정)</dt>
          <dd>
            {candidate.effect.est_minutes_saved === null && candidate.effect.est_cost_saved_krw === null
              ? "추정할 근거가 없습니다"
              : [
                  candidate.effect.est_minutes_saved === null
                    ? ""
                    : `약 ${formatNumber(candidate.effect.est_minutes_saved)}분 절감`,
                  candidate.effect.est_cost_saved_krw === null
                    ? ""
                    : `약 ${formatKRW(candidate.effect.est_cost_saved_krw)} 절감`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </dd>
        </div>
        <div className="kv-item">
          <dt>추정 근거</dt>
          <dd>{candidate.effect.basis || "—"}</dd>
        </div>
        <div className="kv-item">
          <dt>계산 시각</dt>
          <dd>{formatDateTime(candidate.computed_at)}</dd>
        </div>
        <div className="kv-item">
          <dt>현재 검토 상태</dt>
          <dd>
            <Badge tone={reviewStatusTone(candidate.review_status)}>
              {reviewStatusLabel(candidate.review_status)}
            </Badge>
          </dd>
        </div>
      </dl>
      <form
        className="wi-review-form"
        onSubmit={(event) => {
          event.preventDefault();
          review.mutate({ id: candidate.id, reviewStatus: status, note: note.trim() });
        }}
      >
        <FormField label="검토 상태">
          {(control) => (
            <Select
              {...control}
              value={status}
              disabled={!access.allowed}
              onChange={(event) => {
                if (isReviewStatus(event.target.value)) setStatus(event.target.value);
              }}
              options={automationReviewStatuses.map((value) => ({ value, label: reviewStatusLabels[value] }))}
            />
          )}
        </FormField>
        <FormField label="메모" description="판단 근거를 남기면 다음 검토자가 이어서 볼 수 있습니다.">
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              maxLength={500}
              value={note}
              disabled={!access.allowed}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </FormField>
        {access.reason ? <p className="wi-note">{access.reason}</p> : null}
        <Button type="submit" variant="primary" disabled={!access.allowed || review.isPending}>
          {review.isPending ? "기록하는 중" : "검토 상태 기록"}
        </Button>
      </form>
    </div>
  );
}
