import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, PlayCircle, RefreshCw, Undo2 } from "lucide-react";
import { useRef, useState } from "react";

import { PanelFailure } from "@/features/governance/policies/governance-parts";
import { severityLabel, severityTone } from "@/features/governance/policies/governance-utils";
import { apiClient } from "@/shared/api/client";
import type {
  RemediationAction,
  RemediationApplyResult,
  RemediationPlaybook,
} from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatNumber } from "@/shared/utils/format";
import "@/features/governance/policies/policies.css";

const routeId = "governance.remediation";
// The legacy screen kept this window in sessionStorage; the console keeps it in the URL.
const windowOptions = ["1h", "6h", "24h", "72h"] as const;

function isWindow(value: string | null): value is (typeof windowOptions)[number] {
  return (windowOptions as readonly string[]).includes(value ?? "");
}

function countActions(
  playbooks: ReadonlyArray<RemediationPlaybook>,
  predicate: (action: RemediationAction) => boolean,
): number {
  return playbooks.reduce((total, playbook) => total + (playbook.actions ?? []).filter(predicate).length, 0);
}

export function RemediationPage(): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<
    { action: RemediationAction; result: RemediationApplyResult } | undefined
  >();
  const [pendingApply, setPendingApply] = useState<RemediationAction | undefined>();
  const [pendingRollback, setPendingRollback] = useState<
    { actionType: string; params: Record<string, unknown> } | undefined
  >();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const requested = params.get("window");
  const selectedWindow = isWindow(requested) ? requested : "6h";

  const playbooks = useQuery({
    queryKey: ["governance", "remediation", selectedWindow],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.remediation.playbooks, {
        query: { window: selectedWindow },
        signal,
        routeId,
      }),
  });

  const dryRun = useMutationFeedback({
    mutate: (action: RemediationAction) =>
      apiClient.request(endpoints.domains.governance.remediation.apply, {
        body: {
          action_type: action.type ?? "",
          params: action.params ?? {},
          reason: "dry-run preview",
          dry_run: true,
        },
        routeId,
      }),
    errorMessage: "영향 미리보기를 실행하지 못했습니다.",
    onSuccess: (result, action) => setPreview({ action, result }),
  });

  const apply = useMutationFeedback({
    mutate: (variables: { actionType: string; params: Record<string, unknown>; reason: string }) =>
      apiClient.request(endpoints.domains.governance.remediation.apply, {
        body: {
          action_type: variables.actionType,
          params: variables.params,
          reason: variables.reason,
          dry_run: false,
        },
        routeId,
      }),
    invalidates: [["governance", "remediation"]],
    successMessage: "조치를 적용했습니다. 결과 패널에서 되돌리기 정보를 확인하세요.",
    errorMessage: "조치를 적용하지 못했습니다.",
    onSuccess: (result) => {
      if (result.action_type) {
        setPreview((current) => (current ? { ...current, result } : current));
      }
    },
  });

  const rows = playbooks.data?.playbooks ?? [];
  const executable = countActions(rows, (action) => action.executable === true);
  const critical = countActions(rows, (action) => action.severity === "critical");
  const warning = countActions(rows, (action) => action.severity === "warning");
  const reversible = countActions(rows, (action) => action.reversible === true);
  const overall = playbooks.data?.overall_severity;

  return (
    <div className="page-stack">
      <PageHeader
        title="자동 조치"
        status="preview"
        description="현재 운영 상황에서 실행 가능한 되돌릴 수 있는 조치 후보입니다. 적용 전에 영향을 미리 확인하세요."
        legacyHref="/admin#/remediation"
        actions={
          <div className="governance-actions">
            <label className="toolbar">
              <span>조회 기간</span>
              <Select
                aria-label="자동 조치 조회 기간"
                value={selectedWindow}
                onChange={(event) => updateSearch({ window: event.target.value })}
              >
                {windowOptions.map((value) => (
                  <option key={value} value={value}>
                    최근 {value}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              variant="primary"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ["governance", "remediation"] })}
            >
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </div>
        }
      />

      <StatGrid label="자동 조치 요약">
        <StatCard
          label="종합 상태"
          value={severityLabel(overall)}
          tone={overall === "critical" ? "danger" : overall === "warning" ? "warning" : "success"}
        />
        <StatCard label="감지 상황" value={formatNumber(rows.length)} />
        <StatCard label="심각·경고" value={formatNumber(critical + warning)} tone="warning" />
        <StatCard label="실행 가능" value={formatNumber(executable)} tone="info" />
        <StatCard label="되돌리기 가능" value={formatNumber(reversible)} />
      </StatGrid>

      {playbooks.isError ? (
        <PanelFailure
          error={playbooks.error}
          hasData={Boolean(playbooks.data)}
          label="자동 조치 후보"
          onRetry={() => void playbooks.refetch()}
        />
      ) : null}

      {playbooks.isPending ? (
        <p role="status">조치 후보를 불러오는 중입니다.</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="지금 필요한 조치가 없습니다."
          description="공급자 저하, 비용 급증, MCP 오류, Text2SQL 위험이 감지되면 되돌릴 수 있는 조치 후보가 표시됩니다."
        />
      ) : (
        rows.map((playbook, index) => (
          <SectionCard
            key={`${playbook.situation ?? "playbook"}-${index}`}
            title={playbook.situation ?? "상황"}
            description={playbook.summary}
            actions={<Badge tone={severityTone(playbook.severity)}>{severityLabel(playbook.severity)}</Badge>}
          >
            <div className="governance-playbook">
              {(playbook.actions ?? []).map((action) => (
                <article key={action.id} className="governance-action-card">
                  <h3>{action.title ?? action.type}</h3>
                  <p>{action.description}</p>
                  <KeyValueList
                    columns={1}
                    items={[
                      {
                        label: "예상 변경",
                        value: <span className="governance-dry-run">{action.dry_run}</span>,
                      },
                      { label: "예상 영향", value: action.expected_impact },
                      {
                        label: "실행",
                        value: action.executable ? (
                          <Badge tone="info">자동 실행 가능</Badge>
                        ) : (
                          <Badge tone="muted">수동 조치</Badge>
                        ),
                      },
                      {
                        label: "되돌리기",
                        value: action.reversible ? "가능" : "불가",
                      },
                    ]}
                  />
                  <div className="governance-actions">
                    <Button
                      disabled={!action.executable || dryRun.isPending}
                      title={action.executable ? undefined : "수동 조치는 미리보기를 지원하지 않습니다."}
                      aria-label={`${action.title ?? action.type} 영향 미리보기`}
                      onClick={(event) => {
                        triggerRef.current = event.currentTarget;
                        dryRun.mutate(action);
                      }}
                    >
                      <Eye aria-hidden="true" /> 영향 미리보기
                    </Button>
                    <Button
                      variant="danger"
                      disabled={!action.executable}
                      title={action.executable ? undefined : "수동 조치는 해당 화면에서 처리하세요."}
                      aria-label={`${action.title ?? action.type} 승인 후 적용`}
                      onClick={(event) => {
                        triggerRef.current = event.currentTarget;
                        setPendingApply(action);
                      }}
                    >
                      <PlayCircle aria-hidden="true" /> 승인 후 적용
                    </Button>
                    {action.link ? (
                      <a className="button button-secondary button-small" href={`/admin${action.link}`}>
                        기존 화면에서 처리
                      </a>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </SectionCard>
        ))
      )}

      {playbooks.data?.note ? <InlineNotice tone="info">{playbooks.data.note}</InlineNotice> : null}

      <Sheet
        open={preview !== undefined}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
        returnFocusRef={triggerRef}
        title={preview?.action.title ?? "조치 결과"}
        description={
          preview?.result.applied
            ? "조치가 적용되었습니다. 되돌리기 정보를 확인하세요."
            : "적용되지 않은 미리보기 결과입니다."
        }
        size="wide"
      >
        {preview ? (
          <div className="page-stack">
            <KeyValueList
              items={[
                { label: "조치 유형", value: preview.result.action_type ?? preview.action.type, mono: true },
                { label: "적용 여부", value: preview.result.applied ? "적용됨" : "미리보기" },
                { label: "안내", value: preview.result.note },
              ]}
            />
            <JsonBlock label="변경 전" value={preview.result.before ?? {}} />
            <JsonBlock label="변경 후" value={preview.result.after ?? {}} />
            {preview.result.applied && preview.result.rollback?.action_type ? (
              <Button
                variant="danger"
                onClick={() =>
                  setPendingRollback({
                    actionType: preview.result.rollback?.action_type ?? "",
                    params: (preview.result.rollback?.params ?? {}) as Record<string, unknown>,
                  })
                }
              >
                <Undo2 aria-hidden="true" /> 이 조치 되돌리기
              </Button>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={pendingApply !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingApply(undefined);
        }}
        returnFocusRef={triggerRef}
        title="이 조치를 적용할까요?"
        description={`"${pendingApply?.title ?? ""}" 조치를 실제로 적용합니다. ${pendingApply?.expected_impact ?? ""}`}
        confirmLabel="적용"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          if (pendingApply) {
            const result = await apply.mutateAsync({
              actionType: pendingApply.type ?? "",
              params: (pendingApply.params ?? {}) as Record<string, unknown>,
              reason,
            });
            setPreview({ action: pendingApply, result });
          }
        }}
      />

      <ConfirmDialog
        open={pendingRollback !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingRollback(undefined);
        }}
        returnFocusRef={triggerRef}
        title="조치를 되돌릴까요?"
        description="직전에 적용한 조치를 원래 상태로 되돌립니다."
        confirmLabel="되돌리기"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          if (pendingRollback) {
            await apply.mutateAsync({
              actionType: pendingRollback.actionType,
              params: pendingRollback.params,
              reason: `rollback: ${reason}`,
            });
            setPendingRollback(undefined);
            setPreview(undefined);
          }
        }}
      />
    </div>
  );
}
