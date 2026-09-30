import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import { routingRulesQueryKey, writeScopeMessage } from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice, ScopeNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import {
  type RoutingRule,
  type RoutingRuleInput,
  type RoutingRuleToggleInput,
} from "@/shared/api/domains/routing";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState, pageFromParam } from "@/shared/hooks/use-search-state";
import { RoutingToggleDialog } from "./RoutingToggleDialog";
import { useRoutingToggleAccess } from "./routing-toggle-access";
import { useRoutingToggleData } from "./routing-toggle-data";
import { useRoutingToggleSelection } from "./routing-toggle-selection";
import { useRuleColumns } from "./routing-rule-columns";
import { useRoutingToggleFocus } from "./routing-toggle-focus";

const pageSize = 10;

const ruleFormSchema = z.object({
  match_pattern: z.string().trim().max(200),
  target_model: z.string().trim().min(1, "대상 모델을 입력하세요."),
  target_provider: z.string().trim().max(120),
  min_complexity: z.coerce.number().int().min(0).max(100),
  max_complexity: z.coerce.number().int().min(0).max(100),
  priority: z.coerce.number().int().min(1).max(10_000),
  note: z.string().trim().max(500),
});

type RuleFormInput = z.input<typeof ruleFormSchema>;
type RuleFormValues = z.output<typeof ruleFormSchema>;

