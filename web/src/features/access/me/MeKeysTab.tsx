import { useRef, useState } from "react";
import { z } from "zod";

import { severityTone, statusLabel, statusTone } from "@/features/access/access-format";
import { QueryNotice, ScopeBadges, UpdatedAt } from "@/features/access/access-ui";
import {
  meKeys,
  useMeKeysQuery,
  useMeOnboardingPackQuery,
  useMeSessionsQuery,
} from "@/features/access/me/use-me-queries";
import { apiClient } from "@/shared/api/client";
import type {
  ConnectionDoctorBody,
  CreateMeKeyBody,
  UpdateMeKeyScopesBody,
} from "@/shared/api/domains/access";
import type { ApiKeyPublic, MeSession } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "me.home";

const doctorClients = [
  { value: "openai-sdk", label: "OpenAI SDK" },
  { value: "cursor", label: "Cursor (MCP)" },
  { value: "roo", label: "Roo (MCP)" },
  { value: "cline", label: "Cline (MCP)" },
  { value: "claude-desktop-mcp", label: "Claude Desktop (MCP)" },
  { value: "claude", label: "Claude (MCP)" },
  { value: "mcp", label: "MCP 일반" },
] as const;

const keyFormSchema = z.object({
  name: z.string().min(1, "키 이름을 입력하세요."),
  expires_at: z.string(),
});
type KeyForm = z.infer<typeof keyFormSchema>;

function daysUntil(value: string): number | undefined {
  if (!value) return undefined;
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return undefined;
  return Math.ceil((at - Date.now()) / 86_400_000);
}

