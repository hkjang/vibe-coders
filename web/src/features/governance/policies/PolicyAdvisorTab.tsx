import { useQuery } from "@tanstack/react-query";
import { FlaskConical, Wand2 } from "lucide-react";
import { useRef, useState } from "react";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { compactJson, severityLabel, severityTone } from "@/features/governance/policies/governance-utils";
import { apiClient } from "@/shared/api/client";
import type { Policy, PolicySimulation, PolicySuggestion } from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

const routeId = "governance.policies";
const advisorWindows = ["24h", "7d", "30d"] as const;
const canaryDayOptions = [7, 14, 30] as const;

export function PolicyAdvisorTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const [simulation, setSimulation] = useState<
    { suggestion: PolicySuggestion; result: PolicySimulation } | undefined
  >();
  const [pendingApply, setPendingApply] = useState<PolicySuggestion | undefined>();
  const [pendingBump, setPendingBump] = useState<{ policyId: string; next: number } | undefined>();
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const requestedWindow = params.get("advisor_window") ?? "";
  const window = (advisorWindows as readonly string[]).includes(requestedWindow) ? requestedWindow : "7d";
  const requestedDays = Number(params.get("canary_days"));
  const canaryDays = (canaryDayOptions as readonly number[]).includes(requestedDays) ? requestedDays : 7;

  const suggestions = useQuery({
    queryKey: ["governance", "advisor", window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.advisor.suggestions, {
        query: { window },
        signal,
        routeId,
      }),
  });
  const canary = useQuery({
    queryKey: ["governance", "canary", canaryDays],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.policies.canaryStatus, {
        query: { days: canaryDays },
        signal,
        routeId,
      }),
  });
  const policies = useQuery({
    queryKey: ["governance", "policies"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.policies.list, { signal, routeId }),
  });

  const simulate = useMutationFeedback({
    mutate: (suggestion: PolicySuggestion) =>
      apiClient.request(endpoints.domains.governance.policies.simulate, {
        body: {
          rules: [
            {
              name: suggestion.title ?? suggestion.id,
              conditions: suggestion.conditions ?? {},
              actions: suggestion.actions ?? {},
            },
          ],
          window,
        },
        routeId,
      }),
    errorMessage: "섀도우 영향을 계산하지 못했습니다.",
    onSuccess: (result, suggestion) => setSimulation({ suggestion, result }),
  });

  const applyDraft = useMutationFeedback({
    mutate: (suggestion: PolicySuggestion) =>
      apiClient.request(endpoints.domains.governance.advisor.apply, {
        body: {
          title: suggestion.title ?? suggestion.id,
          conditions: suggestion.conditions ?? {},
          actions: suggestion.actions ?? {},
        },
        routeId,
      }),
    invalidates: [["governance", "policies"]],
    successMessage: "비활성 draft 정책으로 생성했습니다. 정책 탭에서 검토 후 사용하세요.",
    errorMessage: "draft 정책을 만들지 못했습니다.",
  });

  const bumpRollout = useMutationFeedback({
    mutate: (variables: { policy: Policy; next: number }) =>
      apiClient.request(endpoints.domains.governance.policies.save, {
        body: {
          id: variables.policy.id,
          name: variables.policy.name ?? variables.policy.id,
          description: variables.policy.description ?? "",
          enabled: variables.policy.enabled !== false,
          priority: Number(variables.policy.priority ?? 100),
          rollout_percent: variables.next,
          rules: (variables.policy.rules ?? []).map((rule) => ({
            ...(rule.id ? { id: rule.id } : {}),
            name: rule.name ?? "",
            enabled: rule.enabled ?? true,
            priority: Number(rule.priority ?? 100),
            conditions: rule.conditions ?? {},
            actions: rule.actions ?? {},
          })),
        },
        routeId,
      }),
    invalidates: [
      ["governance", "policies"],
      ["governance", "canary"],
    ],
    successMessage: "canary 적용 비율을 상향했습니다.",
    errorMessage: "적용 비율을 변경하지 못했습니다.",
  });

  const suggestionRows = suggestions.data?.suggestions ?? [];
  const canaryRows = canary.data?.policies ?? [];

  const suggestionColumns: ReadonlyArray<GovernanceColumn<PolicySuggestion>> = [
    {
      id: "severity",
      header: "심각도",
      cell: (row) => <Badge tone={severityTone(row.severity)}>{severityLabel(row.severity)}</Badge>,
    },
    {
      id: "title",
      header: "추천",
      cell: (row) => (
        <span>
          <strong>{row.title || row.id}</strong>
          <br />
          {row.rationale}
        </span>
      ),
    },
    {
      id: "rule",
      header: "규칙",
      cell: (row) => (
        <span className="mono">
          if {compactJson(row.conditions)} → {compactJson(row.actions)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "동작",
      cell: (row) => (
        <span className="governance-actions">
          <Button
            size="small"
            disabled={!canWrite || simulate.isPending}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            aria-label={`${row.title ?? row.id} 섀도우 영향 확인`}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              simulate.mutate(row);
            }}
          >
            <FlaskConical aria-hidden="true" /> 섀도우 영향
          </Button>
          <Button
            size="small"
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            aria-label={`${row.title ?? row.id} draft 정책 생성`}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              setPendingApply(row);
            }}
          >
            <Wand2 aria-hidden="true" /> draft 생성
          </Button>
        </span>
      ),
    },
  ];

  const canaryColumns: ReadonlyArray<GovernanceColumn<(typeof canaryRows)[number]>> = [
    { id: "name", header: "정책", cell: (row) => row.name || row.policy_id },
    {
      id: "rollout",
      header: "적용 비율",
      cell: (row) => <Badge tone="warning">{formatNumber(row.rollout_percent)}%</Badge>,
    },
    {
      id: "enforced",
      header: "실집행",
      cell: (row) => <span className="cell-number">{formatNumber(row.enforced_acts)}</span>,
    },
    {
      id: "shadow",
      header: "섀도우",
      cell: (row) => <span className="cell-number">{formatNumber(row.shadow_acts)}</span>,
    },
    {
      id: "next",
      header: "권장 상향",
      cell: (row) => <span className="cell-number">{formatNumber(row.suggested_next)}%</span>,
    },
    {
      id: "actions",
      header: "동작",
      cell: (row) => (
        <Button
          size="small"
          disabled={!canWrite || policies.data === undefined}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
          aria-label={`${row.name ?? row.policy_id} 적용 비율 상향`}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setPendingBump({ policyId: row.policy_id, next: Number(row.suggested_next ?? 100) });
          }}
        >
          상향
        </Button>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <SectionCard
        title="정책 어드바이저"
        description="최근 신호를 근거로 추천한 정책 규칙입니다. 적용하면 비활성 draft 정책으로 생성됩니다."
        actions={
          <label className="toolbar">
            <span>분석 기간</span>
            <Select
              aria-label="정책 어드바이저 분석 기간"
              value={window}
              onChange={(event) => updateSearch({ advisor_window: event.target.value })}
            >
              {advisorWindows.map((value) => (
                <option key={value} value={value}>
                  최근 {value}
                </option>
              ))}
            </Select>
          </label>
        }
      >
        {suggestions.isError ? (
          <PanelFailure
            error={suggestions.error}
            hasData={Boolean(suggestions.data)}
            label="정책 추천"
            onRetry={() => void suggestions.refetch()}
          />
        ) : null}
        {!suggestions.isPending && !suggestions.isError && suggestionRows.length === 0 ? (
          <EmptyState
            title="지금 추천할 정책이 없습니다."
            description="비용 급증, 비밀정보 탐지, MCP 도구 오류가 감지되면 근거와 함께 정책을 추천합니다."
          />
        ) : (
          <GovernanceTable
            caption="정책 추천 목록"
            columns={suggestionColumns}
            rows={suggestionRows}
            loading={suggestions.isPending}
            error={suggestions.isError && !suggestions.data ? "추천을 불러오지 못했습니다." : undefined}
            onRetry={() => void suggestions.refetch()}
          />
        )}
      </SectionCard>

      <SectionCard
        title="Canary 롤아웃 현황"
        description="적용 비율이 100% 미만인 정책의 실집행과 섀도우(미적용 would-block) 활동을 비교합니다."
        actions={
          <label className="toolbar">
            <span>집계 기간</span>
            <Select
              aria-label="canary 집계 기간"
              value={String(canaryDays)}
              onChange={(event) => updateSearch({ canary_days: event.target.value })}
            >
              {canaryDayOptions.map((days) => (
                <option key={days} value={days}>
                  최근 {days}일
                </option>
              ))}
            </Select>
          </label>
        }
      >
        {canary.isError ? (
          <PanelFailure
            error={canary.error}
            hasData={Boolean(canary.data)}
            label="canary 현황"
            onRetry={() => void canary.refetch()}
          />
        ) : null}
        <GovernanceTable
          caption="canary 정책 현황"
          columns={canaryColumns}
          rows={canaryRows}
          loading={canary.isPending}
          emptyMessage="단계 적용 중인 정책이 없습니다."
        />
      </SectionCard>

      <Sheet
        open={simulation !== undefined}
        onOpenChange={(open) => {
          if (!open) setSimulation(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="섀도우 영향 분석"
        description="과거 요청에 이 규칙을 재생해 차단 규모와 오탐 후보를 추정합니다."
        size="wide"
      >
        {simulation ? (
          <KeyValueList
            items={[
              { label: "추천", value: simulation.suggestion.title ?? simulation.suggestion.id },
              { label: "평가한 요청", value: formatNumber(simulation.result.evaluated) },
              { label: "차단 예상", value: formatNumber(simulation.result.blocked) },
              { label: "승인 요구 예상", value: formatNumber(simulation.result.require_approval) },
              { label: "차단률", value: formatPercent(simulation.result.block_rate) },
              {
                label: "영향 API 키",
                value: formatNumber(simulation.result.shadow?.affected_keys),
              },
              { label: "영향 팀", value: formatNumber(simulation.result.shadow?.affected_teams) },
              {
                label: "오탐 후보",
                value: formatNumber(simulation.result.shadow?.false_positive_candidates),
              },
              {
                label: "오탐률",
                value: formatPercent(simulation.result.shadow?.false_positive_rate),
              },
              {
                label: "차단될 요청의 과거 비용",
                value: formatKRW(simulation.result.shadow?.blocked_cost_krw),
              },
            ]}
          />
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={pendingApply !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingApply(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="draft 정책을 생성할까요?"
        description="추천 규칙으로 비활성(draft) 정책을 만듭니다. 정책 탭에서 검토한 뒤 사용으로 전환하세요."
        confirmLabel="draft 생성"
        onConfirm={async () => {
          if (pendingApply) await applyDraft.mutateAsync(pendingApply);
        }}
      />

      <ConfirmDialog
        open={pendingBump !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingBump(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="canary 적용 비율을 상향할까요?"
        description={`이 정책의 적용 비율을 ${pendingBump?.next ?? 0}%로 올립니다. 더 많은 트래픽에 정책이 실제로 집행됩니다.`}
        confirmLabel="상향"
        tone="danger"
        onConfirm={async () => {
          const policy = (policies.data?.policies ?? []).find((item) => item.id === pendingBump?.policyId);
          if (policy && pendingBump) {
            await bumpRollout.mutateAsync({ policy, next: pendingBump.next });
          }
        }}
      />
    </div>
  );
}
