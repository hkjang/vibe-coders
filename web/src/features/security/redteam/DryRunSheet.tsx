import type { RefObject } from "react";

import type { RedTeamDryRun } from "@/shared/api/domains/redteam";
import { Badge } from "@/shared/components/ui/Badge";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Sheet } from "@/shared/components/ui/Sheet";
import { formatKRW, formatNumber } from "@/shared/utils/format";

/** Shows what a campaign would touch: no upstream call is made for a dry run. */
export function DryRunSheet({
  onOpenChange,
  preview,
  returnFocusRef,
}: {
  onOpenChange: (open: boolean) => void;
  preview: RedTeamDryRun | undefined;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  return (
    <Sheet
      open={preview !== undefined}
      onOpenChange={onOpenChange}
      title="드라이런 결과"
      description="실제 호출 없이 이번 캠페인의 대상 범위와 예상 규모를 계산했습니다."
      returnFocusRef={returnFocusRef}
    >
      {preview ? (
        <div className="rt-stack">
          <KeyValueList
            items={[
              { label: "대상 수", value: formatNumber(preview.targets) },
              { label: "프로브 팩", value: formatNumber(preview.probe_packs) },
              { label: "실행 케이스", value: formatNumber(preview.case_executions) },
              { label: "예상 비용", value: formatKRW(preview.estimated_cost_krw) },
              {
                label: "실호출 가능 대상",
                value:
                  preview.active_eligible_targets > 0 ? (
                    `${formatNumber(preview.active_eligible_targets)}건`
                  ) : (
                    <Badge tone="warning">0건 — 실행해도 시뮬레이션</Badge>
                  ),
              },
              {
                label: "외부 provider 대상",
                value:
                  preview.external_targets > 0 ? (
                    <Badge tone="warning">{formatNumber(preview.external_targets)}건 · egress 주의</Badge>
                  ) : (
                    "0건"
                  ),
              },
              {
                label: "파괴적 MCP 대상",
                value: `${formatNumber(preview.destructive_tool_targets)}건`,
              },
              {
                label: "승인 필요",
                value: preview.requires_approval ? (
                  <Badge tone={preview.approved ? "success" : "warning"}>
                    {preview.approved ? "예 — 승인 완료" : "예 — 승인 필요"}
                  </Badge>
                ) : (
                  "아니오"
                ),
              },
              {
                label: "실행 가능",
                value: (
                  <Badge tone={preview.can_run ? "success" : "danger"}>
                    {preview.can_run ? "예" : "아니오 — 승인 후 실행"}
                  </Badge>
                ),
              },
              {
                label: "한도",
                value: `예산 ${formatKRW(preview.limits.budget_limit_krw)} · QPS ${formatNumber(preview.limits.qps_limit, 1)} · 동시성 ${formatNumber(preview.limits.concurrency)}`,
              },
            ]}
          />
          <p className="rt-note">{preview.note}</p>
        </div>
      ) : null}
    </Sheet>
  );
}
