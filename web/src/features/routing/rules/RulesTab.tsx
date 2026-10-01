import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";

import { routingRulesQueryKey, writeScopeMessage } from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice, ScopeNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import { type RoutingRule, type RoutingRuleInput } from "@/shared/api/domains/routing";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
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
import { useRoutingEditAccess } from "./routing-rule-edit-access";
import { editIdentityReason } from "./routing-rule-edit-state";
import { sameRoutingRule } from "./routing-toggle-state";
import { RoutingRuleEditDialog } from "./RoutingRuleEditDialog";
import { RoutingRuleDeleteDialog } from "./RoutingRuleDeleteDialog";
import { useRoutingDeleteAccess } from "./routing-rule-delete-access";
import { deleteIdentityReason } from "./routing-rule-delete-state";

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
  const createTrigger = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const editAccess = useRoutingEditAccess(canWrite);
  const serial = useRef(0);
  const editActive = useRef<number | undefined>(undefined);
  const [editSelection, setEditSelection] = useState<{
    lifetime: object;
    target?: { rule: RoutingRule; serial: number };
  }>({ lifetime: editAccess.lifetime });
  if (editSelection.lifetime !== editAccess.lifetime) {
    setEditSelection({ lifetime: editAccess.lifetime });
  }
  const editing = editSelection.lifetime === editAccess.lifetime ? editSelection.target : undefined;
  const {
    panel: editPanelRef,
    register: registerEdit,
    returnFocusRef: editReturnFocusRef,
  } = useRoutingToggleFocus(editing?.rule.id);
  useLayoutEffect(() => {
    editActive.current = undefined;
  }, [editAccess.lifetime]);

  const deleteAccess = useRoutingDeleteAccess(canWrite);
  const deleteSerial = useRef(0);
  const deleteActive = useRef<number | undefined>(undefined);
  const [deleteSelection, setDeleteSelection] = useState<{
    lifetime: object;
    target?: { rule: RoutingRule; serial: number };
  }>({ lifetime: deleteAccess.lifetime });
  if (deleteSelection.lifetime !== deleteAccess.lifetime) {
    setDeleteSelection({ lifetime: deleteAccess.lifetime });
  }
  const deleting = deleteSelection.lifetime === deleteAccess.lifetime ? deleteSelection.target : undefined;
  const {
    panel: deletePanelRef,
    register: registerDelete,
    returnFocusRef: deleteReturnFocusRef,
  } = useRoutingToggleFocus(deleting?.rule.id);
  useLayoutEffect(() => {
    deleteActive.current = undefined;
  }, [deleteAccess.lifetime]);

  const toggleAccess = useRoutingToggleAccess(canWrite);
  const toggleData = useRoutingToggleData(toggleAccess);
  const toggleSelection = useRoutingToggleSelection(toggleAccess, toggleData);
  const {
    panel: togglePanelRef,
    register: registerToggle,
    returnFocusRef: toggleReturnFocusRef,
  } = useRoutingToggleFocus(toggleSelection.target?.rule.id);
  const rules = toggleData.query;
  const parentKey = [...routingRulesQueryKey, toggleAccess.epoch, toggleAccess.owner] as const;
  const renderedQuery = client.getQueryCache().find({ queryKey: parentKey, exact: true });
  const renderedCount = renderedQuery?.state.dataUpdateCount;
  const renderedData = renderedQuery?.state.data;

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

  const rows = [...(rules.data?.rules ?? [])].sort(
    (left, right) => left.priority - right.priority || left.target_model.localeCompare(right.target_model),
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(pageFromParam(searchParams.get("page")), pageCount);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div
      className="routing-panel-stack"
      ref={(node) => {
        togglePanelRef.current = node;
        editPanelRef.current = node;
        deletePanelRef.current = node;
      }}
      tabIndex={-1}
    >
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
                try {
                  deleteAccess.assertApproval(deleteAccess.approval);
                  const query = client.getQueryCache().find({ queryKey: parentKey, exact: true });
                  if (
                    deleteActive.current !== undefined ||
                    !query ||
                    query !== renderedQuery ||
                    query.state.dataUpdateCount !== renderedCount ||
                    query.state.data !== renderedData
                  )
                    return;
                  const current = toggleData.assertConfirmed().find((candidate) => candidate.id === rule.id);
                  if (!sameRoutingRule(current, rule) || deleteIdentityReason(rule)) return;
                  const sequence = ++deleteSerial.current;
                  deleteActive.current = sequence;
                  registerDelete(rule.id, trigger);
                  setDeleteSelection({
                    lifetime: deleteAccess.lifetime,
                    target: { rule: Object.freeze({ ...rule }), serial: sequence },
                  });
                } catch {
                  /* Retired callbacks and unconfirmed lists cannot open a deletion. */
                }
              },
              onDeleteRef: registerDelete,
              onEdit: (rule, trigger) => {
                try {
                  editAccess.assertApproval(editAccess.approval);
                  const query = client.getQueryCache().find({ queryKey: parentKey, exact: true });
                  if (
                    editActive.current !== undefined ||
                    !query ||
                    query !== renderedQuery ||
                    query.state.dataUpdateCount !== renderedCount ||
                    query.state.data !== renderedData
                  )
                    return;
                  const current = toggleData.assertConfirmed().find((candidate) => candidate.id === rule.id);
                  if (!sameRoutingRule(current, rule) || editIdentityReason(rule)) return;
                  const sequence = ++serial.current;
                  editActive.current = sequence;
                  registerEdit(rule.id, trigger);
                  setEditSelection({
                    lifetime: editAccess.lifetime,
                    target: { rule: { ...rule }, serial: sequence },
                  });
                } catch {
                  /* No new edit from a retired callback or unconfirmed list. */
                }
              },
              onEditRef: registerEdit,
              onToggle: toggleSelection.open,
              onToggleRef: registerToggle,
            },
            {
              allowed: toggleAccess.write.allowed && toggleData.confirmed,
              reason:
                toggleAccess.write.reason ??
                (!toggleData.confirmed ? "최신 규칙 목록을 다시 조회하세요." : undefined),
            },
            {
              allowed: editAccess.write.allowed && toggleData.confirmed,
              reason:
                editAccess.write.reason ??
                (!toggleData.confirmed ? "최신 규칙 목록을 다시 조회하세요." : undefined),
              prefixes: editAccess.prefixes,
            },
            {
              allowed: deleteAccess.write.allowed && toggleData.confirmed,
              reason:
                deleteAccess.write.reason ??
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
          await createRule.mutateAsync({ ...body, enabled: true });
        }}
        open={createOpen}
        returnFocusRef={createTrigger}
        submitLabel="규칙 만들기"
        title="라우팅 규칙 추가"
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

      {editing ? (
        <RoutingRuleEditDialog
          key={`${editAccess.key}:${editing.serial}`}
          rule={editing.rule}
          access={editAccess}
          returnFocusRef={editReturnFocusRef}
          onClose={() => {
            if (editActive.current !== editing.serial) return;
            editActive.current = undefined;
            setEditSelection({ lifetime: editAccess.lifetime });
          }}
        />
      ) : null}

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

      {deleting ? (
        <RoutingRuleDeleteDialog
          key={`${deleteAccess.key}:${deleting.serial}`}
          rule={deleting.rule}
          access={deleteAccess}
          returnFocusRef={deleteReturnFocusRef}
          onClose={() => {
            if (deleteActive.current !== deleting.serial) return;
            deleteActive.current = undefined;
            setDeleteSelection({ lifetime: deleteAccess.lifetime });
          }}
        />
      ) : null}
    </div>
  );
}
