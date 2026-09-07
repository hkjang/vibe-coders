import { Plus, Trash2 } from "lucide-react";
import { useState, type RefObject } from "react";

import type { KeycloakConfig } from "@/shared/api/domains/system.schemas";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";

export interface SsoSaveInput {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  clearSecret: boolean;
  redirectUri: string;
  scopes: string[];
  defaultRole: string;
  roleClaim: string;
  groupClaim: string;
  allowLocalLogin: boolean;
  roleMap: Record<string, string>;
  resetRoleMap: boolean;
}

interface RoleMapRow {
  id: number;
  keycloakRole: string;
  internalRole: string;
}

interface SsoConfigFormProps {
  config: KeycloakConfig;
  hasAdminWrite: boolean;
  onRequestSave: (input: SsoSaveInput) => void;
  pending: boolean;
  roleOptions: ReadonlyArray<{ value: string; label: string }>;
  saveTriggerRef: RefObject<HTMLButtonElement | null>;
}

let rowSequence = 0;
function nextRowId(): number {
  rowSequence += 1;
  return rowSequence;
}

/**
 * Mounted with a key derived from the loaded config so a refetch reseeds the form
 * rather than syncing state in an effect. The client secret is input-only.
 */
export function SsoConfigForm({
  config,
  hasAdminWrite,
  onRequestSave,
  pending,
  roleOptions,
  saveTriggerRef,
}: SsoConfigFormProps): React.JSX.Element {
  const [enabled, setEnabled] = useState(config.enabled);
  const [issuerUrl, setIssuerUrl] = useState(config.issuer_url ?? "");
  const [clientId, setClientId] = useState(config.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [redirectUri, setRedirectUri] = useState(config.redirect_uri ?? "");
  const [scopes, setScopes] = useState((config.scopes ?? []).join(","));
  const [defaultRole, setDefaultRole] = useState(config.default_role ?? "");
  const [roleClaim, setRoleClaim] = useState(config.role_claim ?? "");
  const [groupClaim, setGroupClaim] = useState(config.group_claim ?? "");
  const [allowLocalLogin, setAllowLocalLogin] = useState(config.allow_local_login !== false);
  const [roleMap, setRoleMap] = useState<RoleMapRow[]>(() =>
    Object.entries(config.role_map ?? {}).map(([keycloakRole, internalRole]) => ({
      id: nextRowId(),
      keycloakRole,
      internalRole,
    })),
  );

  const buildInput = (resetRoleMap: boolean): SsoSaveInput => {
    const map: Record<string, string> = {};
    for (const row of roleMap) {
      const key = row.keycloakRole.trim();
      const value = row.internalRole.trim();
      if (key && value) map[key] = value;
    }
    return {
      enabled,
      issuerUrl: issuerUrl.trim(),
      clientId: clientId.trim(),
      clientSecret,
      clearSecret,
      redirectUri: redirectUri.trim(),
      scopes: scopes
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
      defaultRole: defaultRole.trim(),
      roleClaim: roleClaim.trim(),
      groupClaim: groupClaim.trim(),
      allowLocalLogin,
      roleMap: map,
      resetRoleMap,
    };
  };

  return (
    <form
      className="form-grid"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onRequestSave(buildInput(false));
      }}
    >
      <div className="settings-badge-row">
        <Switch checked={enabled} disabled={!hasAdminWrite} label="SSO 사용" onCheckedChange={setEnabled} />
        <Switch
          checked={allowLocalLogin}
          disabled={!hasAdminWrite}
          label="로컬 로그인 허용"
          onCheckedChange={setAllowLocalLogin}
        />
        {enabled ? <Badge tone="success">활성</Badge> : <Badge tone="muted">비활성</Badge>}
      </div>

      {allowLocalLogin ? null : (
        <InlineNotice tone="warning" title="로컬 로그인을 끄면 Keycloak으로만 로그인할 수 있습니다.">
          Keycloak 연결이 끊기면 관리자도 로그인할 수 없습니다. 연결 테스트가 성공한 뒤에 끄세요.
        </InlineNotice>
      )}

      <FormField label="Issuer URL" description="예: https://keycloak.example.com/realms/main">
        {(control) => (
          <Input
            {...control}
            value={issuerUrl}
            disabled={!hasAdminWrite}
            onChange={(event) => setIssuerUrl(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Client ID">
        {(control) => (
          <Input
            {...control}
            value={clientId}
            disabled={!hasAdminWrite}
            onChange={(event) => setClientId(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Client Secret"
        description="입력 전용입니다. 저장된 값은 표시되지 않으며, 비워 두면 기존 값을 유지합니다."
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            disabled={!hasAdminWrite || clearSecret}
            placeholder="새 Client Secret을 입력하면 교체됩니다"
            onChange={(event) => setClientSecret(event.target.value)}
          />
        )}
      </FormField>
      <Checkbox
        label="저장된 Client Secret 지우기"
        checked={clearSecret}
        disabled={!hasAdminWrite}
        onChange={(event) => {
          setClearSecret(event.target.checked);
          if (event.target.checked) setClientSecret("");
        }}
      />
      <FormField label="Redirect URI">
        {(control) => (
          <Input
            {...control}
            value={redirectUri}
            disabled={!hasAdminWrite}
            onChange={(event) => setRedirectUri(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Scopes" description="쉼표로 구분합니다. 예: openid,profile,email">
        {(control) => (
          <Input
            {...control}
            value={scopes}
            disabled={!hasAdminWrite}
            onChange={(event) => setScopes(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="기본 역할" description="매핑되지 않은 사용자에게 부여할 역할입니다.">
        {(control) => (
          <Select
            {...control}
            value={defaultRole}
            disabled={!hasAdminWrite}
            onChange={(event) => setDefaultRole(event.target.value)}
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
      <FormField label="Role Claim">
        {(control) => (
          <Input
            {...control}
            value={roleClaim}
            disabled={!hasAdminWrite}
            onChange={(event) => setRoleClaim(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Group Claim">
        {(control) => (
          <Input
            {...control}
            value={groupClaim}
            disabled={!hasAdminWrite}
            onChange={(event) => setGroupClaim(event.target.value)}
          />
        )}
      </FormField>

      <fieldset className="settings-fieldset">
        <legend>Role 매핑 (Keycloak 역할 → 내부 역할)</legend>
        <table className="data-table">
          <caption className="sr-only">Keycloak 역할 매핑</caption>
          <thead>
            <tr>
              <th scope="col">Keycloak 역할</th>
              <th scope="col">내부 역할</th>
              <th scope="col">작업</th>
            </tr>
          </thead>
          <tbody>
            {roleMap.length === 0 ? (
              <tr>
                <td colSpan={3} className="data-table-state">
                  매핑이 없습니다. 행을 추가하면 Keycloak 역할을 내부 역할로 연결할 수 있습니다.
                </td>
              </tr>
            ) : (
              roleMap.map((row, index) => (
                <tr key={row.id}>
                  <td>
                    <Input
                      aria-label={`${index + 1}번 Keycloak 역할`}
                      value={row.keycloakRole}
                      disabled={!hasAdminWrite}
                      onChange={(event) =>
                        setRoleMap((current) =>
                          current.map((item) =>
                            item.id === row.id ? { ...item, keycloakRole: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <Select
                      aria-label={`${index + 1}번 내부 역할`}
                      value={row.internalRole}
                      disabled={!hasAdminWrite}
                      onChange={(event) =>
                        setRoleMap((current) =>
                          current.map((item) =>
                            item.id === row.id ? { ...item, internalRole: event.target.value } : item,
                          ),
                        )
                      }
                    >
                      <option value="">선택 안 함</option>
                      {roleOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Button
                      size="small"
                      variant="ghost"
                      aria-label={`${row.keycloakRole || `${index + 1}번`} 매핑 삭제`}
                      disabled={!hasAdminWrite}
                      onClick={() => setRoleMap((current) => current.filter((item) => item.id !== row.id))}
                    >
                      <Trash2 aria-hidden="true" /> 삭제
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="settings-form-actions">
          <Button
            size="small"
            disabled={!hasAdminWrite}
            onClick={() =>
              setRoleMap((current) => [...current, { id: nextRowId(), keycloakRole: "", internalRole: "" }])
            }
          >
            <Plus aria-hidden="true" /> 행 추가
          </Button>
          <Button
            size="small"
            disabled={!hasAdminWrite || pending}
            onClick={() => onRequestSave(buildInput(true))}
          >
            매핑을 기본값으로 초기화
          </Button>
        </div>
      </fieldset>

      <div className="settings-form-actions">
        <Button ref={saveTriggerRef} type="submit" variant="primary" disabled={!hasAdminWrite || pending}>
          {pending ? "저장 중" : "SSO 설정 저장"}
        </Button>
        {hasAdminWrite ? null : <p className="settings-permission-note">admin:write 권한이 필요합니다.</p>}
      </div>
    </form>
  );
}
