import { useRef, useState } from "react";
import type { MeSession } from "@/shared/api/domains/access.schemas";
import { meKeys, type useMeSessionsQuery } from "./use-me-queries";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { QueryNotice } from "@/features/access/access-ui";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";

const routeId = "me.home";
interface Props {
  sessions: ReturnType<typeof useMeSessionsQuery>;
  canWrite: boolean;
  ownsResult: () => boolean;
  assertCurrent: () => void;
}
export function MeSessionsSection({
  sessions,
  canWrite,
  ownsResult,
  assertCurrent,
}: Props): React.JSX.Element {
  const sessionRows = sessions.data?.sessions ?? [];
  const [revokingSession, setRevokingSession] = useState<MeSession | undefined>();
  const [revokingOthers, setRevokingOthers] = useState(false);
  const rowTrigger = useRef<HTMLElement>(null);
  const othersTrigger = useRef<HTMLButtonElement>(null);
  const revokeSession = useMutationFeedback({
    ownsResult,
    mutate: (id: string) => {
      assertCurrent();
      return apiClient.request(withPathParams(endpoints.domains.access.me.revokeSession, { id }), {
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [meKeys.sessions],
    successMessage: "세션을 종료했습니다.",
  });
  const revokeOthers = useMutationFeedback({
    ownsResult,
    mutate: () => {
      assertCurrent();
      return apiClient.request(endpoints.domains.access.me.revokeOtherSessions, {
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [meKeys.sessions],
    successMessage: (result) => `다른 세션 ${formatNumber(result.revoked_count)}개를 종료했습니다.`,
  });

  return (
    <>
      <SectionCard
        title="로그인 세션"
        description="현재 로그인된 기기와 세션입니다. 낯선 세션은 즉시 종료하세요."
        actions={
          <Button
            ref={othersTrigger}
            variant="secondary"
            disabled={!canWrite || sessionRows.length <= 1}
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
                    disabled={!canWrite || row.current}
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

      <ConfirmDialog
        open={revokingSession !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevokingSession(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        confirmDisabled={!canWrite}
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
        confirmDisabled={!canWrite}
        title="다른 세션 모두 종료"
        description="현재 세션을 제외한 모든 로그인 세션을 종료합니다."
        confirmLabel="모두 종료"
        onConfirm={async () => {
          await revokeOthers.mutateAsync(undefined);
          setRevokingOthers(false);
        }}
      />
    </>
  );
}
