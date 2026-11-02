import type { RefObject } from "react";
import { riskLabel } from "@/features/mcp/mcp-utils";
import type { McpContract } from "@/shared/api/domains/mcp.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import {
  contractBody,
  contractChanges,
  contractDraft,
  contractFormSchema,
  type ContractDraft,
} from "./contract-review";
import { useContractOperation } from "./use-contract-operation";

interface Props {
  owner: FeatureReadOwner;
  original?: McpContract;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
const riskOptions = ["low", "medium", "high"].map((value) => ({ value, label: riskLabel(value) }));
function Notice({ operation }: { operation: ReturnType<typeof useContractOperation> }) {
  return !operation.allowed ? (
    <InlineNotice tone="warning">
      {operation.conflict
        ? "계약이 변경되거나 삭제되었습니다. 초안을 보존했으니 창을 닫고 새로 조회한 뒤 검토하세요."
        : operation.attempted
          ? "변경 요청을 전송했습니다. 처리 결과가 불확실하면 다시 저장하지 말고 목록을 새로 조회하세요."
          : operation.reason}
    </InlineNotice>
  ) : null;
}
function Limits() {
  return (
    <p>
      레지스트리 선언을 변경합니다. 실제 도구 구현이나 실행 권한·타임아웃을 변경하지 않습니다. 저장 직전
      재조회는 서버 동시 변경 잠금이 아닙니다. 입력·출력 스키마는 각각 64KB 이하이며 비우면 해당 선언을
      제거합니다.
    </p>
  );
}
export function ContractEditor({ owner, original, onClose, returnFocusRef }: Props) {
  const form = useZodForm<ContractDraft, ContractDraft>(contractFormSchema, contractDraft(original));
  const operation = useContractOperation(owner);
  const draft = form.watch();
  const changes = contractChanges(original, draft);
  const after = contractBody(draft);
  const before = original ? contractBody(contractDraft(original)) : undefined;
  const display = (key: string, value: unknown) =>
    key === "risk_level"
      ? riskLabel(String(value))
      : typeof value === "boolean"
        ? value
          ? "사용"
          : "중지"
        : String(value ?? "") || "비어 있음";
  return (
    <FormDialog
      form={form}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="도구 계약"
      description="입력·출력 스키마와 변경 전후 값을 확인한 뒤 저장합니다."
      returnFocusRef={returnFocusRef}
      scrollBody
      submitLabel="검토한 계약 저장"
      submitDisabled={!operation.allowed || changes.length === 0}
      onSubmit={async (values) => {
        await operation.mutateAsync({ kind: "save", draft: values, original });
        operation.assertCurrent();
        onClose();
      }}
    >
      <Notice operation={operation} />
      <FormField label="도구 이름" required error={form.formState.errors.name?.message}>
        {(control) => <Input {...control} {...form.register("name")} placeholder="gateway_chat" />}
      </FormField>
      <FormField label="네임스페이스" error={form.formState.errors.namespace?.message}>
        {(control) => <Input {...control} {...form.register("namespace")} />}
      </FormField>
      <FormField label="표시 제목" error={form.formState.errors.title?.message}>
        {(control) => <Input {...control} {...form.register("title")} />}
      </FormField>
      <FormField label="위험도" required error={form.formState.errors.risk_level?.message}>
        {(control) => (
          <Select {...control} {...form.register("risk_level")} options={riskOptions}>
            {!riskOptions.some((option) => option.value === draft.risk_level) ? (
              <option value={draft.risk_level}>지원하지 않는 현재 값: {draft.risk_level || "미지정"}</option>
            ) : null}
          </Select>
        )}
      </FormField>
      <FormField label="담당" error={form.formState.errors.owner?.message}>
        {(control) => <Input {...control} {...form.register("owner")} />}
      </FormField>
      <FormField label="허용 역할 (쉼표 구분)" error={form.formState.errors.allowed_roles?.message}>
        {(control) => <Input {...control} {...form.register("allowed_roles")} />}
      </FormField>
      <FormField label="비용 정책" error={form.formState.errors.cost_policy?.message}>
        {(control) => <Input {...control} {...form.register("cost_policy")} />}
      </FormField>
      <FormField label="타임아웃(ms)" error={form.formState.errors.timeout_ms?.message}>
        {(control) => <Input {...control} {...form.register("timeout_ms")} inputMode="numeric" />}
      </FormField>
      <FormField label="설명" error={form.formState.errors.description?.message}>
        {(control) => <Textarea {...control} {...form.register("description")} rows={2} />}
      </FormField>
      <FormField label="입력 스키마 (JSON)" error={form.formState.errors.input_schema?.message}>
        {(control) => <Textarea {...control} {...form.register("input_schema")} rows={4} className="mono" />}
      </FormField>
      <FormField label="출력 스키마 (JSON)" error={form.formState.errors.output_schema?.message}>
        {(control) => <Textarea {...control} {...form.register("output_schema")} rows={4} className="mono" />}
      </FormField>
      <Checkbox label="사용 (활성화)" {...form.register("enabled")} />

      <section className="mcp-risk-review" aria-label="계약 변경 비교">
        <h3>저장할 변경 내용</h3>
        {changes.length === 0 ? (
          <p>변경한 항목이 없습니다.</p>
        ) : (
          <dl>
            {changes.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  <details open={!key.endsWith("_schema")}>
                    <summary>변경 전후 보기</summary>
                    <p>변경 전</p>
                    <pre className="mcp-call-preview" tabIndex={0}>
                      {before ? display(key, before[key]) : "미등록"}
                    </pre>
                    <p>변경 후</p>
                    <pre className="mcp-call-preview" tabIndex={0}>
                      {display(key, after[key])}
                    </pre>
                  </details>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <Limits />
    </FormDialog>
  );
}
export function ContractDelete({ original, ...props }: Props & { original: McpContract }) {
  const operation = useContractOperation(props.owner);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="도구 계약을 삭제할까요?"
      description={
        original.name + " 계약이 삭제되어 검증 대상에서 제외됩니다. 실제 도구는 삭제하지 않습니다."
      }
      returnFocusRef={props.returnFocusRef}
      tone="danger"
      requireTarget={original.name || original.id}
      confirmLabel="검토한 계약 삭제"
      confirmDisabled={!operation.allowed}
      onConfirm={async () => {
        await operation.mutateAsync({ kind: "delete", original });
        operation.assertCurrent();
        props.onClose();
      }}
    >
      <Notice operation={operation} />
      <dl>
        <dt>계약 ID</dt>
        <dd>{original.id}</dd>
        <dt>네임스페이스</dt>
        <dd>{original.namespace}</dd>
        <dt>도구 이름</dt>
        <dd>{original.name}</dd>
      </dl>
      <Limits />
    </ConfirmDialog>
  );
}
