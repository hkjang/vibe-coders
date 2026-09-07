import { useId, useState, type RefObject } from "react";

import type { ConsoleFeatureRow } from "@/features/system/settings/settings-utils";
import { consoleStatusOptions, normalizedBoolean } from "@/features/system/settings/settings-utils";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export interface ConsoleFeatureEdit {
  status?: string;
  roles?: string;
  rollout?: string;
  readonly?: string;
}

export interface ConsoleFeatureSubmit {
  row: ConsoleFeatureRow;
  changes: ConsoleFeatureEdit;
  reason: string;
}

interface ConsoleFeatureFormProps {
  editable: boolean;
  formId: string;
  onSaved: () => void;
  onSubmit: (input: ConsoleFeatureSubmit) => Promise<unknown>;
  row: ConsoleFeatureRow;
}

/** Mounted with `key={row.featureId}` so each feature opens with its own values. */
function ConsoleFeatureForm({
  editable,
  formId,
  onSaved,
  onSubmit,
  row,
}: ConsoleFeatureFormProps): React.JSX.Element {
  const [status, setStatus] = useState(row.status?.value ?? "");
  const [roles, setRoles] = useState(row.roles?.value ?? "");
  const [rollout, setRollout] = useState(row.rollout?.value ?? "");
  const [readOnly, setReadOnly] = useState<string>(normalizedBoolean(row.readonly?.value ?? "false"));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();

  const submit = async (): Promise<void> => {
    if (!editable) return;
    const changes: ConsoleFeatureEdit = {};
    if (row.status && status !== row.status.value) changes.status = status;
    if (row.roles && roles.trim() !== row.roles.value) changes.roles = roles.trim();
    if (row.rollout && rollout.trim() !== row.rollout.value) changes.rollout = rollout.trim();
    if (row.readonly && readOnly !== normalizedBoolean(row.readonly.value)) changes.readonly = readOnly;
    if (Object.keys(changes).length === 0) {
      setError({ message: "변경된 값이 없습니다." });
      return;
    }
    setError(undefined);
    try {
      await onSubmit({ row, changes, reason: reason.trim() });
      onSaved();
    } catch (cause) {
      setError({
        message: safeAppErrorMessage(cause, "전환 설정을 저장하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    }
  };

  return (
    <form
      id={formId}
      className="form-grid"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <FormField label="전환 상태" description="기존 화면 유지, 미리보기, 정식 전환 중 선택합니다.">
        {(control) => (
          <Select
            {...control}
            value={status}
            disabled={!editable || !row.status}
            onChange={(event) => setStatus(event.target.value)}
            options={consoleStatusOptions.map((option) => ({ ...option }))}
          />
        )}
      </FormField>

      <FormField
        label="미리보기 역할"
        description="쉼표로 구분한 역할 목록입니다. 비우면 어떤 역할도 미리보기 대상이 되지 않습니다."
      >
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={roles}
            disabled={!editable || !row.roles}
            placeholder="super_admin,admin"
            onChange={(event) => setRoles(event.target.value)}
          />
        )}
      </FormField>

      <FormField label="점진 배포 비율(%)" description="0~100 사이의 정수입니다.">
        {(control) => (
          <Input
            {...control}
            type="number"
            min={0}
            max={100}
            value={rollout}
            disabled={!editable || !row.rollout}
            onChange={(event) => setRollout(event.target.value)}
          />
        )}
      </FormField>

      <FormField label="읽기 전용 강제">
        {(control) => (
          <Select
            {...control}
            value={readOnly}
            disabled={!editable || !row.readonly}
            onChange={(event) => setReadOnly(event.target.value)}
            options={[
              { value: "true", label: "true (쓰기 차단)" },
              { value: "false", label: "false (쓰기 허용)" },
            ]}
          />
        )}
      </FormField>

      <FormField label="변경 사유" description="감사 이력에 함께 기록됩니다.">
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={reason}
            disabled={!editable}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </FormField>

      {error ? (
        <p className="form-error" role="alert">
          {error.message}
          {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
        </p>
      ) : null}
    </form>
  );
}

interface ConsoleFeatureDialogProps {
  disabledReason: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ConsoleFeatureSubmit) => Promise<unknown>;
  open: boolean;
  pending: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  row: ConsoleFeatureRow | undefined;
  title: string;
}

/** Per-feature `/app` rollout editor: status, preview roles, rollout percent, read-only. */
export function ConsoleFeatureDialog({
  disabledReason,
  onOpenChange,
  onSubmit,
  open,
  pending,
  returnFocusRef,
  row,
  title,
}: ConsoleFeatureDialogProps): React.JSX.Element {
  const formId = useId();
  const editable = disabledReason === undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={title}
      description="이 기능의 신규 콘솔 전환 상태를 조정합니다."
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            취소
          </Button>
          <Button form={formId} type="submit" variant="primary" disabled={!editable || pending}>
            {pending ? "저장 중" : "저장"}
          </Button>
        </>
      }
    >
      {disabledReason ? (
        <InlineNotice tone="info" title="변경할 수 없습니다.">
          {disabledReason}
        </InlineNotice>
      ) : null}

      <InlineNotice tone="warning" title="변경 후 새로고침이 필요합니다.">
        전환 상태는 브라우저가 시작할 때 한 번 읽습니다. 저장한 뒤 화면을 새로고침해야 새 상태가 적용됩니다.
      </InlineNotice>

      {row ? (
        <ConsoleFeatureForm
          key={row.featureId}
          editable={editable}
          formId={formId}
          onSaved={() => onOpenChange(false)}
          onSubmit={onSubmit}
          row={row}
        />
      ) : null}
    </Dialog>
  );
}
