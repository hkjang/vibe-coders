import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useWatch } from "react-hook-form";
import { formatKRW, formatNumber } from "@/shared/utils/format";
import { scopeLabels, type QuotaBudgetOperations } from "./use-quota-budget-operations";
export function QuotaBudgetDialogs({ operations }: { operations: QuotaBudgetOperations }) {
  const {
    quotaOpen,
    setQuotaOpen,
    budgetOpen,
    setBudgetOpen,
    editingQuota,
    setEditingQuota,
    togglingQuota,
    setTogglingQuota,
    removingQuota,
    setRemovingQuota,
    removingBudget,
    setRemovingBudget,
    quotaTrigger,
    budgetTrigger,
    rowTrigger,
    quotaForm,
    quotaEditForm,
    budgetForm,
    createQuota,
    updateQuota,
    removeQuota,
    createBudget,
    removeBudget,
    write,
    assertCurrent,
  } = operations;
  const editValues = useWatch({ control: quotaEditForm.control });
  return (
    <>
      <FormDialog
        scrollBody
        submitDisabled={!write.allowed}
        form={quotaForm}
        open={quotaOpen}
        onOpenChange={setQuotaOpen}
        returnFocusRef={quotaTrigger}
        title="할당량 추가"
        description="범위와 주기를 정하고 토큰 또는 비용 한도를 하나 이상 입력합니다."
        onSubmit={async (values) => {
          assertCurrent();
          const tokenLimit = Number(values.token_limit);
          const krwLimit = Number(values.krw_limit);
          await createQuota.mutateAsync({
            scope: values.scope,
            scope_value: values.scope === "global" ? "*" : values.scope_value.trim(),
            period: values.period,
            ...(tokenLimit > 0 ? { token_limit: tokenLimit } : {}),
            ...(krwLimit > 0 ? { krw_limit: krwLimit } : {}),
            enabled: true,
            ...(values.note ? { note: values.note } : {}),
          });
          assertCurrent();
          setQuotaOpen(false);
        }}
      >
        {!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
        <FormField label="범위">
          {(control) => (
            <Select {...control} {...quotaForm.register("scope")}>
              <option value="api_key">API 키</option>
              <option value="team">팀</option>
              <option value="ip">IP</option>
              <option value="global">전체</option>
            </Select>
          )}
        </FormField>
        <FormField
          label="대상"
          description="키 ID, 팀 이름 또는 IP. 전체 범위에서는 자동으로 *가 됩니다."
          error={quotaForm.formState.errors.scope_value?.message}
        >
          {(control) => <Input {...control} {...quotaForm.register("scope_value")} />}
        </FormField>
        <FormField label="주기">
          {(control) => (
            <Select {...control} {...quotaForm.register("period")}>
              <option value="daily">일별</option>
              <option value="monthly">월별</option>
            </Select>
          )}
        </FormField>
        <FormField label="토큰 한도" error={quotaForm.formState.errors.token_limit?.message}>
          {(control) => <Input {...control} type="number" min={0} {...quotaForm.register("token_limit")} />}
        </FormField>
        <FormField label="비용 한도(원)" error={quotaForm.formState.errors.krw_limit?.message}>
          {(control) => <Input {...control} type="number" min={0} {...quotaForm.register("krw_limit")} />}
        </FormField>
        <FormField label="메모">
          {(control) => <Textarea {...control} rows={2} {...quotaForm.register("note")} />}
        </FormField>
      </FormDialog>
      <FormDialog
        scrollBody
        submitDisabled={!write.allowed}
        form={budgetForm}
        open={budgetOpen}
        onOpenChange={setBudgetOpen}
        returnFocusRef={budgetTrigger}
        title="예산 추가"
        description="월 예산을 정하면 소진율과 이번 달 예상 지출을 추적합니다."
        onSubmit={async (values) => {
          assertCurrent();
          await createBudget.mutateAsync({
            scope: values.scope,
            scope_value: values.scope === "global" ? "*" : values.scope_value.trim(),
            monthly_krw: Number(values.monthly_krw),
            ...(values.note ? { note: values.note } : {}),
          });
          assertCurrent();
          setBudgetOpen(false);
        }}
      >
        {!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
        <FormField label="범위" description="예산은 IP 범위를 지원하지 않습니다.">
          {(control) => (
            <Select {...control} {...budgetForm.register("scope")}>
              <option value="global">전체</option>
              <option value="team">팀</option>
              <option value="api_key">API 키</option>
            </Select>
          )}
        </FormField>
        <FormField label="대상" error={budgetForm.formState.errors.scope_value?.message}>
          {(control) => <Input {...control} {...budgetForm.register("scope_value")} />}
        </FormField>
        <FormField label="월 예산(원)" required error={budgetForm.formState.errors.monthly_krw?.message}>
          {(control) => <Input {...control} type="number" min={1} {...budgetForm.register("monthly_krw")} />}
        </FormField>
        <FormField label="메모">
          {(control) => <Textarea {...control} rows={2} {...budgetForm.register("note")} />}
        </FormField>
      </FormDialog>
      <FormDialog
        scrollBody
        submitDisabled={!write.allowed}
        form={quotaEditForm}
        open={editingQuota !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditingQuota(undefined);
        }}
        returnFocusRef={rowTrigger}
        title="할당량 수정"
        description="한도와 메모, 사용 여부만 바꿀 수 있습니다. 범위와 주기는 만들 때 정해집니다."
        onSubmit={async (values) => {
          assertCurrent();
          if (!editingQuota) return;
          await updateQuota.mutateAsync({
            id: editingQuota.quota.id,
            body: {
              token_limit: Number(values.token_limit) || 0,
              krw_limit: Number(values.krw_limit) || 0,
              enabled: values.enabled,
              note: values.note,
            },
          });
          assertCurrent();
          setEditingQuota(undefined);
        }}
      >
        {!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
        <FormField label="범위와 대상">
          {(control) => (
            <Input
              {...control}
              readOnly
              value={`${scopeLabels[editingQuota?.quota.scope ?? ""] ?? editingQuota?.quota.scope ?? ""} · ${editingQuota?.quota.scope_value || "*"}`}
            />
          )}
        </FormField>
        <FormField
          label="토큰 한도"
          description="0을 넣으면 토큰 한도를 없앱니다."
          error={quotaEditForm.formState.errors.token_limit?.message}
        >
          {(control) => (
            <Input {...control} type="number" min={0} {...quotaEditForm.register("token_limit")} />
          )}
        </FormField>
        <FormField
          label="비용 한도(원)"
          description="0을 넣으면 비용 한도를 없앱니다."
          error={quotaEditForm.formState.errors.krw_limit?.message}
        >
          {(control) => <Input {...control} type="number" min={0} {...quotaEditForm.register("krw_limit")} />}
        </FormField>
        <FormField label="메모">
          {(control) => <Textarea {...control} rows={2} {...quotaEditForm.register("note")} />}
        </FormField>
        <Switch
          checked={editValues.enabled ?? true}
          onCheckedChange={(enabled) => quotaEditForm.setValue("enabled", enabled, { shouldDirty: true })}
          label={editValues.enabled ? "사용 중" : "중지됨"}
        />
        {editingQuota ? (
          <div
            className="data-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="할당량 변경 비교, 가로 스크롤 가능"
          >
            <table className="data-table">
              <caption>저장 전 변경 비교</caption>
              <thead>
                <tr>
                  {["항목", "변경 전", "변경 후"].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "토큰 한도",
                    formatNumber(editingQuota.quota.token_limit),
                    formatNumber(Number(editValues.token_limit)),
                  ],
                  [
                    "비용 한도",
                    formatKRW(editingQuota.quota.krw_limit),
                    formatKRW(Number(editValues.krw_limit)),
                  ],
                  [
                    "상태",
                    editingQuota.quota.enabled ? "사용" : "중지",
                    editValues.enabled ? "사용" : "중지",
                  ],
                  ["메모", editingQuota.quota.note || "없음", editValues.note || "없음"],
                ].map(([label, before, after]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>{before}</td>
                    <td>{after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="access-note">
              한도 0은 제한 없음입니다. 중지하면 해당 범위의 한도가 적용되지 않습니다. 다른 관리자의 동시
              변경을 잠그지는 않습니다.
            </p>
          </div>
        ) : null}
      </FormDialog>
      <ConfirmDialog
        confirmDisabled={!write.allowed}
        children={!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
        open={togglingQuota !== undefined}
        onOpenChange={(open) => {
          if (!open) setTogglingQuota(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone={togglingQuota?.quota.enabled ? "danger" : "primary"}
        title={togglingQuota?.quota.enabled ? "할당량 중지" : "할당량 사용"}
        description={
          togglingQuota?.quota.enabled
            ? `${togglingQuota.quota.scope_value || "*"} 대상 할당량을 중지합니다. 중지하는 동안 이 범위에는 한도가 적용되지 않습니다.`
            : `${togglingQuota?.quota.scope_value || "*"} 대상 할당량을 다시 적용합니다.`
        }
        confirmLabel={togglingQuota?.quota.enabled ? "중지" : "사용"}
        onConfirm={async () => {
          assertCurrent();
          if (togglingQuota) {
            await updateQuota.mutateAsync({
              id: togglingQuota.quota.id,
              body: { enabled: !togglingQuota.quota.enabled },
            });
          }
          assertCurrent();
          setTogglingQuota(undefined);
        }}
      />
      <ConfirmDialog
        confirmDisabled={!write.allowed}
        children={!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
        open={removingQuota !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemovingQuota(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="할당량 삭제"
        description={`${removingQuota?.quota.scope_value || "*"} 대상 할당량을 삭제합니다. 이후 해당 범위에는 한도가 적용되지 않습니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          assertCurrent();
          if (removingQuota) await removeQuota.mutateAsync(removingQuota.quota.id);
          assertCurrent();
          setRemovingQuota(undefined);
        }}
      />
      <ConfirmDialog
        confirmDisabled={!write.allowed}
        children={!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
        open={removingBudget !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemovingBudget(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="예산 삭제"
        description={`${removingBudget?.budget.scope_value || "*"} 대상 예산을 삭제합니다. 소진율 추적과 경보가 중단됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          assertCurrent();
          if (removingBudget) await removeBudget.mutateAsync(removingBudget.budget.id);
          assertCurrent();
          setRemovingBudget(undefined);
        }}
      />
    </>
  );
}
