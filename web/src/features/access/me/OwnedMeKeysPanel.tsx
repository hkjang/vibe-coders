import { useLayoutEffect, useRef, useState } from "react";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { MeKeyRotationDialog } from "./MeKeyRotationDialog";
import { canRotateMeKey } from "./me-key-rotation";
import { MeSessionsSection } from "./MeSessionsSection";
import { MeConnectionTools } from "./MeConnectionTools";
import { MeKeyCreateDialog } from "./MeKeyCreateDialog";
import { meKeyErrorMessage } from "./me-key-errors";
import { meKeyLifecycle } from "./me-key-lifecycle";
import { useKeyExpiryClock } from "./use-key-expiry-clock";
import { roleLabel } from "@/config/ui-labels";

import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { MeKeyScopesDialog } from "@/features/access/me/MeKeyScopesDialog";
import { meKeyScopeChoices } from "@/features/access/me/me-key-scopes";
import { useMeKeyScopeDraft } from "@/features/access/me/use-me-key-scope-draft";
import { meKeys, useMeKeysQuery, useMeSessionsQuery } from "@/features/access/me/use-me-queries";
import { apiClient } from "@/shared/api/client";
import type { CreateMeKeyBody, UpdateMeKeyScopesBody } from "@/shared/api/domains/access";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import "@/features/access/me/me-key-scopes.css";

const routeId = "me.home";
const emptyKeys: ApiKeyPublic[] = [];

