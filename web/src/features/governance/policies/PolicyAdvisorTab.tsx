import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { apiClient } from "@/shared/api/client";
import type { Policy, PolicySuggestion } from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatNumber } from "@/shared/utils/format";
import { PolicySimulationSection } from "./PolicySimulationSection";
import { simulationWindows, type SimulationWindow } from "./policy-simulation-state";

const routeId = "governance.policies";
const canaryDayOptions = [7, 14, 30] as const;

export function PolicyAdvisorTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const [pendingApply, setPendingApply] = useState<PolicySuggestion | undefined>();
  const [pendingBump, setPendingBump] = useState<{ policyId: string; next: number } | undefined>();
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const requestedWindow = params.get("advisor_window") ?? "";
  const window = Object.hasOwn(simulationWindows, requestedWindow)
    ? (requestedWindow as SimulationWindow)
    : "7d";
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
      <PolicySimulationSection
        canWrite={canWrite}
        window={window}
        rows={suggestionRows}
        pending={suggestions.isPending}
        failed={suggestions.isError}
        error={suggestions.error}
        hasData={Boolean(suggestions.data)}
        refresh={() => void suggestions.refetch()}
        changeWindow={(next) => updateSearch({ advisor_window: next })}
        applyDraft={(row, trigger) => {
          rowTriggerRef.current = trigger;
          setPendingApply(row);
        }}
      />

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