export function RulesTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<RoutingRule>();
  const [pendingDelete, setPendingDelete] = useState<RoutingRule>();
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [deleteTrigger, setDeleteTrigger] = useState<HTMLElement | null>(null);
  const [editTrigger, setEditTrigger] = useState<HTMLElement | null>(null);

  const toggleAccess = useRoutingToggleAccess(canWrite);
  const toggleData = useRoutingToggleData(toggleAccess);
  const toggleSelection = useRoutingToggleSelection(toggleAccess, toggleData);
  const {
    panel: togglePanelRef,
    register: registerToggle,
    returnFocusRef: toggleReturnFocusRef,
  } = useRoutingToggleFocus(toggleSelection.target?.rule.id);
  const rules = toggleData.query;

  const form = useZodForm<RuleFormInput, RuleFormValues>(ruleFormSchema, {
    match_pattern: "*",
    target_model: "",
    target_provider: "",
    min_complexity: 0,
    max_complexity: 100,
    priority: 100,
    note: "",
  });

  const createRule = useMutationFeedback<RoutingRuleInput, unknown>({
    mutate: (body) => apiClient.request(endpoints.domains.routing.rules.create, { body }),
    invalidates: [routingRulesQueryKey],
    successMessage: "라우팅 규칙을 만들었습니다.",
    errorMessage: "라우팅 규칙을 만들지 못했습니다.",
  });

  const deleteRule = useMutationFeedback<string, unknown>({
    mutate: (id) => apiClient.request(withPathParams(endpoints.domains.routing.rules.remove, { id })),
    invalidates: [routingRulesQueryKey],
    successMessage: "라우팅 규칙을 삭제했습니다.",
    errorMessage: "라우팅 규칙을 삭제하지 못했습니다.",
  });

  const updateRule = useMutationFeedback<{ id: string; body: RoutingRuleToggleInput }, unknown>({
    mutate: ({ body, id }) =>
      apiClient.request(withPathParams(endpoints.domains.routing.rules.update, { id }), { body }),
    invalidates: [routingRulesQueryKey],
    successMessage: "라우팅 규칙을 수정했습니다.",
    errorMessage: "라우팅 규칙을 수정하지 못했습니다.",
  });

  const rows = [...(rules.data?.rules ?? [])].sort(
    (left, right) => left.priority - right.priority || left.target_model.localeCompare(right.target_model),
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(pageFromParam(searchParams.get("page")), pageCount);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="routing-panel-stack" ref={togglePanelRef} tabIndex={-1}>
      {canWrite ? null : <ScopeNotice>{writeScopeMessage}</ScopeNotice>}
      {rules.isError ? (
        <QueryFailureNotice
          error={rules.error}
          hasData={Boolean(rules.data)}
          label="라우팅 규칙"
          onRetry={() => void toggleData.refresh().catch(() => undefined)}
        />
      ) : null}

      <SectionCard
        title="복잡도 기반 라우팅 규칙"
        description="요청 복잡도 점수와 모델 패턴이 모두 맞는 규칙 중 우선순위가 가장 앞선 규칙이 적용됩니다."
        actions={
          <div className="routing-tab-actions">
            <Button
              ref={createTrigger}
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeScopeMessage}
              onClick={() => setCreateOpen(true)}
            >
              <Plus aria-hidden="true" /> 규칙 추가
            </Button>
          </div>
        }
      >
        <DataTable
          caption="복잡도 기반 라우팅 규칙 목록"
          columns={useRuleColumns(
            canWrite,
            {
              onDelete: (rule, trigger) => {
                setDeleteTrigger(trigger);
                setPendingDelete(rule);
              },
              onEdit: (rule, trigger) => {
                setEditTrigger(trigger);
                form.reset({
                  match_pattern: rule.match_pattern,
                  target_model: rule.target_model,
                  target_provider: rule.target_provider,
                  min_complexity: rule.min_complexity,
                  max_complexity: rule.max_complexity,
                  priority: rule.priority,
                  note: rule.note,
                });
                setEditing(rule);
              },
              onToggle: toggleSelection.open,
              onToggleRef: registerToggle,
            },
            {
              allowed: toggleAccess.write.allowed && toggleData.confirmed,
              reason:
                toggleAccess.write.reason ??
                (!toggleData.confirmed ? "최신 규칙 목록을 다시 조회하세요." : undefined),
            },
          )}
          data={pageRows}
          emptyMessage="등록된 라우팅 규칙이 없습니다. 규칙을 추가하면 복잡도에 따라 모델을 자동으로 바꿉니다."
          error={rules.isError && !rules.data ? "라우팅 규칙을 불러오지 못했습니다." : undefined}
          getRowId={(row) => row.id}
          loading={rules.isPending}
          onPageChange={(index) => updateSearch({ page: index === 0 ? undefined : index + 1 })}
          onRetry={() => void toggleData.refresh().catch(() => undefined)}
          pageCount={pageCount}
          pageIndex={page - 1}
        />
        <p className="routing-meta">
          사용 상태는 설정을 다시 읽은 서버에 반영되며, 실제 선택은 라우팅 활성 여부·조건·우선순위에 따릅니다.
        </p>
      </SectionCard>

      <FormDialog
        description="복잡도 범위와 모델 패턴이 맞는 요청을 지정한 모델로 라우팅합니다."
        form={form}
        onOpenChange={(open) => {
          if (editing) {
            if (!open) {
              setEditing(undefined);
              form.reset();
            }
            return;
          }
          setCreateOpen(open);
          if (!open) form.reset();
        }}
        onSubmit={async (values) => {
          if (values.min_complexity > values.max_complexity) {
            throw new Error("복잡도 범위는 최소값이 최대값보다 클 수 없습니다.");
          }
          const body = {
            match_pattern: values.match_pattern || "*",
            target_model: values.target_model,
            target_provider: values.target_provider,
            min_complexity: values.min_complexity,
            max_complexity: values.max_complexity,
            priority: values.priority,
            note: values.note,
          };
          if (editing) {
            // Editing in place keeps the rule live. Deleting and recreating it
            // would route traffic differently for as long as it is gone.
            await updateRule.mutateAsync({ id: editing.id, body });
            setEditing(undefined);
            form.reset();
            return;
          }
          await createRule.mutateAsync({ ...body, enabled: true });
        }}
        open={createOpen || editing !== undefined}
        returnFocusRef={editing ? { current: editTrigger } : createTrigger}
        submitLabel={editing ? "규칙 저장" : "규칙 만들기"}
        title={editing ? "라우팅 규칙 수정" : "라우팅 규칙 추가"}
      >
        <FormField
          label="모델 패턴"
          description="들어온 모델 이름과 비교할 glob 패턴입니다. 비우면 * (전체)."
          error={form.formState.errors.match_pattern?.message}
        >
          {(control) => <Input {...control} {...form.register("match_pattern")} placeholder="gpt-*" />}
        </FormField>
        <FormField label="대상 모델" required error={form.formState.errors.target_model?.message}>
          {(control) => <Input {...control} {...form.register("target_model")} placeholder="gpt-4.1-mini" />}
        </FormField>
        <FormField
          label="대상 공급자"
          description="비우면 라우팅이 공급자를 자동으로 고릅니다."
          error={form.formState.errors.target_provider?.message}
        >
          {(control) => <Input {...control} {...form.register("target_provider")} />}
        </FormField>
        <FormField label="최소 복잡도" required error={form.formState.errors.min_complexity?.message}>
          {(control) => (
            <Input {...control} type="number" min={0} max={100} {...form.register("min_complexity")} />
          )}
        </FormField>
        <FormField label="최대 복잡도" required error={form.formState.errors.max_complexity?.message}>
          {(control) => (
            <Input {...control} type="number" min={0} max={100} {...form.register("max_complexity")} />
          )}
        </FormField>
        <FormField
          label="우선순위"
          description="숫자가 작을수록 먼저 평가합니다."
          required
          error={form.formState.errors.priority?.message}
        >
          {(control) => <Input {...control} type="number" min={1} {...form.register("priority")} />}
        </FormField>
        <FormField label="메모" error={form.formState.errors.note?.message}>
          {(control) => <Textarea {...control} rows={2} {...form.register("note")} />}
        </FormField>
      </FormDialog>

      {toggleSelection.target ? (
        <RoutingToggleDialog
          key={`${toggleAccess.securityKey}:${toggleSelection.target.sequence}`}
          rule={toggleSelection.target.rule}
          intendedEnabled={toggleSelection.target.intendedEnabled}
          access={toggleAccess}
          data={toggleData}
          onClose={() => {
            if (toggleSelection.target) toggleSelection.close(toggleSelection.target.sequence);
          }}
          returnFocusRef={toggleReturnFocusRef}
        />
      ) : null}

      <ConfirmDialog
        confirmLabel="삭제"
        description={
          pendingDelete
            ? `${pendingDelete.match_pattern || "*"} → ${pendingDelete.target_model} 규칙을 삭제합니다.`
            : "라우팅 규칙을 삭제합니다."
        }
        onConfirm={async () => {
          if (pendingDelete) await deleteRule.mutateAsync(pendingDelete.id);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        open={pendingDelete !== undefined}
        returnFocusRef={{ current: deleteTrigger }}
        title="라우팅 규칙 삭제"
        tone="danger"
      >
        <p>삭제하면 이 규칙에 걸리던 요청은 다음 우선순위 규칙 또는 기본 라우팅을 따릅니다.</p>
      </ConfirmDialog>
    </div>
  );
}
