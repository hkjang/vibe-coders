import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
  alertMetrics,
  alertScopes,
  metricLabels,
  scopeLabels,
  alertFormSchema,
  alertEditSchema,
  type AlertFormValues,
  type AlertFormInput,
  type AlertEditValues,
  type AlertEditInput,
} from "./alert-rule-form";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import type { AlertRule } from "@/shared/api/domains/governance";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { usePolicyEditorAccess } from "./policy-editor-access";
import { useAlertRuleOperations } from "./use-alert-rule-operations";
import { formatNumber, formatRelative } from "@/shared/utils/format";
import { alertEventColumns } from "./alert-event-columns";

export function AlertRulesSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const access = usePolicyEditorAccess(canWrite);
  return <AlertRulesContent key={access.sessionKey} canWrite={canWrite} />;
}

function AlertRulesContent({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const {
    access,
    guard,
    alerts,
    actionable,
    beginReview,
    clearReview,
    createRule,
    updateRule,
    toggleRule,
    removeRule,
    ruleRows,
    eventRows,
  } = useAlertRuleOperations(canWrite);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRule | undefined>();
  const [pendingDelete, setPendingDelete] = useState<AlertRule | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusKey = useRef<string | undefined>(undefined);
  const rowTriggerRef = {
    get current() {
      const button = focusKey.current ? rowButtons.current.get(focusKey.current) : undefined;
      return button?.isConnected && !button.disabled ? button : panelRef.current;
    },
  };

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

  const editForm = useZodForm<AlertEditInput, AlertEditValues>(alertEditSchema, {
    threshold: 1,
    webhookUrl: "",
    note: "",
  });

  const openEdit = (rule: AlertRule): void => {
    const snapshot = beginReview("edit", rule);
    if (!snapshot) return;
    focusKey.current = `edit:${rule.id}`;
    setEditing(snapshot);
    editForm.reset({
      threshold: Number(rule.threshold ?? 0),
      webhookUrl: rule.webhook_url ?? "",
      note: rule.note ?? "",
    });
  };

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
      cell: (row) => (
        <Switch
          checked={row.enabled !== false}
          disabled={!actionable(row)}
          title={access.write.reason}
          label="사용"
          aria-label={`${row.name || row.id} 사용`}
          onCheckedChange={(checked) => toggleRule.mutate({ row: structuredClone(row), enabled: checked })}
        />
      ),
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
        <span className="governance-actions">
          <Button
            size="small"
            disabled={!actionable(row)}
            title={access.write.reason}
            aria-label={`${row.name || row.id} 알림 규칙 수정`}
            ref={(node) => {
              if (node) rowButtons.current.set(`edit:${row.id}`, node);
              else rowButtons.current.delete(`edit:${row.id}`);
            }}
            onClick={() => openEdit(row)}
          >
            <Pencil aria-hidden="true" /> 수정
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!actionable(row)}
            title={access.write.reason}
            aria-label={`${row.name || row.id} 알림 규칙 삭제`}
            ref={(node) => {
              if (node) rowButtons.current.set(`delete:${row.id}`, node);
              else rowButtons.current.delete(`delete:${row.id}`);
            }}
            onClick={() => {
              const snapshot = beginReview("delete", row);
              if (!snapshot) return;
              focusKey.current = `delete:${row.id}`;
              setPendingDelete(snapshot);
            }}
          >
            <Trash2 aria-hidden="true" /> 삭제
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <div ref={panelRef} tabIndex={-1}>
        <SectionCard
          title="알림 규칙"
          description="오류율·비용·지연·폴백률이 임계값을 넘으면 웹훅으로 통보합니다."
          actions={
            <Button
              ref={createTriggerRef}
              variant="primary"
              disabled={!access.write.allowed}
              title={access.write.reason}
              onClick={() => {
                if (guard.canOpen()) setFormOpen(true);
              }}
            >
              <Plus aria-hidden="true" /> 규칙 추가
            </Button>
          }
        >
          {alerts.isError ? (
            <PanelFailure
              error={alerts.error}
              hasData={false}
              label="알림 규칙"
              onRetry={() => void alerts.refetch()}
            />
          ) : null}
          {alerts.isSuccess && !alerts.isFetching && ruleRows.length === 0 ? (
            <EmptyState
              title="설정된 알림 규칙이 없습니다."
              description="규칙을 추가하면 오류율·비용·지연이 임계값을 넘을 때 알림을 받습니다."
            />
          ) : (
            <GovernanceTable
              caption="알림 규칙 목록"
              columns={ruleColumns}
              rows={ruleRows}
              loading={alerts.isPending || alerts.isFetching}
              error={alerts.isError ? "알림 규칙을 불러오지 못했습니다." : undefined}
              onRetry={() => void alerts.refetch()}
            />
          )}
        </SectionCard>
      </div>

      <SectionCard title="최근 발화 이력" description="최근 알림 발화와 전송 결과입니다.">
        <GovernanceTable
          caption="최근 알림 발화 이력"
          columns={alertEventColumns}
          rows={eventRows}
          loading={alerts.isPending || alerts.isFetching}
          error={alerts.isError ? "발화 이력을 불러오지 못했습니다." : undefined}
          onRetry={() => void alerts.refetch()}
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
        submitDisabled={!access.write.allowed}
        onSubmit={async (values) => {
          await createRule.mutateAsync({
            name: values.name,
            metric: values.metric,
            window_seconds: values.windowSeconds,
            threshold: values.threshold,
            scope: values.scope,
            scope_value: values.scope === "global" ? "*" : values.scopeValue,
            webhook_url: values.webhookUrl,
            note: values.note,
          });
        }}
      >
        {!access.write.allowed ? (
          <InlineNotice title="알림 규칙 저장이 잠겼습니다.">
            {access.write.reason} 입력한 초안은 유지합니다.
          </InlineNotice>
        ) : null}
        {createRule.isError ? (
          <p>목록에서 생성 여부를 확인하세요. 다시 저장하면 중복 생성될 수 있습니다.</p>
        ) : null}
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

      <FormDialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            clearReview("edit");
            setEditing(undefined);
          }
        }}
        returnFocusRef={rowTriggerRef}
        form={editForm}
        title="알림 규칙 수정"
        description="임계값과 Webhook, 메모를 바꿉니다. 지표와 대상 범위는 규칙을 새로 만들어야 바뀝니다."
        submitLabel="저장"
        submitDisabled={!editing || !actionable(editing)}
        onSubmit={async (values) => {
          if (editing)
            await updateRule.mutateAsync({
              row: editing,
              body: { threshold: values.threshold, webhook_url: values.webhookUrl, note: values.note },
            });
        }}
      >
        {editing && !actionable(editing) ? (
          <InlineNotice title="알림 규칙 수정이 잠겼습니다.">
            {access.write.reason ?? "규칙 원본을 다시 조회하고 검토하세요."} 입력한 초안은 유지합니다.
          </InlineNotice>
        ) : null}
        <FormField label="임계값" required error={editForm.formState.errors.threshold?.message}>
          {(control) => <Input {...control} type="number" step="0.01" {...editForm.register("threshold")} />}
        </FormField>
        <FormField label="Webhook URL" error={editForm.formState.errors.webhookUrl?.message}>
          {(control) => <Input {...control} {...editForm.register("webhookUrl")} placeholder="https://" />}
        </FormField>
        <FormField label="메모" error={editForm.formState.errors.note?.message}>
          {(control) => <Input {...control} {...editForm.register("note")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            clearReview("delete");
            setPendingDelete(undefined);
          }
        }}
        returnFocusRef={rowTriggerRef}
        title="알림 규칙을 삭제할까요?"
        description={`"${pendingDelete?.name ?? pendingDelete?.id ?? ""}" 규칙을 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        confirmDisabled={!pendingDelete || !actionable(pendingDelete)}
        tone="danger"
        onConfirm={async () => {
          if (pendingDelete) await removeRule.mutateAsync(pendingDelete);
        }}
      >
        {pendingDelete && !actionable(pendingDelete) ? (
          <InlineNotice title="알림 규칙 삭제가 잠겼습니다.">
            {access.write.reason ?? "규칙 원본을 다시 조회하고 검토하세요."}
          </InlineNotice>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
