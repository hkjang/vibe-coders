import { useId } from "react";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Select } from "@/shared/components/ui/Select";
import type { TraceSafeFlow } from "@/shared/api/domains/trace-safe-flow.schema";
import { stepKinds, stepStatuses, type StepKind, type StepStatus } from "@/shared/utils/trace-step-query";

export function TraceStepFilters({
  spans,
  kind,
  status,
  visibleCount,
  onChange,
}: {
  spans: TraceSafeFlow["spans"];
  kind: StepKind;
  status: StepStatus;
  visibleCount: number;
  onChange: (kind: StepKind, status: StepStatus) => void;
}) {
  const id = useId();
  const children = spans.slice(1);
  const counts = { ok: 0, error: 0, skipped: 0, unknown: 0 };
  for (const child of children) counts[child.status] += 1;
  const active = kind !== "all" || status !== "all";
  return (
    <div className="trace-step-explorer">
      <div className="trace-step-summary" role="group" aria-label="조회된 하위 단계 상태 요약">
        <strong>조회된 하위 단계 {children.length.toLocaleString("ko-KR")}개</strong>
        <Badge tone={counts.error ? "danger" : "muted"}>오류 {counts.error}개</Badge>
        <Badge tone={counts.ok ? "success" : "muted"}>정상 {counts.ok}개</Badge>
        <Badge>건너뜀 {counts.skipped}개</Badge>
        <Badge>확인 불가 {counts.unknown}개</Badge>
      </div>
      <fieldset className="trace-step-filters" aria-describedby={`${id}-hint`}>
        <legend>하위 단계 필터</legend>
        <label htmlFor={`${id}-kind`}>
          단계 유형
          <Select
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => onChange(event.target.value as StepKind, status)}
          >
            {Object.entries(stepKinds).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor={`${id}-status`}>
          단계 상태
          <Select
            id={`${id}-status`}
            value={status}
            onChange={(event) => onChange(kind, event.target.value as StepStatus)}
          >
            {Object.entries(stepStatuses).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <Button
          size="small"
          aria-disabled={!active}
          onClick={() => {
            if (active) onChange("all", "all");
          }}
        >
          단계 필터 초기화
        </Button>
      </fieldset>
      <p id={`${id}-hint`}>조회된 하위 단계에만 적용합니다. 부모 요청과 시간축 기준은 유지됩니다.</p>
      <p role="status" aria-label="단계 필터 결과" aria-live="polite" aria-atomic="true">
        하위 단계 {children.length.toLocaleString("ko-KR")}개 중 {visibleCount.toLocaleString("ko-KR")}개 표시
        {active && visibleCount === 0
          ? " · 조건에 맞는 하위 단계가 없습니다. 필터를 변경하거나 초기화하세요."
          : ""}
      </p>
    </div>
  );
}
