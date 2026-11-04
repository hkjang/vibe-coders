import type { RefObject } from "react";
import { decisionLabel } from "@/features/mcp/mcp-utils";
import type { McpPolicy } from "@/shared/api/domains/mcp.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import {
  policyFormSchema,
  type PolicyDraft,
  type PolicySnapshot,
  type PolicyCommand,
  canDeletePolicy,
} from "./mcp-policy-review";
import { useMcpPolicyOperation } from "./use-mcp-policy-operation";

interface SharedProps {
  owner: FeatureReadOwner;
  canWrite: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
const modes = ["allow", "warn", "block"].map((value) => ({ value, label: decisionLabel(value) }));

function OperationNotice({ operation }: { operation: ReturnType<typeof useMcpPolicyOperation> }) {
  return !operation.allowed ? (
    <InlineNotice tone="warning" title="현재 설정을 다시 확인하세요.">
      {operation.conflict
        ? "정책이나 허용목록 기준이 바뀌었습니다. 입력을 보존했으니 창을 닫고 새로고침한 뒤 검토하세요."
        : operation.reason}
    </InlineNotice>
  ) : null;
}
function ScopeNotice() {
  return (
    <p>
      현재 서버 정책과 허용목록 설정을 검토합니다. 도구별 위험 설정과 다른 정책은 별도로 적용됩니다. 이미 실행
      중인 호출이나 전체 영향 대상은 계산하지 않습니다. 저장 직전 재조회는 서버 동시 변경 잠금이 아닙니다.
    </p>
  );
}

export function PolicyFormDialog({
  before,
  original,
  ...props
}: SharedProps & { before: PolicySnapshot; original?: McpPolicy }) {
  const operation = useMcpPolicyOperation(props.owner, props.canWrite);
  const form = useZodForm<PolicyDraft, PolicyDraft>(policyFormSchema, {
    server_label: original?.server_label ?? "",
    mode: original?.mode ?? "allow",
    note: original?.note ?? "",
  });
  const draft = form.watch();
  const server = draft.server_label.trim();
  const exists = !original && before.policies.some((row) => row.server_label === server);
  const changed = !original || original.mode !== draft.mode || original.note !== draft.note.trim();
  const valid = policyFormSchema.safeParse(draft).success;
  return (
    <FormDialog
      form={form}
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      returnFocusRef={props.returnFocusRef}
      title={original ? "MCP 서버 정책 편집" : "MCP 서버 정책 추가"}
      description="대상 서버와 변경 전후 모드·메모를 확인한 뒤 저장합니다."
      scrollBody
      submitLabel="검토한 정책 저장"
      submitDisabled={!operation.allowed || !valid || !changed || exists}
      onSubmit={async (values) => {
        operation.assertCurrent();
        if (!changed || exists) return;
        await operation.mutateAsync({ kind: "save", before, original, ...values });
        operation.assertCurrent();
        props.onClose();
      }}
    >
      <OperationNotice operation={operation} />
      <FormField
        label="서버 라벨"
        required
        error={form.formState.errors.server_label?.message}
        description={
          original
            ? "편집 중에는 대상 서버를 바꿀 수 없습니다."
            : "기존 서버 정책은 목록의 편집에서 변경하세요."
        }
      >
        {(control) => <Input {...control} {...form.register("server_label")} readOnly={Boolean(original)} />}
      </FormField>
      {exists ? (
        <p className="form-error" role="alert">
          이미 등록된 서버 정책입니다. 창을 닫고 해당 정책의 편집을 선택하세요.
        </p>
      ) : null}
      <FormField label="모드" required error={form.formState.errors.mode?.message}>
        {(control) => (
          <Select {...control} {...form.register("mode")} options={modes}>
            {original && !modes.some((item) => item.value === original.mode) ? (
              <option value={original.mode}>지원하지 않는 현재 값: {original.mode}</option>
            ) : null}
          </Select>
        )}
      </FormField>
      <FormField label="메모" error={form.formState.errors.note?.message}>
        {(control) => <Textarea {...control} {...form.register("note")} rows={2} />}
      </FormField>
      <section className="mcp-risk-review" aria-label="정책 변경 비교">
        <h3>저장할 변경 내용</h3>
        <dl>
          <div>
            <dt>대상 서버</dt>
            <dd>{server || "입력 필요"}</dd>
          </div>
          <div>
            <dt>모드</dt>
            <dd>
              변경 전:{" "}
              {original
                ? decisionLabel(original.mode)
                : before.allowlist_enabled
                  ? "미등록 · 허용목록 외 차단"
                  : "미등록 · 서버 기본 허용"}
              <br />
              변경 후: {decisionLabel(draft.mode)}
            </dd>
          </div>
          <div>
            <dt>메모</dt>
            <dd>
              변경 전: {original?.note || "없음"}
              <br />
              변경 후: {draft.note.trim() || "없음"}
            </dd>
          </div>
        </dl>
        {!changed ? <p>변경된 항목이 없습니다.</p> : null}
        {!valid ? (
          <p role="status">
            대상 서버를 입력하고 지원하는 모드를 명시적으로 선택하세요. 알 수 없는 현재 값은 자동으로 허용하지
            않습니다.
          </p>
        ) : null}
        <ScopeNotice />
      </section>
    </FormDialog>
  );
}

export function PolicyConfirmDialog({
  command,
  ...props
}: SharedProps & { command: Exclude<PolicyCommand, { kind: "save" }> }) {
  const operation = useMcpPolicyOperation(props.owner, props.canWrite);
  const deleting = command.kind === "delete";
  const target = deleting
    ? command.original.server_label
    : command.enabled
      ? "허용목록 사용"
      : "허용목록 해제";
  const unsupported = deleting && !canDeletePolicy(command.original.server_label);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      returnFocusRef={props.returnFocusRef}
      tone="danger"
      title={deleting ? "정책을 삭제할까요?" : "허용목록 모드를 변경할까요?"}
      description={
        deleting
          ? "선택한 서버의 명시적 정책을 삭제합니다."
          : "미등록 서버 전체의 접근 기준에 영향을 줍니다. 변경 내용을 확인하세요."
      }
      requireTarget={target}
      confirmLabel={deleting ? "삭제" : "검토한 모드 적용"}
      confirmDisabled={!operation.allowed || unsupported}
      onConfirm={async (_reason, typed) => {
        operation.assertCurrent();
        if (typed !== target) return;
        await operation.mutateAsync(command);
        operation.assertCurrent();
        props.onClose();
      }}
    >
      <OperationNotice operation={operation} />
      {unsupported ? (
        <p role="alert">기존 삭제 API에서 지원하지 않는 서버 라벨입니다. 관리자에게 확인하세요.</p>
      ) : null}
      <section className="mcp-risk-review" aria-label="정책 변경 비교">
        {deleting ? (
          <>
            <p>대상 서버: {command.original.server_label}</p>
            <p>변경 전: {decisionLabel(command.original.mode)}</p>
            <p>
              삭제 후:{" "}
              {command.before.allowlist_enabled ? "미등록 · 허용목록 외 차단" : "미등록 · 서버 기본 허용"}
            </p>
            <p>메모: {command.original.note || "없음"}</p>
          </>
        ) : (
          <>
            <p>변경 전: {command.before.allowlist_enabled ? "사용" : "미사용"}</p>
            <p>변경 후: {command.enabled ? "사용" : "미사용"}</p>
            <p>
              {command.enabled
                ? "등록되지 않은 서버를 차단합니다. 등록된 서버도 명시적 차단 정책과 도구 위험 설정이 계속 적용됩니다."
                : "미등록 서버의 허용목록 차단을 해제합니다. 명시적 차단 정책과 도구 위험 설정은 유지됩니다."}
            </p>
            <p>
              조회된 명시적 서버 정책: {command.before.policies.length}개. 미등록 서버 수와 호출량은 확인하지
              않습니다.
            </p>
          </>
        )}
        <ScopeNotice />
      </section>
    </ConfirmDialog>
  );
}
