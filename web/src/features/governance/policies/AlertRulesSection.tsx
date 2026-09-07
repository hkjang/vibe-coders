import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { apiClient } from "@/shared/api/client";
import type { AlertRule } from "@/shared/api/domains/governance";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber, formatRelative } from "@/shared/utils/format";

const routeId = "governance.policies";

const alertMetrics = [
  { value: "requests", label: "요청 수" },
  { value: "errors", label: "오류율(0-1)" },
  { value: "krw", label: "KRW 비용" },
  { value: "tokens", label: "토큰" },
  { value: "latency_p95_ms", label: "전체 지연 P95" },
  { value: "first_chunk_p95_ms", label: "첫 청크 P95" },
  { value: "llm_eval_failures", label: "LLM 평가 실패 수" },
  { value: "llm_eval_failure_rate", label: "LLM 평가 실패율" },
  { value: "tool_errors", label: "도구 오류 수" },
  { value: "tool_error_rate", label: "도구 오류율" },
  { value: "tool_loop", label: "에이전트 루프" },
  { value: "mcp_new_tools", label: "MCP 신규 도구 수" },
  { value: "anomaly_zmax", label: "이상 징후 z-score" },
  { value: "budget_burn_ratio", label: "예산 소진 예측 비율" },
  { value: "failover_rate", label: "폴백 발생률" },
  { value: "failovers", label: "폴백 발생 건수" },
] as const;

const alertScopes = [
  { value: "global", label: "전체" },
  { value: "api_key", label: "API 키" },
  { value: "team", label: "팀" },
  { value: "ip", label: "IP" },
  { value: "model", label: "모델" },
] as const;

const metricLabels = new Map<string, string>(alertMetrics.map((metric) => [metric.value, metric.label]));
const scopeLabels = new Map<string, string>(alertScopes.map((scope) => [scope.value, scope.label]));

const alertFormSchema = z.object({
  name: z.string().trim().min(1, "이름을 입력하세요."),
  metric: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  scopeValue: z.string().trim().max(200),
  windowSeconds: z.coerce.number().int().min(30).max(86_400),
  threshold: z.coerce.number().positive("임계값은 0보다 커야 합니다."),
  webhookUrl: z.string().trim().max(500),
  note: z.string().trim().max(500),
});
type AlertFormValues = z.output<typeof alertFormSchema>;
type AlertFormInput = z.input<typeof alertFormSchema>;

