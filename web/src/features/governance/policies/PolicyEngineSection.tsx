import { useQuery } from "@tanstack/react-query";
import { Play, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { compactJson } from "@/features/governance/policies/governance-utils";
import { apiClient } from "@/shared/api/client";
import type { Policy, PolicyRegressionRun } from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber } from "@/shared/utils/format";

const routeId = "governance.policies";

const conditionKeys = [
  "contains_secret",
  "risk_score",
  "complexity_score",
  "cost_krw",
  "team",
  "role",
  "model",
  "provider",
  "mcp_tool",
] as const;

const actionKeys = [
  "block",
  "require_approval",
  "secret_mask",
  "secret_block",
  "deny_models",
  "allow_models",
  "deny_providers",
  "allow_providers",
] as const;

const actionLabels: Record<(typeof actionKeys)[number], string> = {
  block: "block (차단)",
  require_approval: "require_approval (승인 요구)",
  secret_mask: "secret_action=mask",
  secret_block: "secret_action=block",
  deny_models: "deny_models",
  allow_models: "allow_models",
  deny_providers: "deny_providers",
  allow_providers: "allow_providers",
};

const policyFormSchema = z.object({
  name: z.string().trim().min(1, "정책 이름을 입력하세요."),
  priority: z.coerce.number().int().min(1).max(999),
  rollout: z.coerce.number().int().min(1).max(100),
  conditionKey: z.string().trim().min(1),
  conditionValue: z.string().trim().max(200),
  action: z.string().trim().min(1),
  actionValue: z.string().trim().max(400),
});
type PolicyFormValues = z.output<typeof policyFormSchema>;
type PolicyFormInput = z.input<typeof policyFormSchema>;

const regressionFormSchema = z.object({
  name: z.string().trim().min(1, "시나리오 이름을 입력하세요."),
  model: z.string().trim().max(120),
  provider: z.string().trim().max(120),
  risk: z.coerce.number().int().min(0).max(100),
  containsSecret: z.boolean(),
  expect: z.string().trim().min(1),
});
type RegressionFormValues = z.output<typeof regressionFormSchema>;
type RegressionFormInput = z.input<typeof regressionFormSchema>;

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function conditionsFrom(values: PolicyFormValues): Record<string, unknown> {
  const key = values.conditionKey;
  if (key === "contains_secret") return { contains_secret: true };
  if (key === "risk_score" || key === "complexity_score" || key === "cost_krw") {
    return { [key]: values.conditionValue || ">80" };
  }
  return { [key]: values.conditionValue || "*" };
}

function actionsFrom(values: PolicyFormValues): Record<string, unknown> {
  const list = splitCsv(values.actionValue || "*");
  switch (values.action) {
    case "block":
      return { block: true };
    case "require_approval":
      return { require_approval: true };
    case "secret_mask":
      return { secret_action: "mask" };
    case "secret_block":
      return { secret_action: "block" };
    default:
      return { [values.action]: list };
  }
}

