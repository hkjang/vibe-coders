import { useState, type RefObject } from "react";
import { toast } from "sonner";

import { settingEditPermission } from "@/features/system/settings/settings-utils";
import { settingSaveOutcome } from "@/features/system/settings/setting-save-outcome";
import { routeId, systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";

export type SettingRecovery = { setting: EffectiveSetting } & (
  { kind: "revert" } | { kind: "rollback"; historyId: string; historyCount: number }
);

interface Props {
  hasAdminWrite: boolean;
  onClose: () => void;
  onReloadPending: (requestId?: string) => void;
  request: SettingRecovery | undefined;
  returnFocusRef: RefObject<HTMLElement | null>;
}

function RecoveryEditor({
  hasAdminWrite,
  onClose,
  onReloadPending,
  request,
  returnFocusRef,
}: Props & { request: SettingRecovery }): React.JSX.Element {
  const [snapshot] = useState(request);
  const [reason, setReason] = useState("");
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const { kind, setting } = snapshot;
  const permission = settingEditPermission(setting, hasAdminWrite);
  const allowed =
    permission.editable &&
    (kind === "revert"
      ? setting.source === "admin"
      : !setting.is_secret &&
        snapshot.historyId !== "" &&
        Number.isSafeInteger(snapshot.historyCount) &&
        snapshot.historyCount > 0);
  const guard = useDraftGuard({ dirty: reason !== "", onDiscard: onClose });
  const save = useMutationFeedback({
    mutate: async (note: string) => {
      if (!allowed) throw new Error("이 설정을 복구할 권한이 없습니다.");
      const api = endpoints.domains.system.settings;
      return settingSaveOutcome(async () => {
        if (kind === "rollback") {
          await apiClient.request(api.rollback, {
            body: {
              key: setting.key,
              reason: note,
              expected_version: setting.version ?? 0,
              expected_updated_at: setting.updated_at ?? "",
              expected_history_id: snapshot.historyId,
              expected_history_count: snapshot.historyCount,
            },
            routeId,
          });
        } else {
          await apiClient.request(
            { ...api.revert, path: pathWithParams(api.revert.path, { key: setting.key }) },
            {
              query: { reason: note, expected_version: setting.version ?? 0 },
              routeId,
            },
          );
        }
      });
    },
    invalidates: [systemSettingsKeys.effective, systemSettingsKeys.history(setting.key)],
    onSuccess: (result) => {
      if (result.outcome === "reload_pending") onReloadPending(result.requestId);
      else if (result.outcome === "saved")
        toast.success(
          kind === "rollback"
            ? "설정을 이전 값으로 롤백했습니다."
            : "설정을 환경변수 기본값으로 되돌렸습니다.",
        );
    },
  });

  const confirm = (): void => {
    if (!allowed || reason.trim() === "" || conflict) return;
    void guard.run(
      async () => {
        const result = await save.mutateAsync(reason.trim());
        if (result.outcome === "conflict") throw result.error;
      },
      (cause) => {
        if (isAppError(cause) && cause.status === 409) setConflict(true);
        setError({
          message: safeAppErrorMessage(cause, "설정을 복구하지 못했습니다."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) guard.requestClose();
      }}
      title={kind === "rollback" ? "이전 값으로 롤백" : "환경변수 기본값으로 되돌리기"}
      description={
        kind === "rollback"
          ? `${setting.key} 설정을 이력의 직전 값으로 되돌립니다.`
          : `${setting.key} 설정의 DB 오버라이드를 지우고 환경변수 값을 사용합니다.`
      }
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button variant="secondary" disabled={guard.pending} onClick={() => guard.requestClose()}>
            취소
          </Button>
          <Button
            variant="danger"
            disabled={!allowed || guard.pending || conflict || reason.trim() === ""}
            onClick={confirm}
          >
            {guard.pending ? "처리 중" : kind === "rollback" ? "롤백" : "되돌리기"}
          </Button>
        </>
      }
    >
      {!allowed ? (
        <InlineNotice tone="info">
          {permission.reason ?? "이 설정에는 요청한 복구 작업을 사용할 수 없습니다."}
        </InlineNotice>
      ) : null}
      {conflict ? (
        <InlineNotice tone="warning" title="다른 작업자가 설정을 변경했습니다.">
          입력한 사유를 확인한 뒤 대화상자를 닫고 설정을 다시 열어 최신 값과 이력을 검토하세요. 자동으로 다시
          요청하지 않습니다.
        </InlineNotice>
      ) : null}
      <fieldset
        className="form-grid form-dialog-fields"
        disabled={guard.pending || !allowed}
        aria-label="입력 항목"
      >
        <FormField label="변경 사유" required>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="감사 이력에 남길 사유를 입력하세요."
            />
          )}
        </FormField>
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error.message}
          {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
        </p>
      ) : null}
    </Dialog>
  );
}

export function SettingsRecoveryDialog(props: Props): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  const editor = props.request ? (
    <RecoveryEditor
      key={`${props.request.kind}:${props.request.setting.key}`}
      {...props}
      request={props.request}
    />
  ) : null;
  return coordinator ? <>{editor}</> : <UnsavedChangesProvider>{editor}</UnsavedChangesProvider>;
}
