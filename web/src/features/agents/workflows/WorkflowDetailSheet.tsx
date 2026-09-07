import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type RefObject } from "react";

import { workflowStepTypeLabels } from "@/features/agents/workflows/workflow-form";
import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import type { Workflow, WorkflowDryRun, WorkflowStep } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

interface WorkflowDetailSheetProps {
  canWrite: boolean;
  dryRun: WorkflowDryRun | undefined;
  dryRunError: Error | null;
  dryRunPending: boolean;
  onDelete: () => void;
  onDryRun: () => void;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  onPublish: () => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  workflow: Workflow | undefined;
  writeDisabledReason: string;
}

function stepLabel(step: WorkflowStep): string {
  const type = step.type ?? "";
  return workflowStepTypeLabels[type as keyof typeof workflowStepTypeLabels] ?? type ?? "—";
}

function StepTable({ steps }: { steps: readonly WorkflowStep[] }): React.JSX.Element {
  if (steps.length === 0) {
    return <EmptyState title="단계가 없습니다." description="워크플로를 수정해 단계를 추가하세요." />;
  }
  return (
    <div className="data-table-scroll" tabIndex={0} aria-label="워크플로 단계 표 영역">
      <table className="data-table">
        <caption className="sr-only">워크플로 단계 정의</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">이름</th>
            <th scope="col">종류</th>
            <th scope="col">참조</th>
            <th scope="col">제한</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step, index) => (
            <tr key={`${step.name ?? ""}-${index}`}>
              <td className="cell-number">{index + 1}</td>
              <td>{step.name ?? "—"}</td>
              <td>{stepLabel(step)}</td>
              <td className="mono">{step.ref ?? "—"}</td>
              <td>
                {[
                  step.timeout_ms ? `${formatNumber(step.timeout_ms)}ms` : "",
                  step.max_tokens ? `${formatNumber(step.max_tokens)} 토큰` : "",
                  step.max_cost_krw ? `₩${formatNumber(step.max_cost_krw, 2)}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WorkflowDetailSheet({
  canWrite,
  dryRun,
  dryRunError,
  dryRunPending,
  onDelete,
  onDryRun,
  onEdit,
  onOpenChange,
  onPublish,
  open,
  returnFocusRef,
  workflow,
  writeDisabledReason,
}: WorkflowDetailSheetProps): React.JSX.Element {
  const [showVersions, setShowVersions] = useState(false);
  const versionsButtonRef = useRef<HTMLButtonElement>(null);
  const workflowId = workflow?.id ?? "";
  const versions = useQuery({
    queryKey: ["agents", "workflows", workflowId, "versions"],
    enabled: open && showVersions && workflowId !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.workflows.versions, { id: workflowId }), {
        signal,
        routeId: "agents.workflows",
      }),
  });
  const steps = workflow?.steps ?? [];

  return (
    <Sheet
      description="워크플로 정의를 확인하고 드라이런·게시·버전 이력을 조회합니다."
      onOpenChange={(next) => {
        if (!next) setShowVersions(false);
        onOpenChange(next);
      }}
      open={open}
      returnFocusRef={returnFocusRef}
      size="wide"
      title={workflow?.name ?? "워크플로"}
    >
      {!workflow ? (
        <EmptyState title="워크플로를 찾을 수 없습니다." description="목록에서 다시 선택하세요." />
      ) : (
        <div className="agents-detail-stack">
          <KeyValueList
            items={[
              { label: "ID", value: workflow.id, mono: true },
              {
                label: "상태",
                value: (
                  <Badge tone={workflow.enabled ? "success" : "muted"}>
                    {workflow.enabled ? "사용" : "중지"}
                  </Badge>
                ),
              },
              { label: "설명", value: workflow.description },
              { label: "허용 팀", value: workflow.allowed_teams || "전체" },
              { label: "단계 수", value: formatNumber(steps.length) },
              { label: "만든 사람", value: workflow.created_by },
              { label: "수정일", value: formatDateTime(workflow.updated_at) },
            ]}
          />

          <div className="agents-detail-actions">
            <Button variant="primary" onClick={onDryRun} disabled={dryRunPending}>
              {dryRunPending ? "검증 중" : "드라이런"}
            </Button>
            <Button
              onClick={onPublish}
              disabled={!canWrite}
              title={canWrite ? undefined : writeDisabledReason}
            >
              게시
            </Button>
            <Button
              ref={versionsButtonRef}
              onClick={() => setShowVersions((current) => !current)}
              aria-expanded={showVersions}
            >
              버전 이력
            </Button>
            <Button onClick={onEdit} disabled={!canWrite} title={canWrite ? undefined : writeDisabledReason}>
              수정
            </Button>
            <Button
              variant="danger"
              onClick={onDelete}
              disabled={!canWrite}
              title={canWrite ? undefined : writeDisabledReason}
            >
              삭제
            </Button>
          </div>
          {!canWrite ? (
            <InlineNotice tone="info" title="읽기 전용">
              {writeDisabledReason}
            </InlineNotice>
          ) : null}

          <SectionCard title="단계" headingLevel={3}>
            <StepTable steps={steps} />
          </SectionCard>

          {dryRunError ? (
            <InlineNotice tone="danger" title="드라이런에 실패했습니다.">
              {safeAppErrorMessage(dryRunError, "드라이런을 실행하지 못했습니다.")}
            </InlineNotice>
          ) : null}
          {dryRun ? (
            <SectionCard title="드라이런 결과" headingLevel={3} description={dryRun.note ?? undefined}>
              <InlineNotice tone={dryRun.ok ? "success" : "warning"}>
                {dryRun.ok
                  ? "모든 단계가 확인되었습니다. 게시할 수 있습니다."
                  : "해결되지 않은 단계가 있어 게시할 수 없습니다."}
              </InlineNotice>
              {(dryRun.issues ?? []).length > 0 ? (
                <ul className="agents-checklist">
                  {(dryRun.issues ?? []).map((issue) => (
                    <li key={issue} data-ok="false">
                      <span className="agents-checklist-copy">{issue}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul className="agents-checklist">
                {(dryRun.steps ?? []).map((step, index) => (
                  <li key={`${step.name ?? ""}-${index}`} data-ok={String(step.resolved !== false)}>
                    <span className="agents-checklist-copy">
                      <strong>
                        {index + 1}. {step.name || step.type || "단계"}
                      </strong>
                      <small>
                        {step.type ?? "—"}
                        {step.ref ? ` · ${step.ref}` : ""}
                        {step.detail ? ` · ${step.detail}` : ""}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {showVersions ? (
            <SectionCard title="버전 이력" headingLevel={3}>
              {versions.isPending ? (
                <p role="status">버전 이력을 불러오는 중입니다.</p>
              ) : versions.isError ? (
                <InlineNotice
                  tone="danger"
                  title="버전 이력을 불러오지 못했습니다."
                  actions={
                    <Button size="small" onClick={() => void versions.refetch()}>
                      다시 시도
                    </Button>
                  }
                >
                  {safeAppErrorMessage(versions.error, "버전 이력을 불러오지 못했습니다.")}
                </InlineNotice>
              ) : (versions.data?.versions ?? []).length === 0 ? (
                <EmptyState
                  title="게시된 버전이 없습니다."
                  description="드라이런을 통과한 뒤 게시하면 첫 버전이 만들어집니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="워크플로 버전 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">워크플로 게시 버전 이력</caption>
                    <thead>
                      <tr>
                        <th scope="col">버전</th>
                        <th scope="col">게시자</th>
                        <th scope="col">게시일</th>
                        <th scope="col">단계</th>
                        <th scope="col">메모</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(versions.data?.versions ?? []).map((version) => (
                        <tr key={version.id ?? String(version.version)}>
                          <td className="cell-number">v{formatNumber(version.version)}</td>
                          <td>{version.published_by ?? "—"}</td>
                          <td>{formatDateTime(version.published_at)}</td>
                          <td className="cell-number">{formatNumber(version.steps?.length ?? 0)}</td>
                          <td className="truncate">{version.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
