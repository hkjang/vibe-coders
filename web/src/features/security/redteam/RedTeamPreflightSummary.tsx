import type { RedTeamDryRun } from "@/shared/api/domains/redteam";
import { Badge } from "@/shared/components/ui/Badge";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatKRW, formatNumber } from "@/shared/utils/format";

/** The server's can_run field checks approval only; it is not an execution permit. */
export function RedTeamPreflightSummary({ preview }: { preview: RedTeamDryRun }): React.JSX.Element {
  const budget = preview.limits.budget_limit_krw;
  const exceedsBudget = budget > 0 && preview.estimated_cost_krw > budget;
  return (
    <div className="rt-stack rt-preflight">
      <div className="rt-preflight-intro">
        <div className="rt-button-row">
          <Badge tone="info">실제 모델 호출 없음</Badge>
          {exceedsBudget ? <Badge tone="danger">예산 초과</Badge> : null}
          {!preview.can_run ? <Badge tone="warning">추가 승인 필요</Badge> : null}
        </div>
        <p>점검 당시의 예상 규모입니다. 실행 승인이나 현재 실행 가능 여부를 보장하지 않습니다.</p>
      </div>
      <SectionCard title="대상과 예상 규모" headingLevel={3}>
        <KeyValueList
          items={[
            { label: "점검 대상", value: `${formatNumber(preview.targets)}건` },
            { label: "보안 검사 묶음", value: `${formatNumber(preview.probe_packs)}개` },
            { label: "예상 검사 횟수", value: `${formatNumber(preview.case_executions)}회` },
            { label: "예상 비용", value: formatKRW(preview.estimated_cost_krw) },
            {
              label: "지정 모델",
              value:
                preview.models_selected > 0
                  ? `${formatNumber(preview.models_selected)}개`
                  : "지정 없음 · 실제 호출 시 자동 선택",
            },
          ]}
        />
        {preview.targets === 0 || preview.case_executions === 0 ? (
          <p className="rt-preflight-message">
            검사할 대상 또는 적용 가능한 검사가 없습니다. 캠페인의 범위와 검사 묶음을 확인하세요.
          </p>
        ) : null}
        <p>
          실제 호출 모드에서는 지정 모델 수에 따라 검사 횟수가 늘어납니다. 비용은 사전 추정치이며 실제
          청구액과 다를 수 있습니다.
        </p>
      </SectionCard>
      <SectionCard title="승인과 실제 호출 조건" headingLevel={3}>
        <KeyValueList
          items={[
            { label: "승인 필요", value: preview.requires_approval ? "필요" : "불필요" },
            { label: "저장된 승인 상태", value: preview.approved ? "승인됨" : "미승인" },
            {
              label: "모드별 승인 조건",
              value: (
                <Badge tone={preview.can_run ? "info" : "warning"}>
                  {preview.can_run ? "승인 조건 충족" : "승인 조건 미충족"}
                </Badge>
              ),
            },
            {
              label: "실제 호출 가능한 대상 유형",
              value: `${formatNumber(preview.active_eligible_targets)}건`,
            },
            {
              label: "외부 공급자 대상",
              value: (
                <Badge tone={preview.external_targets > 0 ? "warning" : "muted"}>
                  {formatNumber(preview.external_targets)}건
                </Badge>
              ),
            },
            {
              label: "파괴적 작업 위험 MCP 대상",
              value: (
                <Badge tone={preview.destructive_tool_targets > 0 ? "warning" : "muted"}>
                  {formatNumber(preview.destructive_tool_targets)}건
                </Badge>
              ),
            },
          ]}
        />
        <p>
          승인이 필요한 검사도 호출 없는 모드에서는 승인 조건을 충족할 수 있습니다. 실제 호출 여부는 실행
          모드·실행 키·대상 유형과 서버의 실행 시 검사에 따라 결정됩니다.
        </p>
        <p>
          긴급 중지 상태·키 권한·모델 연결은 이 결과로 확인되지 않습니다. 외부 공급자와 위험 도구의 수는 선택
          범위이며 호출 완료 건수가 아닙니다.
        </p>
      </SectionCard>
      <SectionCard title="실행 한도" headingLevel={3}>
        <KeyValueList
          items={[
            { label: "캠페인 예산", value: budget > 0 ? formatKRW(budget) : "별도 예산 한도 없음" },
            {
              label: "예상 비용 비교",
              value: (
                <Badge tone={exceedsBudget ? "danger" : "muted"}>
                  {exceedsBudget
                    ? "예산 초과 · 실행 전 조정 필요"
                    : budget > 0
                      ? "예산 이내의 추정치"
                      : "비교할 예산 없음"}
                </Badge>
              ),
            },
            {
              label: "실제 호출 속도",
              value:
                preview.limits.qps_limit > 0
                  ? `초당 ${formatNumber(preview.limits.qps_limit, 3)}회`
                  : "별도 속도 한도 없음",
            },
            { label: "저장된 동시 실행 수", value: `${formatNumber(preview.limits.concurrency)}개` },
            { label: "저장된 제한 시간", value: `${formatNumber(preview.limits.timeout_ms)}ms` },
          ]}
        />
        <p>
          저장된 설정값을 표시합니다. 동시 실행 수와 제한 시간이 실제 호출 전체에 적용된다는 뜻은 아닙니다.
          실행 시 서버가 예산과 긴급 중지 상태를 다시 검사합니다.
        </p>
      </SectionCard>
      <details className="rt-preflight-source">
        <summary>점검 식별자와 서버 안내</summary>
        <KeyValueList
          columns={1}
          items={[{ label: "캠페인 식별자", value: preview.campaign_id, mono: true }]}
        />
        {preview.note ? <p>{preview.note}</p> : <p>추가 서버 안내가 없습니다.</p>}
      </details>
    </div>
  );
}
