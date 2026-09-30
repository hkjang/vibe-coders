import { useRef } from "react";

import { useSsoDraft } from "@/features/system/settings/use-sso-draft";
import { SsoRoleMapEditor } from "@/features/system/settings/SsoRoleMapEditor";
import type { KeycloakConfig } from "@/shared/api/domains/system.schemas";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

interface SsoConfigFormProps {
  config: KeycloakConfig;
  hasAdminWrite: boolean;
  roleOptions: ReadonlyArray<{ value: string; label: string }>;
}

export function SsoConfigForm(props: SsoConfigFormProps): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <SsoEditor {...props} />
  ) : (
    <UnsavedChangesProvider>
      <SsoEditor {...props} />
    </UnsavedChangesProvider>
  );
}

function SsoEditor({ config, hasAdminWrite, roleOptions }: SsoConfigFormProps): React.JSX.Element {
  const editor = useSsoDraft(config, hasAdminWrite);
  const saveTriggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement>(null);
  const { draft, update, guard } = editor;
  const disabled = !hasAdminWrite || guard.pending || editor.locked;
  const textFields = [
    ["issuerUrl", "발급자 주소 (Issuer URL)"],
    ["clientId", "클라이언트 ID"],
    ["redirectUri", "리디렉션 주소 (Redirect URI)"],
    ["scopes", "권한 범위 (Scopes)"],
    ["roleClaim", "역할 클레임 (Role Claim)"],
    ["groupClaim", "그룹 클레임 (Group Claim)"],
  ] as const;
  return (
    <>
      <form
        className="form-grid"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          returnFocusRef.current = (event.nativeEvent as SubmitEvent).submitter ?? saveTriggerRef.current;
          editor.requestSave();
        }}
      >
        {editor.serverChanged ? (
          <InlineNotice tone="warning" title="서버의 SSO 설정이 변경되었습니다.">
            편집 중인 값과 검토한 설정 버전을 유지합니다. 변경 취소 후 최신 설정을 다시 검토하세요.
          </InlineNotice>
        ) : null}
        {editor.notice ? (
          <InlineNotice tone="warning" title="저장 상태 확인">
            {editor.notice}
          </InlineNotice>
        ) : null}
        <fieldset
          className="form-grid form-dialog-fields"
          aria-label="SSO 입력 항목"
          disabled={disabled || editor.confirmation !== undefined}
        >
          <div className="settings-badge-row">
            <Switch
              checked={draft.enabled}
              label="SSO 사용"
              onCheckedChange={(value) => update("enabled", value)}
            />
            <Switch
              checked={draft.allowLocalLogin}
              label="로컬 로그인 허용"
              onCheckedChange={(value) => update("allowLocalLogin", value)}
            />
            <Switch
              checked={draft.autoLogin}
              label="자동 로그인"
              onCheckedChange={(value) => update("autoLogin", value)}
            />
            <Badge tone={draft.enabled ? "success" : "muted"}>{draft.enabled ? "활성" : "비활성"}</Badge>
          </div>
          {!draft.allowLocalLogin ? (
            <InlineNotice tone="warning" title="로컬 로그인을 끄면 Keycloak으로만 로그인할 수 있습니다.">
              Keycloak 연결이 끊기면 관리자도 로그인할 수 없습니다. 이 파드에 적용된 설정으로 연결 테스트를
              확인하세요.
            </InlineNotice>
          ) : null}
          {draft.autoLogin ? (
            <InlineNotice
              tone="info"
              title="자동 로그인은 Keycloak 세션이 살아 있는 사용자를 로그인 화면 없이 들여보냅니다."
            >
              콘솔이 탭마다 한 번만 prompt=none 으로 조용히 시도하고, 세션이 없으면 평소처럼 로그인 화면을
              보여 줍니다. 로그아웃한 사용자는 다시 로그인하기 전까지 자동으로 들어오지 않습니다.
            </InlineNotice>
          ) : null}
          {textFields.map(([key, label]) => (
            <FormField
              key={key}
              label={label}
              description={
                key === "scopes"
                  ? "쉼표로 구분합니다. 예: openid,profile,email"
                  : key === "issuerUrl"
                    ? "예: https://keycloak.example.com/realms/main"
                    : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  value={draft[key]}
                  onChange={(event) => update(key, event.target.value)}
                />
              )}
            </FormField>
          ))}
          <FormField
            label="클라이언트 비밀키"
            description="입력 전용입니다. 비워 두면 저장된 값을 유지합니다."
          >
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="new-password"
                value={draft.clientSecret}
                disabled={draft.clearSecret}
                placeholder="새 비밀키를 입력하면 교체됩니다"
                onChange={(event) => update("clientSecret", event.target.value)}
              />
            )}
          </FormField>
          <Checkbox
            label="저장된 클라이언트 비밀키 지우기"
            checked={draft.clearSecret}
            onChange={(event) => {
              update("clearSecret", event.target.checked);
              if (event.target.checked) update("clientSecret", "");
            }}
          />
          <FormField label="기본 역할" description="매핑되지 않은 사용자에게 부여할 역할입니다.">
            {(control) => (
              <Select
                {...control}
                value={draft.defaultRole}
                onChange={(event) => update("defaultRole", event.target.value)}
              >
                <option value="">선택 안 함</option>
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <SsoRoleMapEditor
            rows={draft.roleMap}
            roleOptions={roleOptions}
            onChange={(rows) => update("roleMap", rows)}
            onReset={(trigger) => {
              returnFocusRef.current = trigger;
              editor.requestSave(true);
            }}
          />
        </fieldset>
        {editor.error && !editor.confirmation ? (
          <p className="form-error" role="alert">
            {editor.error}
          </p>
        ) : null}
        <div className="settings-form-actions">
          <Button
            ref={saveTriggerRef}
            type="submit"
            variant="primary"
            disabled={disabled || editor.sameSnapshotSaved}
          >
            {guard.pending ? "저장 중" : "SSO 설정 저장"}
          </Button>
          <Button disabled={!hasAdminWrite || guard.pending} onClick={editor.reload}>
            {editor.locked ? "최신 설정 다시 불러오기" : "변경 취소"}
          </Button>
          {!hasAdminWrite ? <p className="settings-permission-note">admin:write 권한이 필요합니다.</p> : null}
        </div>
      </form>
      <Dialog
        open={editor.confirmation !== undefined}
        title="SSO 설정 저장"
        description="저장하면 로그인 방식이 바뀝니다. 다른 파드에는 재적재 주기에 따라 반영됩니다."
        returnFocusRef={returnFocusRef}
        onOpenChange={(open) => {
          if (!open && !guard.pending) editor.setConfirmation(undefined);
        }}
        footer={
          <>
            <Button disabled={guard.pending} onClick={() => editor.setConfirmation(undefined)}>
              취소
            </Button>
            <Button
              variant="danger"
              disabled={guard.pending || editor.locked}
              onClick={() => void editor.save()}
            >
              {guard.pending ? "처리 중" : "저장"}
            </Button>
          </>
        }
      >
        <p>
          SSO {draft.enabled ? "사용" : "미사용"} · 로컬 로그인 {draft.allowLocalLogin ? "허용" : "차단"} ·
          자동 로그인 {draft.autoLogin ? "켬" : "끔"}
          {editor.confirmation?.resetRoleMap ? " · 역할 매핑 기본값으로 초기화" : ""}
          {draft.clearSecret
            ? " · 저장된 클라이언트 비밀키 삭제"
            : draft.clientSecret
              ? " · 클라이언트 비밀키 교체"
              : ""}
        </p>
        {editor.error ? (
          <p className="form-error" role="alert">
            {editor.error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
