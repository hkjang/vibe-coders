import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { routingRulesQueryKey, writeScopeMessage } from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice, ScopeNotice } from "@/features/routing/rules/routing-ui";
import { type RoutingRule } from "@/shared/api/domains/routing";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable } from "@/shared/data-table/DataTable";
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
import { RoutingRuleCreateDialog } from "./RoutingRuleCreateDialog";
import { useRoutingCreateAccess } from "./routing-rule-create-access";

const pageSize = 10;

export function RulesTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const createTrigger = useRef<HTMLButtonElement>(null);
  const createPanel = useRef<HTMLDivElement>(null);
  const createAccess = useRoutingCreateAccess(canWrite);
  const createSerial = useRef(0);
  const createActive = useRef<number | undefined>(undefined);
  const [createSelection, setCreateSelection] = useState<{ lifetime: object; serial?: number }>({
    lifetime: createAccess.lifetime,
  });
  if (createSelection.lifetime !== createAccess.lifetime)
    setCreateSelection({ lifetime: createAccess.lifetime });
  const creating = createSelection.lifetime === createAccess.lifetime ? createSelection.serial : undefined;
  useLayoutEffect(() => {
    createActive.current = undefined;
  }, [createAccess.lifetime]);
  const createReturnFocus = useMemo(
    () => ({
      get current() {
        const button = createTrigger.current;
        return button?.isConnected && !button.disabled ? button : createPanel.current;
      },
    }),
    [],
  );
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
        createPanel.current = node;
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
              disabled={!createAccess.write.allowed}
              title={createAccess.write.reason}
              onClick={() => {
                try {
                  createAccess.assertApproval(createAccess.approval);
                  if (createActive.current !== undefined) return;
                  const sequence = ++createSerial.current;
                  createActive.current = sequence;
                  setCreateSelection({ lifetime: createAccess.lifetime, serial: sequence });
                } catch {
                  /* Retired create trigger. */
                }
              }}
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

      {creating !== undefined ? (
        <RoutingRuleCreateDialog
          key={`${createAccess.key}:${creating}`}
          access={createAccess}
          returnFocusRef={createReturnFocus}
          onClose={() => {
            if (createActive.current !== creating) return;
            createActive.current = undefined;
            setCreateSelection({ lifetime: createAccess.lifetime });
          }}
        />
      ) : null}

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
