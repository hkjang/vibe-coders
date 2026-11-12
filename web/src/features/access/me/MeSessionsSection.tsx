import { useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import type { MeSession } from "@/shared/api/domains/me-access.schemas";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { UpdatedAt } from "@/features/access/access-ui";
import type { useMeSessionsQuery } from "./use-me-queries";
import { MeTable, type MeColumn } from "./MeTable";
import { MeQueryContent, MeOperationNotice } from "./me-console-ui";
import { meError, safeMeMessage } from "./me-console-model";
import {
  currentSessionKnown,
  requireSessionTarget,
  sessionReview,
  type PersonalSessions,
} from "./me-access-model";
import { useMeRevokeSession, useMeRevokeOtherSessions } from "./me-session-actions";

interface Props {
  sessions: ReturnType<typeof useMeSessionsQuery>;
  canWrite: boolean;
  ownsResult: () => boolean;
  assertCurrent: () => void;
}
type Review = { source: PersonalSessions; row?: MeSession };
export function MeSessionsSection({ sessions, canWrite, ownsResult, assertCurrent }: Props) {
  const { credentialPrefixes } = useAuth();
  const revoke = useMeRevokeSession(),
    others = useMeRevokeOtherSessions();
  const [review, setReview] = useState<Review>();
  const [changed, setChanged] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  const data = sessions.data;
  const rows = data?.sessions ?? [];
  const known = currentSessionKnown(data) && rows.every((row) => row.current !== undefined);
  const disabled =
    !canWrite || !known || sessions.isFetching || sessions.isError || revoke.disabled || others.disabled;
  const remaining = rows.filter((row) => !row.current).length;
  const columns: readonly MeColumn<MeSession>[] = [
    { id: "ip", header: "접속 IP", value: (row) => row.ip || "미확인" },
    { id: "agent", header: "기기·브라우저", value: (row) => row.user_agent || "미확인" },
    {
      id: "current",
      header: "사용 상태",
      value: (row) => (row.current === undefined ? "미확인" : row.current ? "현재 세션" : "다른 세션"),
      cell: (row) => (
        <Badge tone={row.current ? "success" : "muted"}>
          {row.current === undefined ? "미확인" : row.current ? "현재 세션" : "다른 세션"}
        </Badge>
      ),
    },
    {
      id: "sso",
      header: "통합 로그인",
      value: (row) => (row.sso_linked === undefined ? "미확인" : row.sso_linked ? "연결됨" : "연결 안 됨"),
    },
    {
      id: "created",
      header: "로그인 시각",
      value: (row) => row.created_at,
      cell: (row) => formatDateTime(row.created_at),
    },
    {
      id: "expires",
      header: "만료 시각",
      value: (row) => row.expires_at,
      cell: (row) => formatDateTime(row.expires_at),
    },
    { id: "id", header: "세션 ID", value: (row) => row.id },
    {
      id: "actions",
      header: "작업",
      cell: (row) => (
        <Button
          size="small"
          variant="danger"
          disabled={disabled || row.current !== false}
          title={row.current ? "현재 세션은 사용자 메뉴에서 로그아웃하세요." : undefined}
          onClick={(event) => {
            if (!data) return;
            trigger.current = event.currentTarget;
            setChanged(false);
            setReview({ source: data, row });
          }}
        >
          종료
        </Button>
      ),
    },
  ];
  const confirm = async () => {
    assertCurrent();
    if (!review || !canWrite || !ownsResult()) throw meError("changed");
    const fresh = await sessions.refetch({ throwOnError: true });
    assertCurrent();
    if (
      !fresh.data ||
      review.source.current_session_id !== fresh.data.current_session_id ||
      (!review.row && sessionReview(fresh.data) !== sessionReview(review.source))
    ) {
      setReview(undefined);
      setChanged(true);
      return;
    }
    if (review.row) {
      requireSessionTarget(fresh.data, review.row.id, credentialPrefixes);
      await revoke.execute({ id: review.row.id, current: fresh.data.current_session_id });
    } else {
      if (!currentSessionKnown(fresh.data) || fresh.data.sessions.some((row) => row.current === undefined))
        throw meError("changed");
      await others.execute({ current: fresh.data.current_session_id });
    }
    setReview(undefined);
  };
  return (
    <>
      <SectionCard
        title="로그인 세션"
        description="활성 로그인 세션을 확인하고 다른 기기의 세션을 종료합니다. 현재 세션은 유지합니다."
        actions={
          <Button
            variant="secondary"
            disabled={disabled || remaining === 0}
            onClick={(event) => {
              if (!data) return;
              trigger.current = event.currentTarget;
              setChanged(false);
              setReview({ source: data });
            }}
          >
            다른 세션 모두 종료
          </Button>
        }
      >
        <MeOperationNotice
          pending={revoke.pending || others.pending}
          uncertain={revoke.uncertain || others.uncertain}
        />
        {changed ? (
          <InlineNotice tone="warning">
            세션 목록이 변경됐습니다. 최신 목록에서 종료 대상을 다시 확인하세요.
          </InlineNotice>
        ) : null}
        <MeQueryContent query={sessions} label="로그인 세션">
          {!known && rows.length > 0 ? (
            <InlineNotice tone="warning">
              현재 세션을 확인하지 못해 종료 작업을 잠갔습니다. 다시 로그인하거나 목록을 새로 조회하세요.
            </InlineNotice>
          ) : null}
          <MeTable
            id="login_sessions"
            caption="로그인 세션"
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            loading={sessions.isFetching}
            description="조회한 활성 세션 목록에서 검색·정렬·페이지 이동과 CSV 저장을 제공합니다."
          />
          <UpdatedAt at={sessions.dataUpdatedAt} />
        </MeQueryContent>
      </SectionCard>
      <ConfirmDialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) setReview(undefined);
        }}
        returnFocusRef={trigger}
        tone="danger"
        title={review?.row ? "세션 종료" : "다른 세션 모두 종료"}
        confirmLabel={review?.row ? "종료" : "모두 종료"}
        confirmDisabled={!canWrite || !known || revoke.disabled || others.disabled}
        errorFormatter={safeMeMessage}
        scrollBody
        scrollBodyLabel="종료할 세션 상세"
        description={
          review?.row
            ? "선택한 기기는 다시 로그인해야 합니다. API 키는 폐기하지 않습니다."
            : "현재 세션을 제외한 모든 로그인 세션을 종료합니다. 확인 직후 새로 로그인한 세션도 종료될 수 있습니다."
        }
        onConfirm={confirm}
      >
        {review?.row ? (
          <dl className="access-stack">
            <dt>접속 IP</dt>
            <dd>{review.row.ip || "미확인"}</dd>
            <dt>기기·브라우저</dt>
            <dd>{review.row.user_agent || "미확인"}</dd>
            <dt>세션 ID</dt>
            <dd>{review.row.id}</dd>
          </dl>
        ) : review ? (
          <p>
            확인한 활성 세션 {formatNumber(review.source.sessions.filter((row) => !row.current).length)}개 ·
            현재 세션 {review.source.current_session_id} 유지
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
