import { useRef, useState } from "react";
import { Link } from "react-router";

import { QueryNotice } from "@/features/system/settings/SettingsParts";
import { SsoConfigForm, type SsoSaveInput } from "@/features/system/settings/SsoConfigForm";
import {
  routeId,
  systemSettingsKeys,
  useKeycloakConfig,
  useMcpOAuthStatus,
  useRoleCatalog,
} from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime } from "@/shared/utils/format";

const system = endpoints.domains.system;

/** Where the MCP SSO settings themselves live: the runtime tab, filtered to the mcp category. */
const mcpOAuthSettingsHref = "/system/settings?tab=runtime&category=mcp";

/** A value a person copies into Keycloak or an MCP client, with its copy button. */
function copyable(value: string | undefined): React.ReactNode {
  if (!value) return "—";
  return (
    <span className="settings-copyable">
      <code>{value}</code> <CopyButton value={value} />
    </span>
  );
}

export function SsoTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const config = useKeycloakConfig();
  const roles = useRoleCatalog(true);
  const saveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [draft, setDraft] = useState<SsoSaveInput | undefined>();

  const data = config.data;
  const roleOptions = (roles.data?.roles ?? []).map((role) => ({ value: role.role, label: role.role }));

  const save = useMutationFeedback({
    mutate: async (input: SsoSaveInput) =>
      apiClient.request(system.sso.save, {
        body: {
          enabled: input.enabled,
          issuer_url: input.issuerUrl,
          client_id: input.clientId,
          redirect_uri: input.redirectUri,
          scopes: input.scopes,
          default_role: input.defaultRole,
          role_claim: input.roleClaim,
          group_claim: input.groupClaim,
          allow_local_login: input.allowLocalLogin,
          auto_login: input.autoLogin,
          role_map: input.resetRoleMap ? {} : input.roleMap,
          // Omitted keeps the stored secret; "" clears it.
          ...(input.clearSecret
            ? { client_secret: "" }
            : input.clientSecret
              ? { client_secret: input.clientSecret }
              : {}),
          ...(data?.version === undefined ? {} : { expected_version: data.version }),
        },
        routeId,
      }),
    invalidates: [systemSettingsKeys.sso],
    successMessage: "SSO 설정을 저장했습니다.",
    errorMessage: "SSO 설정을 저장하지 못했습니다.",
  });

  const test = useMutationFeedback({
    mutate: async () => apiClient.request(system.sso.test, { routeId }),
    errorMessage: "Keycloak 연결을 확인하지 못했습니다.",
  });
  const testResult = test.data;
  const mcpOAuth = useMcpOAuthStatus();
  const oauth = mcpOAuth.data;

  return (
    <div className="settings-tab-stack">
      {config.isError ? (
        <QueryNotice
          error={config.error}
          hasPreviousData={Boolean(config.data)}
          label="SSO 설정"
          onRetry={() => void config.refetch()}
        />
      ) : null}
      {config.isPending ? <p role="status">SSO 설정을 불러오는 중입니다.</p> : null}

      {data ? (
        <KeyValueList
          columns={3}
          items={[
            { label: "적용 출처", value: data.source === "db" ? "관리자 화면(DB)" : "환경변수" },
            { label: "Client Secret", value: data.client_secret_set ? "설정됨 (표시하지 않음)" : "미설정" },
            { label: "마지막 변경", value: formatDateTime(data.updated_at) },
            { label: "변경자", value: data.updated_by ?? "—" },
            { label: "Role 매핑", value: data.role_map_custom ? "사용자 지정" : "기본값" },
            { label: "설정 버전", value: data.version ?? "—" },
          ]}
        />
      ) : null}

      <SectionCard
        title="Keycloak 설정"
        headingLevel={3}
        description="SSO 로그인에 사용할 발급자와 클라이언트 정보를 설정합니다."
        actions={
          <Button
            size="small"
            disabled={!hasAdminWrite || test.isPending}
            onClick={() => test.mutate(undefined)}
          >
            연결 테스트
          </Button>
        }
      >
        {data ? (
          <SsoConfigForm
            key={config.dataUpdatedAt}
            config={data}
            hasAdminWrite={hasAdminWrite}
            onRequestSave={setDraft}
            pending={save.isPending}
            roleOptions={roleOptions}
            saveTriggerRef={saveTriggerRef}
          />
        ) : null}
      </SectionCard>

      {testResult ? (
        <InlineNotice
          tone={testResult.ok ? "success" : "danger"}
          title={testResult.ok ? "Keycloak 연결 성공" : "Keycloak 연결 실패"}
        >
          {testResult.ok ? (
            <KeyValueList
              columns={2}
              items={[
                { label: "Issuer", value: testResult.issuer, mono: true },
                { label: "인가 엔드포인트", value: testResult.authorization_endpoint, mono: true },
                { label: "토큰 엔드포인트", value: testResult.token_endpoint, mono: true },
                { label: "JWKS", value: testResult.jwks_uri, mono: true },
                { label: "RSA 서명 키", value: testResult.rsa_signing_keys ?? "—" },
              ]}
            />
          ) : (
            <p>
              {testResult.stage ? `${testResult.stage} 단계: ` : ""}
              {testResult.reason ?? "원인을 확인할 수 없습니다."}
            </p>
          )}
        </InlineNotice>
      ) : null}

      <SectionCard
        title="MCP SSO(OAuth) 연결"
        headingLevel={3}
        description="개인 키 없이 Keycloak 액세스 토큰으로 /mcp 에 연결하는 문. 스위치·리소스 식별자·허용 대상·범위는 런타임 설정의 mcp 범주(mcp.oauth.*)에서 바꿉니다. 기본값은 꺼짐이고 키는 그대로 동작합니다."
        actions={
          <Link className="button button-secondary button-small" to={mcpOAuthSettingsHref}>
            MCP SSO 설정 열기
          </Link>
        }
      >
        {mcpOAuth.isError ? (
          <QueryNotice
            error={mcpOAuth.error}
            hasPreviousData={Boolean(oauth)}
            label="MCP SSO 상태"
            onRetry={() => void mcpOAuth.refetch()}
          />
        ) : null}
        {mcpOAuth.isPending ? <p role="status">MCP SSO 상태를 불러오는 중입니다.</p> : null}
        {oauth ? (
          <>
            <KeyValueList
              columns={2}
              items={[
                {
                  label: "SSO 토큰 허용",
                  value: oauth.active ? (
                    <Badge tone="success">켜짐</Badge>
                  ) : oauth.enabled ? (
                    <Badge tone="warning">켜졌지만 미완성</Badge>
                  ) : (
                    <Badge tone="muted">꺼짐</Badge>
                  ),
                },
                { label: "인증 서버(issuer)", value: oauth.issuer || "—", mono: true },
                {
                  label: `리소스 식별자 (/mcp)${oauth.resource_source === "derived" ? " · Redirect URI 에서 유도" : ""}`,
                  value: copyable(oauth.resource),
                },
                { label: "리소스 식별자 (/mcp/gateway)", value: copyable(oauth.gateway_resource) },
                { label: "메타데이터 주소", value: copyable(oauth.metadata_url) },
                {
                  label: "허용 대상 (aud/azp)",
                  value: oauth.audience?.length
                    ? oauth.audience.join(" ")
                    : "없음 — Audience 매퍼가 리소스 식별자를 넣어야 통과",
                  mono: true,
                },
                {
                  label: "SSO 주체의 범위",
                  value: oauth.scopes?.length ? oauth.scopes.join(" ") : "—",
                  mono: true,
                },
              ]}
            />
            {oauth.reason ? (
              <InlineNotice tone="warning" title="아직 SSO 토큰을 받지 않습니다.">
                <code>{oauth.reason}</code>
              </InlineNotice>
            ) : (
              <p className="settings-help">
                MCP 클라이언트에는 MCP 주소 하나만 주면 됩니다. 토큰이 없거나 거부되면 401 의{" "}
                <code>WWW-Authenticate</code> 가 메타데이터 주소를 가리키고, 클라이언트가 Keycloak 로그인 뒤
                토큰을 받아 옵니다. 웹으로 한 번 로그인한 계정만 통과합니다.
              </p>
            )}
          </>
        ) : null}
      </SectionCard>

      <ConfirmDialog
        open={draft !== undefined}
        onOpenChange={(next) => {
          if (!next) setDraft(undefined);
        }}
        title="SSO 설정 저장"
        description="저장하면 모든 파드에 즉시 반영되어 로그인 방식이 바뀝니다."
        confirmLabel="저장"
        tone="danger"
        returnFocusRef={saveTriggerRef}
        onConfirm={async () => {
          if (!draft) return;
          await save.mutateAsync(draft);
        }}
      >
        {draft ? (
          <p>
            SSO {draft.enabled ? "사용" : "미사용"} · 로컬 로그인 {draft.allowLocalLogin ? "허용" : "차단"} ·
            자동 로그인 {draft.autoLogin ? "켬" : "끔"}
            {draft.resetRoleMap ? " · Role 매핑 기본값으로 초기화" : ""}
            {draft.clearSecret
              ? " · 저장된 Client Secret 삭제"
              : draft.clientSecret
                ? " · Client Secret 교체"
                : ""}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
