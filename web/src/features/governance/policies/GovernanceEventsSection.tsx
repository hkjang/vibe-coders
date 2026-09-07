import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import {
  approvalTone,
  decisionTone,
  eventWindowLabels,
  eventWindows,
  isEventWindow,
  secretActionTone,
  type EventWindow,
} from "@/features/governance/policies/governance-utils";
import { apiClient } from "@/shared/api/client";
import type { Approval } from "@/shared/api/domains/governance";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatKRW, formatNumber, shortId } from "@/shared/utils/format";

const routeId = "governance.policies";
const approvalStatuses = ["pending", "approved", "rejected", "expired", ""] as const;
const secretActions = ["", "detect", "mask", "block"] as const;
const decisions = ["", "block", "require_approval", "deny_model", "deny_provider", "mask", "detect"] as const;

function WindowPicker({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: EventWindow;
}): React.JSX.Element {
  return (
    <label className="toolbar">
      <span>{label}</span>
      <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {eventWindows.map((option) => (
          <option key={option} value={option}>
            {eventWindowLabels[option]}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function GovernanceEventsSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const [pendingDecision, setPendingDecision] = useState<
    { approval: Approval; decision: "approve" | "reject" } | undefined
  >();
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const requestedWindow = params.get("window");
  const window: EventWindow = isEventWindow(requestedWindow) ? requestedWindow : "24h";
  const approvalStatus = params.get("approval_status") ?? "pending";
  const secretAction = params.get("secret_action") ?? "";
  const decision = params.get("decision") ?? "";

  const secretEvents = useQuery({
    queryKey: ["governance", "secret-events", window, secretAction],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.secretEvents, {
        query: { window, limit: 80, ...(secretAction ? { action: secretAction } : {}) },
        signal,
        routeId,
      }),
  });
  const approvals = useQuery({
    queryKey: ["governance", "approvals", window, approvalStatus],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.approvals.list, {
        query: { window, limit: 50, ...(approvalStatus ? { status: approvalStatus } : {}) },
        signal,
        routeId,
      }),
  });
  const policyDecisions = useQuery({
    queryKey: ["governance", "policy-decisions", window, decision],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.policies.decisions, {
        query: { window, limit: 80, ...(decision ? { decision } : {}) },
        signal,
        routeId,
      }),
  });

  const decide = useMutationFeedback({
    mutate: (variables: { id: string; decision: "approve" | "reject" }) =>
      apiClient.request(
        withPathParams(
          variables.decision === "approve"
            ? endpoints.domains.governance.approvals.approve
            : endpoints.domains.governance.approvals.reject,
          { id: variables.id },
        ),
        { routeId },
      ),
    invalidates: [["governance", "approvals"]],
    successMessage: (_result, variables) =>
      variables.decision === "approve" ? "요청을 승인했습니다." : "요청을 거절했습니다.",
    errorMessage: "승인 상태를 변경하지 못했습니다.",
  });

  const secretRows = secretEvents.data?.secret_events ?? [];
  const approvalRows = approvals.data?.approvals ?? [];
  const decisionRows = policyDecisions.data?.policy_decisions ?? [];

  const secretColumns: ReadonlyArray<GovernanceColumn<(typeof secretRows)[number]>> = [
    { id: "created_at", header: "시각", cell: (row) => formatDateTime(row.created_at) },
    {
      id: "action",
      header: "동작",
      cell: (row) => <Badge tone={secretActionTone(row.action)}>{row.action ?? "—"}</Badge>,
    },
    { id: "secret_type", header: "유형", cell: (row) => row.secret_type || "—" },
    { id: "location", header: "위치", cell: (row) => row.location || "—" },
    { id: "team", header: "팀", cell: (row) => row.team_id || "—" },
    {
      id: "api_key",
      header: "API 키",
      cell: (row) => (
        <span className="mono" title={row.api_key_id}>
          {shortId(row.api_key_id)}
        </span>
      ),
    },
    {
      id: "request",
      header: "요청",
      cell: (row) => (
        <span className="mono" title={row.request_id}>
          {shortId(row.request_id)}
        </span>
      ),
    },
  ];

  const approvalColumns: ReadonlyArray<GovernanceColumn<Approval>> = [
    { id: "created_at", header: "요청 시각", cell: (row) => formatDateTime(row.created_at) },
    {
      id: "status",
      header: "상태",
      cell: (row) => <Badge tone={approvalTone(row.status)}>{row.status ?? "—"}</Badge>,
    },
    { id: "subject", header: "대상", cell: (row) => `${row.subject_type ?? "—"} ${row.subject_id ?? ""}` },
    { id: "reason", header: "사유", cell: (row) => row.reason || "—" },
    { id: "team", header: "팀", cell: (row) => row.team_id || "—" },
    {
      id: "risk",
      header: "위험도",
      cell: (row) => <span className="cell-number">{formatNumber(row.risk_score)}</span>,
    },
    {
      id: "cost",
      header: "비용",
      cell: (row) => <span className="cell-number">{formatKRW(row.cost_krw)}</span>,
    },
    { id: "expires", header: "만료", cell: (row) => formatDateTime(row.expires_at) },
    {
      id: "actions",
      header: "동작",
      cell: (row) =>
        row.status === "pending" ? (
          <span className="governance-actions">
            <Button
              size="small"
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
              aria-label={`승인 요청 ${row.id} 승인`}
              onClick={(event) => {
                rowTriggerRef.current = event.currentTarget;
                setPendingDecision({ approval: row, decision: "approve" });
              }}
            >
              승인
            </Button>
            <Button
              size="small"
              variant="danger"
              disabled={!canWrite}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
              aria-label={`승인 요청 ${row.id} 거절`}
              onClick={(event) => {
                rowTriggerRef.current = event.currentTarget;
                setPendingDecision({ approval: row, decision: "reject" });
              }}
            >
              거절
            </Button>
          </span>
        ) : (
          <span>{row.decided_by || "—"}</span>
        ),
    },
  ];

  const decisionColumns: ReadonlyArray<GovernanceColumn<(typeof decisionRows)[number]>> = [
    { id: "created_at", header: "시각", cell: (row) => formatDateTime(row.created_at) },
    {
      id: "decision",
      header: "판단",
      cell: (row) => <Badge tone={decisionTone(row.decision)}>{row.decision ?? "—"}</Badge>,
    },
    { id: "rule", header: "규칙", cell: (row) => row.rule_name || row.rule_id || "—" },
    { id: "reason", header: "사유", cell: (row) => row.reason || "—" },
    { id: "model", header: "모델", cell: (row) => row.model || "—" },
    { id: "team", header: "팀", cell: (row) => row.team_id || "—" },
    {
      id: "request",
      header: "요청",
      cell: (row) => (
        <span className="mono" title={row.request_id}>
          {shortId(row.request_id)}
        </span>
      ),
    },
  ];

  return (
    <>
      <SectionCard
        title="Secret Firewall 이벤트"
        description="프롬프트에서 탐지된 비밀정보와 마스킹·차단 결과입니다. 원문과 값은 표시하지 않습니다."
        actions={
          <div className="governance-actions">
            <WindowPicker
              label="조회 기간"
              value={window}
              onChange={(value) => updateSearch({ window: value })}
            />
            <FormField label="동작" id="secret-action">
              {(control) => (
                <Select
                  {...control}
                  value={secretAction}
                  onChange={(event) => updateSearch({ secret_action: event.target.value || undefined })}
                >
                  {secretActions.map((action) => (
                    <option key={action || "all"} value={action}>
                      {action || "전체 동작"}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </div>
        }
      >
        {secretEvents.isError ? (
          <PanelFailure
            error={secretEvents.error}
            hasData={Boolean(secretEvents.data)}
            label="Secret Firewall 이벤트"
            onRetry={() => void secretEvents.refetch()}
          />
        ) : null}
        <GovernanceTable
          caption="Secret Firewall 이벤트"
          columns={secretColumns}
          rows={secretRows}
          loading={secretEvents.isPending}
          emptyMessage="선택한 기간에 탐지된 비밀정보 이벤트가 없습니다."
        />
      </SectionCard>

      <SectionCard
        title="승인 큐"
        description="승인/거절 후 클라이언트는 X-Governance-Approval-ID 헤더로 같은 요청을 재전송합니다."
        actions={
          <FormField label="상태" id="approval-status">
            {(control) => (
              <Select
                {...control}
                value={approvalStatus}
                onChange={(event) => updateSearch({ approval_status: event.target.value || undefined })}
              >
                {approvalStatuses.map((status) => (
                  <option key={status || "all"} value={status}>
                    {status || "전체"}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        }
      >
        {approvals.isError ? (
          <PanelFailure
            error={approvals.error}
            hasData={Boolean(approvals.data)}
            label="승인 큐"
            onRetry={() => void approvals.refetch()}
          />
        ) : null}
        <GovernanceTable
          caption="승인 대기 큐"
          columns={approvalColumns}
          rows={approvalRows}
          loading={approvals.isPending}
          emptyMessage="선택한 조건의 승인 요청이 없습니다."
        />
      </SectionCard>

      <SectionCard
        title="정책 판단 이벤트"
        description="정책 엔진이 내린 판단의 감사 기록입니다."
        actions={
          <FormField label="판단" id="policy-decision">
            {(control) => (
              <Select
                {...control}
                value={decision}
                onChange={(event) => updateSearch({ decision: event.target.value || undefined })}
              >
                {decisions.map((value) => (
                  <option key={value || "all"} value={value}>
                    {value || "전체 판단"}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        }
      >
        {policyDecisions.isError ? (
          <PanelFailure
            error={policyDecisions.error}
            hasData={Boolean(policyDecisions.data)}
            label="정책 판단 이벤트"
            onRetry={() => void policyDecisions.refetch()}
          />
        ) : null}
        <GovernanceTable
          caption="정책 판단 이벤트"
          columns={decisionColumns}
          rows={decisionRows}
          loading={policyDecisions.isPending}
          emptyMessage="선택한 기간에 기록된 정책 판단이 없습니다."
        />
      </SectionCard>

      <ConfirmDialog
        open={pendingDecision !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDecision(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title={pendingDecision?.decision === "approve" ? "요청을 승인할까요?" : "요청을 거절할까요?"}
        description={
          pendingDecision?.decision === "approve"
            ? "승인하면 클라이언트가 같은 요청을 다시 보내 실행할 수 있습니다."
            : "거절하면 클라이언트의 재전송이 차단됩니다."
        }
        confirmLabel={pendingDecision?.decision === "approve" ? "승인" : "거절"}
        tone={pendingDecision?.decision === "approve" ? "primary" : "danger"}
        onConfirm={async () => {
          if (pendingDecision) {
            await decide.mutateAsync({
              id: pendingDecision.approval.id,
              decision: pendingDecision.decision,
            });
          }
        }}
      />
    </>
  );
}
