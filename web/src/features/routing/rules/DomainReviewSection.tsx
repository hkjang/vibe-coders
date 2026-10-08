import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DomainReviewAction,
  DomainReviewStatus,
  RoutingDomainReviewItem,
} from "@/shared/api/domains/routing-domain-review";
import { AppError, isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { DomainReviewDialog } from "./DomainReviewDialog";
import { DomainReviewDenied } from "./DomainReviewDenied";
import { useDomainReviewAccess, type DomainReviewAccess } from "./domain-review-access";
import type { DomainReviewReview } from "./domain-review-operation";
import { useDomainReviewQuery } from "./domain-review-query";
import {
  currentDomainReview,
  domainReviewChanged,
  domainReviewProblem,
  domainReviewShortID,
  domainReviewSource,
  domainReviewStatusLabels,
  domainReviewStatusText,
  domainReviewText,
} from "./domain-review-state";
import "./domain-review.css";

interface Props {
  canWrite: boolean;
  status: DomainReviewStatus;
  children: (pendingReviews: number | undefined) => ReactNode;
}
interface Selection {
  active: boolean;
  serial: number;
  review: DomainReviewReview;
}
interface PendingCount {
  owner: object;
  count: number | undefined;
}
interface ContentProps {
  access: DomainReviewAccess;
  status: DomainReviewStatus;
  pendingOwner: object;
  onPendingCount: (value: PendingCount) => void;
  onDenied: (error: AppError) => void;
  returnFocusRef: { current: HTMLElement | null };
}
interface RowActions {
  access: DomainReviewAccess;
  ready: boolean;
  open: (item: RoutingDomainReviewItem, action: DomainReviewAction, trigger: HTMLButtonElement) => void;
  register: (
    item: RoutingDomainReviewItem,
    action: DomainReviewAction,
    node: HTMLButtonElement | null,
  ) => void;
}
const RowContext = createContext<RowActions | undefined>(undefined);
function ReviewCell({
  item,
  field,
}: {
  item: RoutingDomainReviewItem;
  field: keyof RoutingDomainReviewItem | "actions";
}) {
  const context = useContext(RowContext);
  if (!context) return null;
  const { access, ready, open, register } = context;
  const text = (value: string) => domainReviewText(value, access.prefixes);
  if (field === "status")
    return (
      <Badge tone={item.status === "pending" ? "warning" : "muted"}>
        {domainReviewStatusText(item.status, access.prefixes)}
      </Badge>
    );
  if (field !== "actions") return text(item[field]);
  const problem = domainReviewProblem(item, access.prefixes);
  return (
    <div>
      <span className="domain-review-actions">
        {(["approve", "reject"] as const).map((action) => (
          <Button
            key={action}
            size="small"
            variant={action === "approve" ? "secondary" : "ghost"}
            aria-label={`${domainReviewShortID(item.id, access.prefixes)} 검토 ${action === "approve" ? "승인" : "거절"}`}
            disabled={!access.write.allowed || Boolean(problem)}
            aria-disabled={!ready}
            title={problem ?? access.write.reason}
            ref={(node) => register(item, action, node)}
            onClick={(event) => open(item, action, event.currentTarget)}
          >
            {action === "approve" ? "승인" : "거절"}
          </Button>
        ))}
      </span>
      {problem ? <p className="routing-meta">{problem}</p> : null}
    </div>
  );
}
const column = createDataTableColumnHelper<RoutingDomainReviewItem>();
// Stable cell identities keep focused triggers mounted through query updates.
const columns = column.columns([
  column.display({
    id: "created_at",
    header: "등록",
    cell: ({ row }) => <ReviewCell item={row.original} field="created_at" />,
  }),
  column.display({
    id: "current_route",
    header: "기록 당시 모델",
    cell: ({ row }) => <ReviewCell item={row.original} field="current_route" />,
  }),
  column.display({
    id: "suggested_route",
    header: "제안 라우트",
    cell: ({ row }) => <ReviewCell item={row.original} field="suggested_route" />,
  }),
  column.display({
    id: "reason",
    header: "사유",
    cell: ({ row }) => <ReviewCell item={row.original} field="reason" />,
  }),
  column.display({
    id: "status",
    header: "상태",
    cell: ({ row }) => <ReviewCell item={row.original} field="status" />,
  }),
  column.display({
    id: "actions",
    header: "작업",
    cell: ({ row }) => <ReviewCell item={row.original} field="actions" />,
  }),
]);
function Content({ access, status, pendingOwner, onPendingCount, onDenied, returnFocusRef }: ContentProps) {
  const query = useDomainReviewQuery(status, access, onDenied);
  const [selected, setSelected] = useState<Selection>();
  const selection = useRef<Selection | undefined>(undefined);
  const serial = useRef(0);
  const heading = useRef<HTMLSpanElement>(null);
  const triggers = useRef(
    new Map<RoutingDomainReviewItem, Partial<Record<DomainReviewAction, HTMLButtonElement>>>(),
  );
  const [notice, setNotice] = useState<string>();
  const rows = query.result.data?.items ?? [];
  const text = (value: string) => domainReviewText(value, access.prefixes);
  const open = (item: RoutingDomainReviewItem, action: DomainReviewAction, trigger: HTMLButtonElement) => {
    try {
      access.assertApproval(access.approval);
      const snapshot = query.capture(item);
      const source = domainReviewSource(item, action, status);
      if (domainReviewProblem(item, access.prefixes) || !currentDomainReview(source, snapshot.data))
        throw new AppError(domainReviewChanged, { kind: "contract" });
      if (selection.current) selection.current.active = false;
      const next: Selection = {
        active: true,
        serial: ++serial.current,
        review: Object.freeze({ source, snapshot, approval: access.approval }),
      };
      selection.current = next;
      returnFocusRef.current = trigger;
      setSelected(next);
      setNotice(undefined);
    } catch {
      setNotice(domainReviewChanged);
    }
  };
  const close = () => {
    const old = selection.current;
    if (old) old.active = false;
    const row = old && query.result.data && currentDomainReview(old.review.source, query.result.data);
    const trigger = old && row && triggers.current.get(row)?.[old.review.source.action];
    returnFocusRef.current = trigger && !trigger.disabled ? trigger : heading.current;
    selection.current = undefined;
    setSelected(undefined);
  };
  const refresh = () => {
    void query.refresh().catch(() => {
      /* Query error is rendered below. */
    });
  };
  const requestId = isAppError(query.result.error) ? query.result.error.requestId : undefined;
  const pendingReviews =
    status === "pending" && query.ready ? rows.filter((item) => item.status === "pending").length : undefined;
  useLayoutEffect(() => {
    onPendingCount({ owner: pendingOwner, count: pendingReviews });
  }, [onPendingCount, pendingOwner, pendingReviews]);
  return (
    <>
      <SectionCard
        className="domain-review-section"
        title={
          <span tabIndex={-1} ref={heading}>
            도메인 라우팅 검토 큐
          </span>
        }
        description="승인·거절은 검토 상태와 검토 시각만 기록합니다. 학습 예시 승격이나 라우팅 규칙 변경은 하지 않습니다."
      >
        <p>
          요청한 검토 상태: {domainReviewStatusLabels[status]} · 최대 50건입니다. 학습 구간과 라우트 입력은 이
          검토 목록의 조회 조건이 아닙니다. 팀별 범위를 확인한 결과나 전체 대기 건수가 아닙니다.
        </p>
        <Button aria-disabled={query.result.isFetching} aria-busy={query.result.isFetching} onClick={refresh}>
          검토 목록 다시 조회
        </Button>
        {!access.write.allowed ? <InlineNotice tone="info">{access.write.reason}</InlineNotice> : null}
        {notice ? <InlineNotice tone="warning">{notice}</InlineNotice> : null}
        {query.result.isFetching && query.result.data ? (
          <p role="status">
            검토 목록을 다시 조회하는 동안 이전 결과를 표시합니다. 새 검토는 잠시 사용할 수 없습니다.
          </p>
        ) : null}
        {query.result.isError ? (
          <InlineNotice tone="warning" title="최신 검토 목록을 확인하지 못했습니다.">
            {query.result.data
              ? "이전 결과를 표시합니다. 목록을 다시 조회한 뒤 검토하세요."
              : "검토 목록을 다시 조회하세요."}
            {requestId ? <p>요청 ID: {text(requestId)}</p> : null}
          </InlineNotice>
        ) : null}
        <RowContext
          value={{
            access,
            ready: query.ready,
            open,
            register: (item, action, node) => {
              const entries = triggers.current.get(item) ?? {};
              if (node) {
                entries[action] = node;
                triggers.current.set(item, entries);
              } else {
                if (action === "approve") delete entries.approve;
                else delete entries.reject;
                if (!entries.approve && !entries.reject) triggers.current.delete(item);
              }
            },
          }}
        >
          <DataTable
            caption="도메인 라우팅 검토 큐"
            columns={columns}
            data={rows}
            emptyMessage="현재 응답에 검토 항목이 없습니다."
            error={
              query.result.isError && !query.result.data ? "검토 목록을 불러오지 못했습니다." : undefined
            }
            getRowId={(_row, index) => String(index)}
            loading={query.result.isPending}
            onRetry={refresh}
          />
        </RowContext>
      </SectionCard>
      {selected ? (
        <DomainReviewDialog
          key={selected.serial}
          access={access}
          query={query}
          initialReview={selected.review}
          returnFocusRef={returnFocusRef}
          onClose={close}
          assertSelected={() => {
            query.assertRead();
            if (!selected.active || selection.current !== selected)
              throw new AppError("종료된 도메인 검토입니다.", { kind: "aborted" });
          }}
        />
      ) : null}
    </>
  );
}
export function DomainReviewSection({ canWrite, ...props }: Props) {
  const access = useDomainReviewAccess(canWrite);
  const [pending, setPending] = useState<PendingCount>();
  const [attempt, setAttempt] = useState(0);
  const [denial, setDenial] = useState<{ owner: object; error: AppError }>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // A new object for every committed access/status transition prevents an old
  // count from becoming current again after an A -> B -> A owner change.
  const pendingOwner = useMemo(
    () => ({ lifetime: access.lifetime, status: props.status, attempt }),
    [access.lifetime, props.status, attempt],
  );
  const denied = denial?.owner === pendingOwner ? denial.error : undefined;
  const pendingReviews =
    access.readable && !denied && pending?.owner === pendingOwner ? pending.count : undefined;
  return (
    <>
      {/* Recommendations own their existing query/dialog lifetime independently. */}
      {props.children(pendingReviews)}
      {access.readable && denied ? (
        <DomainReviewDenied
          error={denied}
          returnFocusRef={returnFocusRef}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : access.readable ? (
        <Content
          key={`${access.key}:${props.status}:${attempt}`}
          access={access}
          status={props.status}
          pendingOwner={pendingOwner}
          onPendingCount={setPending}
          onDenied={(error) => setDenial({ owner: pendingOwner, error })}
          returnFocusRef={returnFocusRef}
        />
      ) : (
        <InlineNotice tone="warning" title="도메인 검토 조회 권한을 확인하세요.">
          현재 라우팅 화면의 routing:read 권한과 프롬프트 원문 조회 권한이 필요합니다.
        </InlineNotice>
      )}
    </>
  );
}
