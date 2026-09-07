import { useId, useState, type RefObject } from "react";

import { QueryNotice } from "@/features/system/settings/SettingsParts";
import {
  isBooleanSetting,
  normalizedBoolean,
  settingDisplayValue,
  settingEditPermission,
  settingSourceLabel,
} from "@/features/system/settings/settings-utils";
import { useSettingHistory } from "@/features/system/settings/use-system-settings";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";

export interface SettingSaveInput {
  setting: EffectiveSetting;
  value: string;
  reason: string;
}

interface SettingEditorProps {
  formId: string;
  hasAdminWrite: boolean;
  onRequestRevert: (setting: EffectiveSetting) => void;
  onRequestRollback: (setting: EffectiveSetting) => void;
  onSave: (input: SettingSaveInput) => Promise<unknown>;
  onSaved: () => void;
  setting: EffectiveSetting;
}

/**
 * Editor body for one setting. Mounted with `key={setting.key}` so switching rows
 * resets the draft value instead of carrying it across settings.
 */
function SettingEditor({
  formId,
  hasAdminWrite,
  onRequestRevert,
  onRequestRollback,
  onSave,
  onSaved,
  setting,
}: SettingEditorProps): React.JSX.Element {
  // A secret is never echoed back, so its editor always starts empty.
  const [value, setValue] = useState(setting.is_secret ? "" : setting.value);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();
  const history = useSettingHistory(setting.key, true);
  const permission = settingEditPermission(setting, hasAdminWrite);
  const historyRows = history.data?.history ?? [];

  const submit = async (): Promise<void> => {
    if (!permission.editable) return;
    setError(undefined);
    try {
      await onSave({ setting, value, reason: reason.trim() });
      onSaved();
    } catch (cause) {
      setError({
        message: safeAppErrorMessage(cause, "설정을 저장하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    }
  };

  return (
    <div className="settings-sheet-stack">
      <KeyValueList
        columns={2}
        items={[
          { label: "범주", value: setting.category, mono: true },
          { label: "유형", value: setting.type },
          { label: "현재 값", value: settingDisplayValue(setting), mono: !setting.is_secret },
          { label: "적용 출처", value: settingSourceLabel(setting.source) },
          { label: "권한 그룹", value: setting.permission_group ?? "—" },
          { label: "마지막 변경", value: formatDateTime(setting.updated_at) },
          { label: "변경자", value: setting.updated_by ?? "—" },
          { label: "버전", value: setting.version ?? "—" },
        ]}
      />

      <div className="settings-badge-row">
        {setting.restart_required ? <Badge tone="warning">재시작 필요</Badge> : null}
        {setting.read_only ? <Badge tone="muted">읽기 전용</Badge> : null}
        {setting.is_secret ? <Badge tone="info">비밀값</Badge> : null}
      </div>

      {setting.value_error ? (
        <InlineNotice tone="danger" title="저장된 비밀값을 사용할 수 없습니다.">
          {setting.value_error}
        </InlineNotice>
      ) : null}

      {permission.reason ? (
        <InlineNotice tone="info" title="이 설정은 변경할 수 없습니다.">
          {permission.reason}
        </InlineNotice>
      ) : null}

      {setting.is_secret ? (
        <InlineNotice tone="info" title="비밀값은 표시하지 않습니다.">
          새 값을 입력해 교체할 수 있고, 저장된 값은 화면과 로그 어디에도 표시되지 않습니다.
        </InlineNotice>
      ) : null}

      <form
        id={formId}
        className="form-grid"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {isBooleanSetting(setting) ? (
          <FormField label="새 값" description="true 또는 false를 선택하세요.">
            {(control) => (
              <Select
                {...control}
                value={normalizedBoolean(value)}
                disabled={!permission.editable}
                onChange={(event) => setValue(event.target.value)}
                options={[
                  { value: "true", label: "true (사용)" },
                  { value: "false", label: "false (사용 안 함)" },
                ]}
              />
            )}
          </FormField>
        ) : setting.is_secret ? (
          <FormField label="새 비밀값" description="입력 전용입니다. 저장 후에는 다시 볼 수 없습니다.">
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="new-password"
                value={value}
                disabled={!permission.editable}
                placeholder="새 값을 입력하면 교체됩니다"
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </FormField>
        ) : setting.type === "csv" ? (
          <FormField label="새 값" description="쉼표로 구분해 입력하세요.">
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={value}
                disabled={!permission.editable}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </FormField>
        ) : (
          <FormField label="새 값">
            {(control) => (
              <Input
                {...control}
                value={value}
                disabled={!permission.editable}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </FormField>
        )}

        <FormField label="변경 사유" description="감사 이력에 함께 기록됩니다.">
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={reason}
              disabled={!permission.editable}
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

      <div className="settings-danger-actions">
        <Button
          variant="secondary"
          disabled={!permission.editable || setting.source !== "admin"}
          onClick={() => onRequestRevert(setting)}
        >
          기본값(환경변수)으로 되돌리기
        </Button>
        <Button
          variant="secondary"
          disabled={!permission.editable || setting.is_secret}
          onClick={() => onRequestRollback(setting)}
        >
          이전 값으로 롤백
        </Button>
      </div>
      {setting.is_secret ? (
        <p className="settings-permission-note">
          비밀값은 이력에 값을 남기지 않으므로 롤백할 수 없습니다. 새 값을 저장하거나 기본값으로 되돌리세요.
        </p>
      ) : null}

      <section aria-labelledby="setting-history-heading" className="settings-history">
        <h3 id="setting-history-heading">변경 이력</h3>
        {history.isError ? (
          <QueryNotice
            error={history.error}
            hasPreviousData={Boolean(history.data)}
            label="설정 변경 이력"
            onRetry={() => void history.refetch()}
          />
        ) : null}
        {history.isPending ? <p role="status">변경 이력을 불러오는 중입니다.</p> : null}
        {!history.isPending && historyRows.length === 0 ? (
          <p>아직 변경 이력이 없습니다. 값을 저장하면 이곳에 기록됩니다.</p>
        ) : null}
        {historyRows.length > 0 ? (
          <table className="data-table">
            <caption className="sr-only">{setting.key} 변경 이력</caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">변경자</th>
                <th scope="col">이전 값</th>
                <th scope="col">새 값</th>
                <th scope="col">사유</th>
              </tr>
            </thead>
            <tbody>
              {historyRows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.changed_at)}</td>
                  <td>{row.changed_by || "—"}</td>
                  <td className="mono truncate">
                    {row.is_secret ? "표시하지 않음" : (row.old_value_json ?? "—")}
                  </td>
                  <td className="mono truncate">
                    {row.is_secret ? "표시하지 않음" : (row.new_value_json ?? "—")}
                  </td>
                  <td>{row.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </div>
  );
}

interface SettingDetailSheetProps {
  hasAdminWrite: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestRevert: (setting: EffectiveSetting) => void;
  onRequestRollback: (setting: EffectiveSetting) => void;
  onSave: (input: SettingSaveInput) => Promise<unknown>;
  open: boolean;
  pending: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  setting: EffectiveSetting | undefined;
}

export function SettingDetailSheet({
  hasAdminWrite,
  onOpenChange,
  onRequestRevert,
  onRequestRollback,
  onSave,
  open,
  pending,
  returnFocusRef,
  setting,
}: SettingDetailSheetProps): React.JSX.Element {
  const formId = useId();
  const permission = setting
    ? settingEditPermission(setting, hasAdminWrite)
    : { editable: false, reason: undefined };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={setting?.key ?? "설정"}
      description={setting?.description || "런타임 설정 값을 확인하고 변경합니다."}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            닫기
          </Button>
          <Button form={formId} type="submit" variant="primary" disabled={!permission.editable || pending}>
            {pending ? "저장 중" : "저장"}
          </Button>
        </>
      }
    >
      {setting ? (
        <SettingEditor
          key={setting.key}
          formId={formId}
          hasAdminWrite={hasAdminWrite}
          onRequestRevert={onRequestRevert}
          onRequestRollback={onRequestRollback}
          onSave={onSave}
          onSaved={() => onOpenChange(false)}
          setting={setting}
        />
      ) : null}
    </Sheet>
  );
}