export function MeKeysTab(): React.JSX.Element {
  const keys = useMeKeysQuery(true);
  const sessions = useMeSessionsQuery(true);
  const [doctorClient, setDoctorClient] = useState("openai-sdk");
  const [packClient, setPackClient] = useState("openai-sdk");
  const [packRequested, setPackRequested] = useState(false);
  const pack = useMeOnboardingPackQuery(packClient, packRequested);
  const [createOpen, setCreateOpen] = useState(false);
  const [createScopes, setCreateScopes] = useState<readonly string[]>([]);
  const [issuedSecret, setIssuedSecret] = useState("");
  const [secretTitle, setSecretTitle] = useState("발급된 비밀값");
  const [scopeEditing, setScopeEditing] = useState<ApiKeyPublic | undefined>();
  const [scopeDraft, setScopeDraft] = useState<readonly string[]>([]);
  const [rotating, setRotating] = useState<ApiKeyPublic | undefined>();
  const [revoking, setRevoking] = useState<ApiKeyPublic | undefined>();
  const [revokingSession, setRevokingSession] = useState<MeSession | undefined>();
  const [revokingOthers, setRevokingOthers] = useState(false);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const rowTrigger = useRef<HTMLElement>(null);
  const othersTrigger = useRef<HTMLButtonElement>(null);

  const form = useZodForm<KeyForm, KeyForm>(keyFormSchema, { name: "", expires_at: "" });

  const createKey = useMutationFeedback({
    mutate: (body: CreateMeKeyBody) => apiClient.request(access.me.createKey, { body, routeId }),
    invalidates: [meKeys.keys],
    successMessage: "키를 발급했습니다.",
    onSuccess: (result) => {
      setSecretTitle("발급된 비밀값");
      setIssuedSecret(result.secret);
    },
  });
  const updateScopes = useMutationFeedback({
    mutate: ({ id, body }: { id: string; body: UpdateMeKeyScopesBody }) =>
      apiClient.request(withPathParams(access.me.updateKeyScopes, { id }), { body, routeId }),
    invalidates: [meKeys.keys],
    successMessage: "키 스코프를 수정했습니다.",
  });
  const rotateKey = useMutationFeedback({
    mutate: (id: string) => apiClient.request(withPathParams(access.me.rotateKey, { id }), { routeId }),
    invalidates: [meKeys.keys],
    successMessage: "키를 회전했습니다. 새 비밀값을 저장하세요.",
    onSuccess: (result) => {
      setSecretTitle("회전된 비밀값");
      setIssuedSecret(result.secret);
    },
  });
  const revokeKey = useMutationFeedback({
    mutate: (id: string) => apiClient.request(withPathParams(access.me.revokeKey, { id }), { routeId }),
    invalidates: [meKeys.keys],
    successMessage: "키를 폐기했습니다.",
  });
  const revokeSession = useMutationFeedback({
    mutate: (id: string) => apiClient.request(withPathParams(access.me.revokeSession, { id }), { routeId }),
    invalidates: [meKeys.sessions],
    successMessage: "세션을 종료했습니다.",
  });
  const revokeOthers = useMutationFeedback({
    mutate: () => apiClient.request(access.me.revokeOtherSessions, { routeId }),
    invalidates: [meKeys.sessions],
    successMessage: (result) => `다른 세션 ${formatNumber(result.revoked_count)}개를 종료했습니다.`,
  });
  const doctor = useMutationFeedback({
    mutate: (body: ConnectionDoctorBody) => apiClient.request(access.me.connectionDoctor, { body, routeId }),
    successMessage: "연결 진단을 마쳤습니다.",
  });

  const selfServiceDisabled = keys.isError && isAppError(keys.error) && keys.error.status === 404;

  if (keys.isPending && !keys.data && !selfServiceDisabled) {
    return <LoadingState label="내 키를 불러오는 중입니다." />;
  }

  const keyRows = keys.data?.api_keys ?? [];
  const grantable = keys.data?.grantable_scopes ?? [];
  const sessionRows = sessions.data?.sessions ?? [];
  const expiringSoon = keyRows.filter((row) => {
    const days = daysUntil(row.expires_at);
    return days !== undefined && days >= 0 && days <= 30;
  }).length;

  return (
    <div className="access-stack">
      {selfServiceDisabled ? (
        <InlineNotice tone="warning" title="셀프 서비스 키 발급이 꺼져 있습니다.">
          서버 설정 <span className="mono">SELF_SERVICE_KEYS_ENABLED=true</span> 로 기능을 켜야 이 화면에서
          키를 발급하고 폐기할 수 있습니다. 운영자에게 요청하세요.
        </InlineNotice>
      ) : keys.isError ? (
        <QueryNotice
          error={keys.error}
          hasData={Boolean(keys.data)}
          label="내 키"
          onRetry={() => void keys.refetch()}
        />
      ) : null}

      {!selfServiceDisabled ? (
        <>
          <StatGrid label="내 키 요약">
            <StatCard label="전체 키" value={formatNumber(keyRows.length)} />
            <StatCard
              label="사용 중"
              value={formatNumber(keyRows.filter((row) => row.status === "active").length)}
            />
            <StatCard
              label="30일 내 만료"
              tone={expiringSoon > 0 ? "warning" : "default"}
              value={formatNumber(expiringSoon)}
            />
            <StatCard label="내 역할" value={keys.data?.role || "—"} />
          </StatGrid>

          <SectionCard
            title="내 API 키"
            description="발급된 비밀값은 한 번만 보여 줍니다. 스코프는 내가 가진 권한 안에서만 선택할 수 있습니다."
            actions={
              <Button
                ref={createTrigger}
                variant="primary"
                onClick={() => {
                  form.reset({ name: "", expires_at: "" });
                  setCreateScopes([]);
                  setCreateOpen(true);
                }}
              >
                키 발급
              </Button>
            }
          >
            {keyRows.length === 0 ? (
              <EmptyState
                title="발급한 키가 없습니다."
                description="'키 발급'으로 첫 키를 만들면 여기에서 스코프와 만료를 확인할 수 있습니다."
              />
            ) : (
              <ul className="access-list">
                {keyRows.map((row) => {
                  const days = daysUntil(row.expires_at);
                  return (
                    <li key={row.id}>
                      <span className="access-list-title">
                        {row.name || row.id}
                        <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                        {days !== undefined && days >= 0 && days <= 30 ? (
                          <Badge tone="warning">{formatNumber(days)}일 후 만료</Badge>
                        ) : null}
                      </span>
                      <span className="access-list-detail mono">{row.id}</span>
                      <ScopeBadges scopes={row.scopes} />
                      <span className="access-inline-actions">
                        <span className="access-list-detail">
                          {row.expires_at ? `만료 ${formatDateTime(row.expires_at)}` : "무기한"}
                        </span>
                        <Button
                          size="small"
                          disabled={row.status === "revoked"}
                          onClick={(event) => {
                            rowTrigger.current = event.currentTarget;
                            setScopeDraft(row.scopes);
                            setScopeEditing(row);
                          }}
                        >
                          스코프 수정
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={row.status === "revoked"}
                          onClick={(event) => {
                            rowTrigger.current = event.currentTarget;
                            setRotating(row);
                          }}
                        >
                          회전
                        </Button>
                        <Button
                          size="small"
                          variant="danger"
                          disabled={row.status === "revoked"}
                          onClick={(event) => {
                            rowTrigger.current = event.currentTarget;
                            setRevoking(row);
                          }}
                        >
                          폐기
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <UpdatedAt at={keys.dataUpdatedAt} />
          </SectionCard>
        </>
      ) : null}

      <SectionCard
        title="로그인 세션"
        description="현재 로그인된 기기와 세션입니다. 낯선 세션은 즉시 종료하세요."
        actions={
          <Button
            ref={othersTrigger}
            variant="secondary"
            disabled={sessionRows.length <= 1}
            onClick={() => setRevokingOthers(true)}
          >
            다른 세션 모두 종료
          </Button>
        }
      >
        {sessions.isError ? (
          <QueryNotice
            error={sessions.error}
            hasData={Boolean(sessions.data)}
            label="세션 목록"
            onRetry={() => void sessions.refetch()}
          />
        ) : null}
        {sessionRows.length === 0 ? (
          <EmptyState title="표시할 세션이 없습니다." description="로그인하면 세션이 기록됩니다." />
        ) : (
          <ul className="access-list">
            {sessionRows.map((row) => (
              <li key={row.id}>
                <span className="access-list-title">
                  {row.ip || "IP 미상"}
                  {row.current ? <Badge tone="success">현재 세션</Badge> : null}
                  {row.sso_linked ? <Badge tone="info">SSO</Badge> : null}
                </span>
                <span className="access-list-detail truncate">{row.user_agent}</span>
                <span className="access-inline-actions">
                  <span className="access-list-detail">
                    로그인 {formatDateTime(row.created_at)} · 만료 {formatDateTime(row.expires_at)}
                  </span>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={row.current}
                    title={row.current ? "현재 세션은 종료할 수 없습니다." : undefined}
                    onClick={(event) => {
                      rowTrigger.current = event.currentTarget;
                      setRevokingSession(row);
                    }}
                  >
                    종료
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="연결 진단"
        description="개발 도구가 게이트웨이에 연결될 수 있는지 확인합니다."
        actions={
          <div className="access-inline-actions">
            <label className="access-toolbar-field">
              <span>클라이언트</span>
              <Select value={doctorClient} onChange={(event) => setDoctorClient(event.target.value)}>
                {doctorClients.map((client) => (
                  <option key={client.value} value={client.value}>
                    {client.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              variant="primary"
              disabled={doctor.isPending}
              onClick={() => doctor.mutate({ client: doctorClient })}
            >
              {doctor.isPending ? "진단 중" : "진단 실행"}
            </Button>
          </div>
        }
      >
        {doctor.data ? (
          <div className="access-stack">
            <KeyValueList
              items={[
                { label: "클라이언트", value: doctor.data.client },
                { label: "종합", value: doctor.data.overall },
                { label: "Base URL", value: doctor.data.base_url, mono: true },
                { label: "MCP URL", value: doctor.data.mcp_url, mono: true },
                { label: "인증 방식", value: doctor.data.auth_mode },
              ]}
            />
            <ul className="access-list">
              {doctor.data.checks.map((check, index) => (
                <li key={`${check.name}-${String(index)}`}>
                  <span className="access-list-title">
                    <Badge tone={check.status === "skip" ? "muted" : severityTone(check.status)}>
                      {check.status === "skip" ? "건너뜀" : check.status}
                    </Badge>
                    {check.name}
                  </span>
                  <span className="access-list-detail">{check.detail}</span>
                  {check.fix ? <span className="access-list-detail">조치: {check.fix}</span> : null}
                </li>
              ))}
            </ul>
            {doctor.data.note ? <p className="access-note">{doctor.data.note}</p> : null}
          </div>
        ) : (
          <p className="access-note">
            클라이언트를 고르고 '진단 실행'을 누르면 연결 가능 여부와 조치 방법을 알려 드립니다. 진단 결과에
            '건너뜀'으로 표시된 항목은 등급 계산에서 제외됩니다.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="개발도구 연결 설정"
        description="선택한 클라이언트에 맞는 접속 정보와 설정 예시입니다."
        actions={
          <div className="access-inline-actions">
            <label className="access-toolbar-field">
              <span>클라이언트</span>
              <Select value={packClient} onChange={(event) => setPackClient(event.target.value)}>
                {doctorClients.map((client) => (
                  <option key={client.value} value={client.value}>
                    {client.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button onClick={() => setPackRequested(true)} disabled={pack.isFetching}>
              {pack.isFetching ? "불러오는 중" : "설정 불러오기"}
            </Button>
          </div>
        }
      >
        {!packRequested ? (
          <p className="access-note">'설정 불러오기'를 누르면 접속 URL과 설정 예시를 표시합니다.</p>
        ) : pack.isError ? (
          <QueryNotice
            error={pack.error}
            hasData={Boolean(pack.data)}
            label="연결 설정"
            onRetry={() => void pack.refetch()}
          />
        ) : pack.data ? (
          <div className="access-stack">
            <KeyValueList
              items={[
                { label: "Base URL", value: pack.data.base_url, mono: true },
                { label: "MCP URL", value: pack.data.mcp_url, mono: true },
                { label: "추천 모델", value: pack.data.recommended_models.join(", ") },
                { label: "스코프", value: pack.data.scopes.join(", ") },
              ]}
            />
            {pack.data.config !== undefined && pack.data.config !== null ? (
              <JsonBlock label={pack.data.config_label || "설정"} value={pack.data.config} />
            ) : null}
            {pack.data.mcp_config !== undefined && pack.data.mcp_config !== null ? (
              <JsonBlock label="MCP 설정" value={pack.data.mcp_config} />
            ) : null}
            {pack.data.note ? <p className="access-note">{pack.data.note}</p> : null}
          </div>
        ) : null}
      </SectionCard>

      <FormDialog
        form={form}
        open={createOpen}
        onOpenChange={setCreateOpen}
        returnFocusRef={createTrigger}
        title="키 발급"
        description="비밀값은 발급 직후 한 번만 표시됩니다. 스코프를 고르지 않으면 내 역할의 권한을 상속합니다."
        submitLabel="발급"
        onSubmit={async (values) => {
          await createKey.mutateAsync({
            name: values.name,
            ...(createScopes.length > 0 ? { scopes: createScopes } : {}),
            ...(values.expires_at ? { expires_at: values.expires_at } : {}),
          });
          setCreateOpen(false);
        }}
      >
        <FormField label="키 이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        <FormField label="만료" description="비우면 무기한입니다.">
          {(control) => <Input {...control} type="datetime-local" {...form.register("expires_at")} />}
        </FormField>
        <fieldset>
          <legend>스코프</legend>
          {grantable.length === 0 ? (
            <p className="access-note">선택할 수 있는 스코프가 없습니다. 역할 권한을 그대로 상속합니다.</p>
          ) : (
            <div className="access-scope-grid">
              {grantable.map((scope) => (
                <Checkbox
                  key={scope}
                  label={scope}
                  checked={createScopes.includes(scope)}
                  onChange={(event) =>
                    setCreateScopes((current) =>
                      event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                    )
                  }
                />
              ))}
            </div>
          )}
        </fieldset>
      </FormDialog>

      <Dialog
        open={issuedSecret !== ""}
        onOpenChange={(open) => {
          if (!open) setIssuedSecret("");
        }}
        returnFocusRef={secretTitle === "회전된 비밀값" ? rowTrigger : createTrigger}
        title={secretTitle}
        description="이 값은 지금 한 번만 표시됩니다. 안전한 곳에 보관하세요."
        footer={
          <Button variant="primary" onClick={() => setIssuedSecret("")}>
            확인했습니다
          </Button>
        }
      >
        <div className="access-secret">
          <code>{issuedSecret}</code>
          <CopyButton value={issuedSecret} label="비밀값 복사" />
        </div>
      </Dialog>

      <Dialog
        open={scopeEditing !== undefined}
        onOpenChange={(open) => {
          if (!open) setScopeEditing(undefined);
        }}
        returnFocusRef={rowTrigger}
        title="키 스코프 수정"
        description="아무것도 고르지 않으면 내 역할의 권한을 그대로 상속합니다. 내가 가진 권한을 넘는 스코프는 서버가 거부합니다."
        footer={
          <>
            <Button variant="secondary" onClick={() => setScopeEditing(undefined)}>
              취소
            </Button>
            <Button
              variant="primary"
              disabled={updateScopes.isPending}
              onClick={() => {
                if (!scopeEditing) return;
                updateScopes.mutate(
                  { id: scopeEditing.id, body: { scopes: scopeDraft } },
                  { onSuccess: () => setScopeEditing(undefined) },
                );
              }}
            >
              {updateScopes.isPending ? "저장 중" : "저장"}
            </Button>
          </>
        }
      >
        <fieldset>
          <legend>스코프</legend>
          {grantable.length === 0 ? (
            <p className="access-note">선택할 수 있는 스코프가 없습니다. 역할 권한을 그대로 상속합니다.</p>
          ) : (
            <div className="access-scope-grid">
              {grantable.map((scope) => (
                <Checkbox
                  key={scope}
                  label={scope}
                  checked={scopeDraft.includes(scope)}
                  onChange={(event) =>
                    setScopeDraft((current) =>
                      event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                    )
                  }
                />
              ))}
            </div>
          )}
        </fieldset>
      </Dialog>

      <ConfirmDialog
        open={rotating !== undefined}
        onOpenChange={(open) => {
          if (!open) setRotating(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="키 회전"
        description={`${rotating?.name || rotating?.id || ""} 키를 같은 이름·스코프의 새 키로 바꾸고 기존 키를 폐기합니다. 새 비밀값은 한 번만 표시됩니다.`}
        confirmLabel="회전"
        onConfirm={async () => {
          if (rotating) await rotateKey.mutateAsync(rotating.id);
          setRotating(undefined);
        }}
      />

      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="키 폐기"
        description={`${revoking?.name || revoking?.id || ""} 키를 폐기합니다. 이 키를 쓰는 도구는 즉시 인증에 실패합니다.`}
        confirmLabel="폐기"
        onConfirm={async () => {
          if (revoking) await revokeKey.mutateAsync(revoking.id);
          setRevoking(undefined);
        }}
      />

      <ConfirmDialog
        open={revokingSession !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevokingSession(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="세션 종료"
        description={`${revokingSession?.ip ?? ""} 세션을 종료합니다. 해당 기기는 다시 로그인해야 합니다.`}
        confirmLabel="종료"
        onConfirm={async () => {
          if (revokingSession) await revokeSession.mutateAsync(revokingSession.id);
          setRevokingSession(undefined);
        }}
      />

      <ConfirmDialog
        open={revokingOthers}
        onOpenChange={setRevokingOthers}
        returnFocusRef={othersTrigger}
        tone="danger"
        title="다른 세션 모두 종료"
        description="현재 세션을 제외한 모든 로그인 세션을 종료합니다."
        confirmLabel="모두 종료"
        onConfirm={async () => {
          await revokeOthers.mutateAsync(undefined);
          setRevokingOthers(false);
        }}
      />
    </div>
  );
}
