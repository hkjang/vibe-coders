import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import type { Policy } from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatNumber } from "@/shared/utils/format";
import { PolicyDraftSection } from "./PolicyDraftSection";
import { simulationWindows, type SimulationWindow } from "./policy-simulation-state";
import { usePolicyDraftAccess } from "./policy-draft-access";
import { policyAdviceKey, policyCatalogCurrent } from "./policy-catalog-key";
import { editorText } from "./policy-editor-security";

const routeId = "governance.policies";
const canaryDayOptions = [7, 14, 30] as const;

export function PolicyAdvisorTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const access = usePolicyDraftAccess(canWrite);
  return <AdvisorSession key={access.sessionKey} canWrite={canWrite} />;
}

function AdvisorSession({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const access = usePolicyDraftAccess(canWrite);
  const client = useQueryClient();
  const [params, updateSearch] = useSearchState();
  const [pendingBump, setPendingBump] = useState<{ policy: Policy; next: number; approval: object }>();
  const selected = useRef<typeof pendingBump>(undefined);
  const attempted = useRef(false);
  const [wasAttempted, setWasAttempted] = useState(false);
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const requestedWindow = params.get("advisor_window") ?? "";
  const window = Object.hasOwn(simulationWindows, requestedWindow)
    ? (requestedWindow as SimulationWindow)
    : "7d";
  const requestedDays = Number(params.get("canary_days"));
  const canaryDays = (canaryDayOptions as readonly number[]).includes(requestedDays) ? requestedDays : 7;

  const suggestions = useQuery({
    queryKey: policyAdviceKey(access.sessionKey, window),
    enabled: access.suggestionsAllowed,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      access.assertSuggestionsRead();
      return apiClient.request(endpoints.domains.governance.advisor.suggestions, {
        query: { window },
        signal,
        routeId,
      });
    },
  });
  const canary = useQuery({
    queryKey: ["governance", "canary", access.sessionKey, canaryDays],
    enabled: access.suggestionsAllowed,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      access.assertSuggestionsRead();
      return apiClient.request(endpoints.domains.governance.policies.canaryStatus, {
        query: { days: canaryDays },
        signal,
        routeId,
      });
    },
  });
  const policies = useQuery({
    queryKey: access.catalogKey,
    enabled: access.read,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      access.assertRead();
      return apiClient.request(endpoints.domains.governance.policies.list, { signal, routeId });
    },
  });

  const current = (target: NonNullable<typeof pendingBump>) => {
    access.assertSuggestionsRead();
    access.write.assertCurrent();
    access.assertApproval(target.approval);
    if (selected.current !== target || !policyCatalogCurrent(client, access.catalogKey, target.policy))
      throw new AppError("정책 원본을 다시 조회하고 검토하세요.", { kind: "permission" });
  };
  const bumpRollout = useMutationFeedback({
    ownsResult: () => {
      try {
        access.assertSuggestionsRead();
        return true;
      } catch {
        return false;
      }
    },
    mutate: (variables: NonNullable<typeof pendingBump>) => {
      current(variables);
      if (attempted.current) throw new AppError("정책 적용 상태를 다시 확인하세요.", { kind: "aborted" });
      attempted.current = true;
      setWasAttempted(true);
      return apiClient.request(endpoints.domains.governance.policies.save, {
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
        retryUnauthorized: false,
      });
    },
    invalidates: [access.catalogKey, ["governance", "canary", access.sessionKey]],
    successMessage: "단계 적용 비율을 상향했습니다.",
    errorMessage: "적용 비율을 변경하지 못했습니다.",
  });

  const suggestionRows =
    access.suggestionsAllowed && suggestions.isSuccess && !suggestions.isFetching
      ? (suggestions.data?.suggestions ?? [])
      : [];
  const canaryRows =
    access.suggestionsAllowed && canary.isSuccess && !canary.isFetching ? (canary.data?.policies ?? []) : [];
  const policyFor = (id: string) => policies.data?.policies?.find((row) => row.id === id);
  const ready = (id: string) => {
    const row = policyFor(id);
    return access.write.allowed && row !== undefined && policyCatalogCurrent(client, access.catalogKey, row);
  };
  const confirmAllowed =
    pendingBump !== undefined &&
    !wasAttempted &&
    access.write.allowed &&
    access.suggestionsAllowed &&
    pendingBump.approval === access.approval &&
    policyCatalogCurrent(client, access.catalogKey, pendingBump.policy);
  const text = (value: string | undefined) => editorText(value, access.prefixes);

  const canaryColumns: ReadonlyArray<GovernanceColumn<(typeof canaryRows)[number]>> = [
    { id: "name", header: "정책", cell: (row) => text(row.name || row.policy_id) },
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
          disabled={!ready(row.policy_id)}
          title={access.write.reason}
          aria-label={`${text(row.name ?? row.policy_id)} 적용 비율 상향`}
          onClick={(event) => {
            const policy = policyFor(row.policy_id);
            const next = Number(row.suggested_next ?? 100);
            if (
              !policy ||
              !ready(row.policy_id) ||
              !Number.isInteger(next) ||
              next <= Number(policy.rollout_percent ?? 100) ||
              next > 100
            )
              return;
            const target = { policy: structuredClone(policy), next, approval: access.approval };
            rowTriggerRef.current = event.currentTarget;
            attempted.current = false;
            setWasAttempted(false);
            selected.current = target;
            setPendingBump(target);
          }}
        >
          상향
        </Button>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <PolicyDraftSection
        canWrite={canWrite}
        window={window}
        rows={suggestionRows}
        pending={access.suggestionsAllowed && suggestions.isFetching}
        failed={suggestions.isError}
        error={suggestions.error}
        hasData={false}
        refresh={() => void suggestions.refetch()}
        changeWindow={(next) => updateSearch({ advisor_window: next })}
      />

      <SectionCard
        title="정책 단계 적용 현황"
        description="적용 비율이 100% 미만인 정책의 실집행과 섀도우(미적용 would-block) 활동을 비교합니다."
        actions={
          <label className="toolbar">
            <span>집계 기간</span>
            <Select
              aria-label="정책 단계 적용 집계 기간"
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
            hasData={false}
            label="정책 단계 적용 현황"
            onRetry={() => void canary.refetch()}
          />
        ) : null}
        <GovernanceTable
          caption="정책 단계 적용 현황"
          columns={canaryColumns}
          rows={canaryRows}
          loading={access.suggestionsAllowed && canary.isFetching}
          emptyMessage="단계 적용 중인 정책이 없습니다."
        />
      </SectionCard>
      {policies.isError ? (
        <PanelFailure
          error={policies.error}
          hasData={false}
          label="정책 원본"
          onRetry={() => void policies.refetch()}
        />
      ) : null}
      {!access.suggestionsAllowed ? (
        <InlineNotice title="정책 추천 조회 권한을 확인하세요.">
          security:read와 admin:read 권한이 필요합니다.
        </InlineNotice>
      ) : null}

      <ConfirmDialog
        open={pendingBump !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            selected.current = undefined;
            setPendingBump(undefined);
          }
        }}
        returnFocusRef={rowTriggerRef}
        title="정책 적용 비율을 상향할까요?"
        description={`이 정책의 적용 비율을 ${pendingBump?.next ?? 0}%로 올립니다. 더 많은 트래픽에 정책이 실제로 집행됩니다.`}
        confirmLabel="상향"
        tone="danger"
        confirmDisabled={!confirmAllowed}
        onConfirm={async () => {
          if (pendingBump) await bumpRollout.mutateAsync(pendingBump);
        }}
      >
        {!confirmAllowed ? (
          <p>
            원본·권한이 바뀌었거나 이미 전송했습니다. 적용 상태를 다시 조회하고 검토하세요. 자동으로
            재전송하지 않습니다.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