export function OwnedMeKeysPanel({ owner }: { owner: string }): React.JSX.Element {
  const keys = useMeKeysQuery(true, owner);
  const keyRows = keys.data?.api_keys ?? emptyKeys;
  const now = useKeyExpiryClock(keyRows);
  const sessions = useMeSessionsQuery(true, owner);
  const catalogKey = [...meKeys.keys, owner];
  const access = useFeatureMutationAccess([routeId], true);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [revoked, setRevoked] = useState(false);
  const denied =
    revoked ||
    [keys.error, sessions.error].some(
      (error) =>
        isAppError(error) &&
        (error.status === 401 ||
          error.status === 403 ||
          error.kind === "auth" ||
          error.kind === "permission"),
    );
  if (denied && !revoked) setRevoked(true);
  const deniedRef = useRef(denied);
  useLayoutEffect(() => {
    deniedRef.current = denied;
  }, [denied]);
  const ownsResult = () => mounted.current && !deniedRef.current;
  const assertCurrent = () => {
    access.assertCurrent();
    if (!ownsResult()) throw new AppError("현재 계정의 조회 권한을 다시 확인하세요.", { kind: "aborted" });
  };
  const [rotationAttempts, setRotationAttempts] = useState<ReadonlySet<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState("");
  const [secretTitle, setSecretTitle] = useState("발급된 비밀값");
  const {
    target: scopeTarget,
    open: openScopes,
    close: closeScopes,
    returnFocusRef: scopeReturnFocus,
    rememberTrigger: rememberScopeTrigger,
  } = useMeKeyScopeDraft();
  const [rotating, setRotating] = useState<ApiKeyPublic | undefined>();
  const [revoking, setRevoking] = useState<ApiKeyPublic | undefined>();
  const createTrigger = useRef<HTMLButtonElement>(null);
  const rowTrigger = useRef<HTMLElement>(null);

  const createKey = useMutationFeedback({
    ownsResult,
    mutate: (body: CreateMeKeyBody) => {
      assertCurrent();
      return apiClient.request(endpoints.domains.access.me.createKey, {
        body,
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [meKeys.keys],
    successMessage: "키를 발급했습니다.",
    onSuccess: (result) => {
      setSecretTitle("발급된 비밀값");
      setIssuedSecret(result.secret);
    },
  });
  const updateScopes = useMutationFeedback({
    errorFormatter: meKeyErrorMessage,
    ownsResult,
    mutate: ({ id, body }: { id: string; body: UpdateMeKeyScopesBody }) => {
      assertCurrent();
      return apiClient.request(withPathParams(endpoints.domains.access.me.updateKeyScopes, { id }), {
        body,
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [meKeys.keys],
    successMessage: "내 API 키 권한을 수정했습니다.",
  });
  const revokeKey = useMutationFeedback({
    ownsResult,
    mutate: (id: string) => {
      assertCurrent();
      return apiClient.request(withPathParams(endpoints.domains.access.me.revokeKey, { id }), {
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [meKeys.keys],
    successMessage: "키를 폐기했습니다.",
  });

  const selfServiceDisabled = keys.isError && isAppError(keys.error) && keys.error.status === 404;

  if (denied)
    return (
      <InlineNotice tone="warning">
        키 또는 세션 조회 권한이 거부되어 데이터와 작업을 잠갔습니다. 다시 로그인하거나 화면을 다시 열어
        권한을 확인하세요.
      </InlineNotice>
    );

  if (keys.isPending && !keys.data && !selfServiceDisabled) {
    return <LoadingState label="내 키를 불러오는 중입니다." />;
  }

  const grantable = keys.data?.grantable_scopes ?? [];
  const expiringSoon = keyRows.filter((row) => {
    const { days } = meKeyLifecycle(row, now);
    return days !== undefined && days <= 30;
  }).length;

  return (
    <div className="access-stack">
      {access.reason ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
      {rotationAttempts.size > 0 ? (
        <InlineNotice tone="warning">
          회전을 요청한 키의 재요청을 막았습니다. 목록을 새로고침해 대체 키와 유예 종료 시각을 확인하세요. 새
          비밀값은 다시 표시할 수 없습니다.
        </InlineNotice>
      ) : null}
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
              value={formatNumber(keyRows.filter((row) => meKeyLifecycle(row, now).usable).length)}
            />
            <StatCard
              label="30일 내 만료"
              tone={expiringSoon > 0 ? "warning" : "default"}
              value={formatNumber(expiringSoon)}
            />
            <StatCard label="내 역할" value={roleLabel(keys.data?.role)} />
          </StatGrid>

          <SectionCard
            title="내 API 키"
            description="발급된 비밀값은 한 번만 보여 줍니다. 키 권한은 내가 가진 권한 안에서만 선택할 수 있습니다."
            actions={
              <Button
                ref={createTrigger}
                variant="primary"
                disabled={!access.allowed || !keys.isSuccess || keys.isFetching}
                onClick={() => {
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
                description="'키 발급'으로 첫 키를 만들면 여기에서 권한과 만료를 확인할 수 있습니다."
              />
            ) : (
              <ul className="access-list">
                {keyRows.map((row) => {
                  const lifecycle = meKeyLifecycle(row, now);
                  const { days } = lifecycle;
                  return (
                    <li key={row.id}>
                      <span className="access-list-title">
                        {row.name || row.id}
                        <Badge tone={lifecycle.tone}>{lifecycle.label}</Badge>
                        {days !== undefined && days >= 0 && days <= 30 ? (
                          <Badge tone="warning">{formatNumber(days)}일 후 만료</Badge>
                        ) : null}
                      </span>
                      <span className="access-list-detail mono">{row.id}</span>
                      {row.replaced_by ? (
                        <span className="access-note">
                          대체 키: <span className="mono">{row.replaced_by}</span> · 이전 키 유예 종료:{" "}
                          {formatDateTime(row.grace_ends_at)}
                        </span>
                      ) : null}
                      {row.scopes.length === 0 ? (
                        <span className="access-note">선택된 권한 없음</span>
                      ) : (
                        <span className="badge-list me-key-scope-badges">
                          {meKeyScopeChoices(row.scopes).map(({ value, label }) => (
                            <Badge key={value} tone="muted">
                              {label} ({value || "빈 권한 식별자"})
                            </Badge>
                          ))}
                        </span>
                      )}
                      <span className="access-inline-actions">
                        <span className="access-list-detail">
                          {row.expires_at ? `만료 ${formatDateTime(row.expires_at)}` : "무기한"}
                        </span>
                        <Button
                          ref={(node) => rememberScopeTrigger(node, row.id)}
                          size="small"
                          disabled={!access.allowed || !lifecycle.usable || Boolean(row.replaced_by)}
                          onClick={(event) => openScopes(row, event.currentTarget)}
                        >
                          권한 수정
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={
                            !access.allowed ||
                            !keys.isSuccess ||
                            keys.isFetching ||
                            !canRotateMeKey(row) ||
                            rotationAttempts.has(row.id)
                          }
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
                          disabled={!access.allowed || row.status === "revoked"}
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

      <MeSessionsSection
        sessions={sessions}
        canWrite={access.allowed}
        ownsResult={ownsResult}
        assertCurrent={assertCurrent}
      />

      <MeConnectionTools
        owner={owner}
        canWrite={access.allowed}
        ownsResult={ownsResult}
        assertCurrent={assertCurrent}
      />

      {createOpen ? (
        <MeKeyCreateDialog
          grantable={grantable}
          canWrite={access.allowed && keys.isSuccess && !keys.isFetching}
          returnFocusRef={createTrigger}
          onClose={() => setCreateOpen(false)}
          onSubmit={(body) => createKey.mutateAsync(body)}
        />
      ) : null}

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

      {scopeTarget ? (
        <MeKeyScopesDialog
          key={`${scopeTarget.epoch}:${scopeTarget.instance}`}
          target={scopeTarget.row}
          catalogQuery={keys}
          catalogKey={catalogKey}
          writeDisabled={!access.allowed}
          onOpenChange={(open) => {
            if (!open) closeScopes(scopeTarget.instance);
          }}
          returnFocusRef={scopeReturnFocus}
          onSubmit={(id, scopes) => {
            if (scopeTarget.epoch !== tokenStore.getSessionEpoch()) {
              throw new AppError("인증 세션이 변경되어 이전 권한 초안을 취소했습니다.", { kind: "aborted" });
            }
            return updateScopes.mutateAsync({ id, body: { scopes } });
          }}
        />
      ) : null}

      {rotating ? (
        <MeKeyRotationDialog
          key={rotating.id}
          target={rotating}
          catalogQuery={keys}
          catalogKey={catalogKey}
          returnFocusRef={rowTrigger}
          ownsResult={ownsResult}
          onAccessDenied={() => setRevoked(true)}
          onAttempt={(id) => setRotationAttempts((previous) => new Set([...previous, id]))}
          onSuccess={(secret) => {
            setSecretTitle("회전된 비밀값");
            setIssuedSecret(secret);
          }}
          onClose={() => setRotating(undefined)}
        />
      ) : null}

      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="키 폐기"
        confirmDisabled={!access.allowed}
        description={`${revoking?.name || revoking?.id || ""} 키를 폐기합니다. 이 키를 쓰는 도구는 즉시 인증에 실패합니다.`}
        confirmLabel="폐기"
        onConfirm={async () => {
          if (revoking) await revokeKey.mutateAsync(revoking.id);
          setRevoking(undefined);
        }}
      />
    </div>
  );
}