export function PolicyEngineSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [policyFormOpen, setPolicyFormOpen] = useState(false);
  const [regressionFormOpen, setRegressionFormOpen] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<Policy | undefined>();
  const [pendingCaseDelete, setPendingCaseDelete] = useState<{ id: string; name: string } | undefined>();
  const [runResult, setRunResult] = useState<PolicyRegressionRun | undefined>();
  const policyTriggerRef = useRef<HTMLButtonElement>(null);
  const regressionTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const policies = useQuery({
    queryKey: ["governance", "policies"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.policies.list, { signal, routeId }),
  });
  const regressionCases = useQuery({
    queryKey: ["governance", "regression-cases"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.regression.list, { signal, routeId }),
  });

  const policyForm = useZodForm<PolicyFormInput, PolicyFormValues>(policyFormSchema, {
    name: "",
    priority: 100,
    rollout: 100,
    conditionKey: "contains_secret",
    conditionValue: "",
    action: "block",
    actionValue: "",
  });
  const regressionForm = useZodForm<RegressionFormInput, RegressionFormValues>(regressionFormSchema, {
    name: "",
    model: "",
    provider: "",
    risk: 0,
    containsSecret: false,
    expect: "allow",
  });

  const savePolicy = useMutationFeedback({
    mutate: (values: PolicyFormValues) =>
      apiClient.request(endpoints.domains.governance.policies.save, {
        body: {
          name: values.name,
          description: "정책 화면의 빠른 정책 폼에서 생성",
          enabled: true,
          priority: values.priority,
          rollout_percent: values.rollout,
          rules: [
            {
              name: `${values.conditionKey} -> ${values.action}`,
              enabled: true,
              priority: 100,
              conditions: conditionsFrom(values),
              actions: actionsFrom(values),
            },
          ],
        },
        routeId,
      }),
    invalidates: [["governance", "policies"]],
    successMessage: "AI 정책을 저장했습니다.",
    errorMessage: "AI 정책을 저장하지 못했습니다.",
  });

  const togglePolicy = useMutationFeedback({
    mutate: (variables: { policy: Policy; enabled: boolean }) =>
      apiClient.request(endpoints.domains.governance.policies.save, {
        body: {
          id: variables.policy.id,
          name: variables.policy.name ?? variables.policy.id,
          description: variables.policy.description ?? "",
          enabled: variables.enabled,
          priority: Number(variables.policy.priority ?? 100),
          rollout_percent: Number(variables.policy.rollout_percent ?? 100),
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
    invalidates: [["governance", "policies"]],
    successMessage: (_result, variables) =>
      variables.enabled ? "정책을 사용으로 전환했습니다." : "정책을 중지했습니다.",
    errorMessage: "정책 상태를 변경하지 못했습니다.",
  });

  const saveCase = useMutationFeedback({
    mutate: (values: RegressionFormValues) =>
      apiClient.request(endpoints.domains.governance.regression.save, {
        body: {
          name: values.name,
          model: values.model,
          provider: values.provider,
          risk_score: values.risk,
          contains_secret: values.containsSecret,
          expect: values.expect,
        },
        routeId,
      }),
    invalidates: [["governance", "regression-cases"]],
    successMessage: "회귀 시나리오를 저장했습니다.",
    errorMessage: "회귀 시나리오를 저장하지 못했습니다.",
  });

  const removeCase = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(endpoints.domains.governance.regression.remove, { query: { id }, routeId }),
    invalidates: [["governance", "regression-cases"]],
    successMessage: "회귀 시나리오를 삭제했습니다.",
    errorMessage: "회귀 시나리오를 삭제하지 못했습니다.",
  });

  const runRegression = useMutationFeedback({
    mutate: () => apiClient.request(endpoints.domains.governance.regression.run, { routeId }),
    successMessage: (result) =>
      `회귀 실행 완료 — 통과 ${formatNumber(Number(result.passed ?? 0))} / 실패 ${formatNumber(Number(result.failed ?? 0))}`,
    errorMessage: "회귀 테스트를 실행하지 못했습니다.",
    onSuccess: (result) => setRunResult(result),
  });

  const policyRows = policies.data?.policies ?? [];
  const caseRows = regressionCases.data?.cases ?? [];

  const policyColumns: ReadonlyArray<GovernanceColumn<Policy>> = [
    {
      id: "priority",
      header: "우선순위",
      cell: (row) => <span className="cell-number">{formatNumber(row.priority ?? 100)}</span>,
    },
    {
      id: "name",
      header: "정책",
      cell: (row) => (
        <span>
          <strong>{row.name || row.id}</strong>
          <br />
          <span className="mono">{row.id}</span>
        </span>
      ),
    },
    {
      id: "rules",
      header: "규칙",
      cell: (row) =>
        (row.rules ?? []).length === 0 ? (
          "규칙 없음"
        ) : (
          <ul>
            {(row.rules ?? []).slice(0, 3).map((rule, index) => (
              <li key={rule.id ?? index}>
                <strong>{rule.name || rule.id || "rule"}</strong>
                <br />
                <span className="mono">
                  if {compactJson(rule.conditions)} → {compactJson(rule.actions)}
                </span>
              </li>
            ))}
          </ul>
        ),
    },
    {
      id: "enabled",
      header: "상태",
      cell: (row) => (row.enabled ? <Badge tone="success">사용</Badge> : <Badge tone="danger">중지</Badge>),
    },
    {
      id: "rollout",
      header: "적용 비율",
      cell: (row) =>
        Number(row.rollout_percent ?? 100) < 100 ? (
          <Badge tone="warning">canary {formatNumber(row.rollout_percent)}%</Badge>
        ) : (
          "100%"
        ),
    },
    {
      id: "actions",
      header: "동작",
      cell: (row) => (
        <Button
          size="small"
          disabled={!canWrite}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
          aria-label={`${row.name || row.id} ${row.enabled ? "중지" : "사용"}`}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setPendingToggle(row);
          }}
        >
          {row.enabled ? "중지" : "사용"}
        </Button>
      ),
    },
  ];

  const caseColumns: ReadonlyArray<GovernanceColumn<(typeof caseRows)[number]>> = [
    { id: "name", header: "시나리오", cell: (row) => row.name || row.id },
    { id: "model", header: "모델", cell: (row) => row.model || "—" },
    { id: "provider", header: "공급자", cell: (row) => row.provider || "—" },
    {
      id: "risk",
      header: "risk",
      cell: (row) => <span className="cell-number">{formatNumber(row.risk_score)}</span>,
    },
    { id: "secret", header: "secret", cell: (row) => (row.contains_secret ? "포함" : "—") },
    { id: "expect", header: "기대 결과", cell: (row) => <Badge>{row.expect ?? "—"}</Badge> },
    {
      id: "actions",
      header: "동작",
      cell: (row) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
          aria-label={`${row.name || row.id} 시나리오 삭제`}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setPendingCaseDelete({ id: row.id, name: row.name ?? row.id });
          }}
        >
          <Trash2 aria-hidden="true" /> 삭제
        </Button>
      ),
    },
  ];

  return (
    <>
      <SectionCard
        title="AI 정책 엔진"
        description="조건이 맞는 요청을 차단하거나 승인 대상으로 만듭니다. 우선순위가 낮을수록 먼저 평가합니다."
        actions={
          <Button
            ref={policyTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            onClick={() => setPolicyFormOpen(true)}
          >
            <Plus aria-hidden="true" /> 정책 추가
          </Button>
        }
      >
        {policies.isError ? (
          <PanelFailure
            error={policies.error}
            hasData={Boolean(policies.data)}
            label="AI 정책"
            onRetry={() => void policies.refetch()}
          />
        ) : null}
        {!policies.isPending && !policies.isError && policyRows.length === 0 ? (
          <EmptyState
            title="등록된 AI 정책이 없습니다."
            description="정책을 추가하면 위험한 요청을 차단하거나 승인 절차로 보낼 수 있습니다."
          />
        ) : (
          <GovernanceTable
            caption="AI 정책 목록"
            columns={policyColumns}
            rows={policyRows}
            loading={policies.isPending}
            error={policies.isError && !policies.data ? "정책을 불러오지 못했습니다." : undefined}
            onRetry={() => void policies.refetch()}
          />
        )}
      </SectionCard>

      <SectionCard
        title="정책 회귀 테스트"
        description="고정 입력 시나리오의 기대 결과를 저장해 두고 현재 활성 정책에 재생합니다. 프롬프트·SQL 원문은 저장하지 않습니다."
        actions={
          <div className="governance-actions">
            <Button
              ref={regressionTriggerRef}
              disabled={!canWrite}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
              onClick={() => setRegressionFormOpen(true)}
            >
              <Plus aria-hidden="true" /> 시나리오 추가
            </Button>
            <Button
              variant="primary"
              disabled={!canWrite || runRegression.isPending}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
              onClick={() => runRegression.mutate(undefined)}
            >
              <Play aria-hidden="true" /> 전체 회귀 실행
            </Button>
          </div>
        }
      >
        {regressionCases.isError ? (
          <PanelFailure
            error={regressionCases.error}
            hasData={Boolean(regressionCases.data)}
            label="회귀 시나리오"
            onRetry={() => void regressionCases.refetch()}
          />
        ) : null}
        {runResult ? (
          <InlineNotice
            tone={Number(runResult.failed ?? 0) > 0 ? "warning" : "success"}
            title={`회귀 결과 — 통과 ${formatNumber(Number(runResult.passed ?? 0))} / 실패 ${formatNumber(Number(runResult.failed ?? 0))}`}
          >
            {(runResult.results ?? [])
              .filter((result) => result.pass === false)
              .slice(0, 5)
              .map((result) => `${result.name ?? result.id}: 기대 ${result.expect} · 실제 ${result.actual}`)
              .join(" / ") || "모든 시나리오가 기대한 판단과 일치합니다."}
          </InlineNotice>
        ) : null}
        <GovernanceTable
          caption="정책 회귀 시나리오"
          columns={caseColumns}
          rows={caseRows}
          loading={regressionCases.isPending}
          emptyMessage="저장된 회귀 시나리오가 없습니다. 시나리오를 추가하면 정책 변경이 판단을 뒤집는지 확인할 수 있습니다."
        />
      </SectionCard>

      <FormDialog
        open={policyFormOpen}
        onOpenChange={setPolicyFormOpen}
        returnFocusRef={policyTriggerRef}
        form={policyForm}
        title="AI 정책 추가"
        description="자주 쓰는 단일 규칙 정책을 빠르게 만듭니다. 복잡한 정책은 API로 등록하세요."
        submitLabel="정책 저장"
        onSubmit={async (values) => {
          await savePolicy.mutateAsync(values);
        }}
      >
        <FormField label="정책 이름" required error={policyForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...policyForm.register("name")} />}
        </FormField>
        <FormField
          label="우선순위"
          description="낮을수록 먼저 평가합니다."
          error={policyForm.formState.errors.priority?.message}
        >
          {(control) => (
            <Input {...control} type="number" min={1} max={999} {...policyForm.register("priority")} />
          )}
        </FormField>
        <FormField
          label="적용 비율(%)"
          description="canary 단계 적용 비율입니다. 100이면 전체 적용."
          error={policyForm.formState.errors.rollout?.message}
        >
          {(control) => (
            <Input {...control} type="number" min={1} max={100} {...policyForm.register("rollout")} />
          )}
        </FormField>
        <FormField label="조건" error={policyForm.formState.errors.conditionKey?.message}>
          {(control) => (
            <Select {...control} {...policyForm.register("conditionKey")}>
              {conditionKeys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="조건값"
          description="예: >80, security, gpt-*"
          error={policyForm.formState.errors.conditionValue?.message}
        >
          {(control) => <Input {...control} {...policyForm.register("conditionValue")} />}
        </FormField>
        <FormField label="동작" error={policyForm.formState.errors.action?.message}>
          {(control) => (
            <Select {...control} {...policyForm.register("action")}>
              {actionKeys.map((key) => (
                <option key={key} value={key}>
                  {actionLabels[key]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="동작 대상"
          description="모델·공급자 목록을 쉼표로 구분합니다. (allow/deny 동작에만 사용)"
          error={policyForm.formState.errors.actionValue?.message}
        >
          {(control) => <Input {...control} {...policyForm.register("actionValue")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        open={regressionFormOpen}
        onOpenChange={setRegressionFormOpen}
        returnFocusRef={regressionTriggerRef}
        form={regressionForm}
        title="회귀 시나리오 추가"
        description="고정 입력과 기대 판단을 저장합니다. 프롬프트 원문은 저장하지 않습니다."
        submitLabel="시나리오 저장"
        onSubmit={async (values) => {
          await saveCase.mutateAsync(values);
        }}
      >
        <FormField label="시나리오 이름" required error={regressionForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...regressionForm.register("name")} />}
        </FormField>
        <FormField label="모델" error={regressionForm.formState.errors.model?.message}>
          {(control) => <Input {...control} {...regressionForm.register("model")} placeholder="gpt-4" />}
        </FormField>
        <FormField label="공급자" error={regressionForm.formState.errors.provider?.message}>
          {(control) => <Input {...control} {...regressionForm.register("provider")} />}
        </FormField>
        <FormField label="risk 점수" error={regressionForm.formState.errors.risk?.message}>
          {(control) => (
            <Input {...control} type="number" min={0} max={100} {...regressionForm.register("risk")} />
          )}
        </FormField>
        <Checkbox label="민감정보 포함 상황" {...regressionForm.register("containsSecret")} />
        <FormField label="기대 결과" error={regressionForm.formState.errors.expect?.message}>
          {(control) => (
            <Select {...control} {...regressionForm.register("expect")}>
              <option value="allow">allow</option>
              <option value="block">block</option>
              <option value="require_approval">require_approval</option>
            </Select>
          )}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pendingToggle !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingToggle(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title={pendingToggle?.enabled ? "정책을 중지할까요?" : "정책을 사용할까요?"}
        description={
          pendingToggle?.enabled
            ? "이 정책의 규칙이 더 이상 적용되지 않습니다."
            : "이 정책의 규칙이 즉시 적용됩니다."
        }
        confirmLabel={pendingToggle?.enabled ? "중지" : "사용"}
        tone={pendingToggle?.enabled ? "danger" : "primary"}
        onConfirm={async () => {
          if (pendingToggle) {
            await togglePolicy.mutateAsync({
              policy: pendingToggle,
              enabled: pendingToggle.enabled !== true,
            });
          }
        }}
      />

      <ConfirmDialog
        open={pendingCaseDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingCaseDelete(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="회귀 시나리오를 삭제할까요?"
        description={`"${pendingCaseDelete?.name ?? ""}" 시나리오를 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        onConfirm={async () => {
          if (pendingCaseDelete) await removeCase.mutateAsync(pendingCaseDelete.id);
        }}
      />
    </>
  );
}