export function AlertRulesSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [formOpen, setFormOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AlertRule | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const alerts = useQuery({
    queryKey: ["governance", "alerts"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.governance.alerts.list, { signal, routeId }),
  });

  const form = useZodForm<AlertFormInput, AlertFormValues>(alertFormSchema, {
    name: "",
    metric: "errors",
    scope: "global",
    scopeValue: "",
    windowSeconds: 300,
    threshold: 1,
    webhookUrl: "",
    note: "",
  });

  const createRule = useMutationFeedback({
    mutate: (values: AlertFormValues) =>
      apiClient.request(endpoints.domains.governance.alerts.create, {
        body: {
          name: values.name,
          metric: values.metric,
          window_seconds: values.windowSeconds,
          threshold: values.threshold,
          scope: values.scope,
          scope_value: values.scope === "global" ? "*" : values.scopeValue,
          webhook_url: values.webhookUrl,
          note: values.note,
        },
        routeId,
      }),
    invalidates: [["governance", "alerts"]],
    successMessage: "알림 규칙을 추가했습니다.",
    errorMessage: "알림 규칙을 추가하지 못했습니다.",
  });

  const removeRule = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(
        {
          ...endpoints.domains.governance.alerts.remove,
          path: pathWithParams(endpoints.domains.governance.alerts.remove.path, { id }),
        },
        { routeId },
      ),
    invalidates: [["governance", "alerts"]],
    successMessage: "알림 규칙을 삭제했습니다.",
    errorMessage: "알림 규칙을 삭제하지 못했습니다.",
  });

  const ruleRows = alerts.data?.rules ?? [];
  const eventRows = alerts.data?.events ?? [];

  const ruleColumns: ReadonlyArray<GovernanceColumn<AlertRule>> = [
    {
      id: "name",
      header: "이름",
      cell: (row) => (
        <span>
          <strong>{row.name || row.id}</strong>
          {row.note ? (
            <>
              <br />
              <span>{row.note}</span>
            </>
          ) : null}
        </span>
      ),
    },
    { id: "metric", header: "지표", cell: (row) => metricLabels.get(row.metric ?? "") ?? row.metric ?? "—" },
    {
      id: "scope",
      header: "대상",
      cell: (row) => `${scopeLabels.get(row.scope ?? "") ?? row.scope ?? "—"} ${row.scope_value ?? ""}`,
    },
    {
      id: "window",
      header: "윈도우",
      cell: (row) => <span className="cell-number">{formatNumber(row.window_seconds)}초</span>,
    },
    {
      id: "threshold",
      header: "임계값 / 최근값",
      cell: (row) => (
        <span className="cell-number">
          {formatNumber(row.threshold, 2)} / {row.last_value ? formatNumber(row.last_value, 2) : "—"}
        </span>
      ),
    },
    {
      id: "webhook",
      header: "Webhook",
      cell: (row) =>
        row.webhook_url ? <Badge tone="info">설정됨</Badge> : <Badge tone="muted">없음 (기록만)</Badge>,
    },
    {
      id: "enabled",
      header: "상태",
      cell: (row) => (row.enabled ? <Badge tone="success">사용</Badge> : <Badge tone="danger">중지</Badge>),
    },
    {
      id: "last_fired",
      header: "최근 발화",
      cell: (row) => (row.last_fired_at ? formatRelative(row.last_fired_at) : "없음"),
    },
    {
      id: "actions",
      header: "동작",
      cell: (row) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
          aria-label={`${row.name || row.id} 알림 규칙 삭제`}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setPendingDelete(row);
          }}
        >
          <Trash2 aria-hidden="true" /> 삭제
        </Button>
      ),
    },
  ];

  const eventColumns: ReadonlyArray<GovernanceColumn<(typeof eventRows)[number]>> = [
    { id: "created_at", header: "시각", cell: (row) => formatDateTime(row.created_at) },
    { id: "rule", header: "규칙", cell: (row) => row.rule_name || row.rule_id || "—" },
    { id: "metric", header: "지표", cell: (row) => metricLabels.get(row.metric ?? "") ?? row.metric ?? "—" },
    {
      id: "value",
      header: "값",
      cell: (row) => <span className="cell-number">{formatNumber(row.value, 2)}</span>,
    },
    {
      id: "threshold",
      header: "임계값",
      cell: (row) => <span className="cell-number">{formatNumber(row.threshold, 2)}</span>,
    },
    {
      id: "delivered",
      header: "전송",
      cell: (row) =>
        row.delivered ? (
          <Badge tone="success">성공</Badge>
        ) : row.delivery_error ? (
          <Badge tone="danger" title={row.delivery_error}>
            실패
          </Badge>
        ) : (
          <Badge tone="muted">webhook 없음</Badge>
        ),
    },
  ];

  return (
    <>
      <SectionCard
        title="알림 규칙"
        description="오류율·비용·지연·폴백률이 임계값을 넘으면 Webhook으로 통보합니다."
        actions={
          <Button
            ref={createTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            onClick={() => setFormOpen(true)}
          >
            <Plus aria-hidden="true" /> 규칙 추가
          </Button>
        }
      >
        {alerts.isError ? (
          <PanelFailure
            error={alerts.error}
            hasData={Boolean(alerts.data)}
            label="알림 규칙"
            onRetry={() => void alerts.refetch()}
          />
        ) : null}
        <InlineNotice tone="info" title="규칙 사용/중지 전환은 기존 화면에서 처리하세요.">
          규칙의 사용·중지와 임계값 수정 API는 공개 규격(OpenAPI)에 포함되어 있지 않아 이 화면에서는 추가와
          삭제만 제공합니다.
        </InlineNotice>
        {!alerts.isPending && !alerts.isError && ruleRows.length === 0 ? (
          <EmptyState
            title="설정된 알림 규칙이 없습니다."
            description="규칙을 추가하면 오류율·비용·지연이 임계값을 넘을 때 알림을 받습니다."
          />
        ) : (
          <GovernanceTable
            caption="알림 규칙 목록"
            columns={ruleColumns}
            rows={ruleRows}
            loading={alerts.isPending}
            error={alerts.isError && !alerts.data ? "알림 규칙을 불러오지 못했습니다." : undefined}
            onRetry={() => void alerts.refetch()}
          />
        )}
      </SectionCard>

      <SectionCard title="최근 발화 이력" description="최근 알림 발화와 전송 결과입니다.">
        <GovernanceTable
          caption="최근 알림 발화 이력"
          columns={eventColumns}
          rows={eventRows}
          loading={alerts.isPending}
          emptyMessage="발화 이력이 없습니다."
        />
      </SectionCard>

      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createTriggerRef}
        form={form}
        title="알림 규칙 추가"
        description="지표가 임계값을 넘으면 알림을 발화합니다. Webhook URL은 선택입니다."
        submitLabel="규칙 추가"
        onSubmit={async (values) => {
          await createRule.mutateAsync(values);
        }}
      >
        <FormField label="이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        <FormField label="지표" error={form.formState.errors.metric?.message}>
          {(control) => (
            <Select {...control} {...form.register("metric")}>
              {alertMetrics.map((metric) => (
                <option key={metric.value} value={metric.value}>
                  {metric.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="대상 범위" error={form.formState.errors.scope?.message}>
          {(control) => (
            <Select {...control} {...form.register("scope")}>
              {alertScopes.map((scope) => (
                <option key={scope.value} value={scope.value}>
                  {scope.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="대상 값"
          description="전체 범위이면 자동으로 채워집니다."
          error={form.formState.errors.scopeValue?.message}
        >
          {(control) => <Input {...control} {...form.register("scopeValue")} />}
        </FormField>
        <FormField label="평가 윈도우(초)" error={form.formState.errors.windowSeconds?.message}>
          {(control) => (
            <Input {...control} type="number" min={30} max={86400} {...form.register("windowSeconds")} />
          )}
        </FormField>
        <FormField label="임계값" required error={form.formState.errors.threshold?.message}>
          {(control) => <Input {...control} type="number" step="0.01" {...form.register("threshold")} />}
        </FormField>
        <FormField label="Webhook URL" error={form.formState.errors.webhookUrl?.message}>
          {(control) => <Input {...control} {...form.register("webhookUrl")} placeholder="https://" />}
        </FormField>
        <FormField label="메모" error={form.formState.errors.note?.message}>
          {(control) => <Input {...control} {...form.register("note")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="알림 규칙을 삭제할까요?"
        description={`"${pendingDelete?.name ?? pendingDelete?.id ?? ""}" 규칙을 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        onConfirm={async () => {
          if (pendingDelete) await removeRule.mutateAsync(pendingDelete.id);
        }}
      />
    </>
  );
}
