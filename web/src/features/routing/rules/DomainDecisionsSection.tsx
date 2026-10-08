import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  RoutingDomainDecision,
  RoutingDomainDecisionsQuery,
} from "@/shared/api/domains/routing-domain-decisions";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import {
  domainDecisionRequestIDError,
  normalizeDomainDecisionRequestID,
} from "@/shared/utils/domain-decision-filters";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { DomainDecisionDialog } from "./DomainDecisionDialog";
import { useDomainDecisionsAccess, type DomainDecisionsAccess } from "./domain-decisions-access";
import { useDomainDecisionsQuery, type DomainDecisionSnapshot } from "./domain-decisions-query";
import {
  domainDecisionChanged,
  domainDecisionDenied,
  domainDecisionPermission,
  domainDecisionShortID,
  domainDecisionSource,
  domainDecisionText,
  type DomainDecisionSource,
} from "./domain-decisions-state";
import type { LearningWindow } from "./learning-recommendation-state";
import "./domain-decisions.css";

interface Props {
  window: LearningWindow;
  route: string;
}
interface RowActions {
  access: DomainDecisionsAccess;
  ready: boolean;
  open: (item: RoutingDomainDecision, trigger: HTMLButtonElement) => void;
  register: (item: RoutingDomainDecision, node: HTMLButtonElement | null) => void;
}
const RowContext = createContext<RowActions | undefined>(undefined);
function DecisionCell({
  item,
  field,
}: {
  item: RoutingDomainDecision;
  field: "identity" | "route" | "score" | "reason" | "actions";
}) {
  const context = useContext(RowContext);
  if (!context) return null;
  const text = (value: string) => domainDecisionText(value, context.access.prefixes);
  if (field === "identity")
    return (
      <>
        <strong className="mono">{domainDecisionShortID(item.request_id, context.access.prefixes)}</strong>
        <p className="routing-meta">{text(item.created_at)}</p>
      </>
    );
  if (field === "route" || field === "reason") return text(item[field]);
  if (field === "score")
    return (
      <>
        <span>신뢰도 기록값 {formatNumber(item.confidence, 4)}</span>
        <p className="routing-meta">
          증거 점수 {formatNumber(item.evidence_score, 4)} · {formatNumber(item.evidence_count)}건
        </p>
      </>
    );
  return (
    <Button
      size="small"
      aria-label={`${domainDecisionShortID(item.request_id, context.access.prefixes)} 결정 근거 보기`}
      aria-disabled={!context.ready}
      ref={(node) => context.register(item, node)}
      onClick={(event) => context.open(item, event.currentTarget)}
    >
      근거 보기
    </Button>
  );
}
const column = createDataTableColumnHelper<RoutingDomainDecision>();
const columns = column.columns([
  column.display({
    id: "identity",
    header: "요청 · 기록 시각",
    cell: ({ row }) => <DecisionCell item={row.original} field="identity" />,
  }),
  column.display({
    id: "route",
    header: "기록된 라우트",
    cell: ({ row }) => <DecisionCell item={row.original} field="route" />,
  }),
  column.display({
    id: "score",
    header: "기록된 점수",
    cell: ({ row }) => <DecisionCell item={row.original} field="score" />,
  }),
  column.display({
    id: "reason",
    header: "결정 사유",
    cell: ({ row }) => <DecisionCell item={row.original} field="reason" />,
  }),
  column.display({
    id: "actions",
    header: "근거",
    cell: ({ row }) => <DecisionCell item={row.original} field="actions" />,
  }),
]);
interface Selection {
  source: DomainDecisionSource;
  snapshot: DomainDecisionSnapshot;
}
function Results({
  access,
  filters,
  heading,
}: {
  access: DomainDecisionsAccess;
  filters: RoutingDomainDecisionsQuery;
  heading: RefObject<HTMLSpanElement | null>;
}) {
  const query = useDomainDecisionsQuery(filters, access);
  const report = query.result.data;
  const rows = report?.decisions ?? [];
  const [pagination, setPagination] = useState({ report, page: 0 });
  const pageCount = Math.max(1, Math.ceil(rows.length / 20));
  const page = pagination.report === report ? Math.min(pagination.page, pageCount - 1) : 0;
  const [selected, setSelected] = useState<Selection>();
  if (query.denied && selected) setSelected(undefined);
  const [notice, setNotice] = useState<string>();
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (query.denied) returnFocusRef.current = heading.current;
  }, [heading, query.denied]);
  useLayoutEffect(
    () => () => {
      returnFocusRef.current = heading.current;
    },
    [heading],
  );
  const open = (item: RoutingDomainDecision, trigger: HTMLButtonElement) => {
    try {
      const snapshot = query.capture(item);
      returnFocusRef.current = trigger;
      setSelected({ source: domainDecisionSource(item, snapshot.data), snapshot });
      setNotice(undefined);
    } catch {
      setNotice(domainDecisionChanged);
    }
  };
  const close = () => {
    returnFocusRef.current = selected
      ? (triggers.current.get(selected.source.item.id) ?? heading.current)
      : heading.current;
    setSelected(undefined);
  };
  const refresh = () => {
    void query.refresh().catch(() => {});
  };
  const denied = query.denied;
  const requestId = isAppError(query.result.error) ? query.result.error.requestId : undefined;
  return (
    <>
      <div className="domain-decision-result-actions">
        <Button aria-disabled={query.result.isFetching} aria-busy={query.result.isFetching} onClick={refresh}>
          결정 목록 다시 조회
        </Button>
        {report ? (
          <span>
            조회된 최근 {formatNumber(rows.length)}건 · 현재 응답 안에서 {page + 1}/{pageCount}페이지
          </span>
        ) : null}
      </div>
      <p className="routing-meta">
        최대 50건의 최근 응답입니다. 전체 건수나 팀별 범위를 확인한 결과가 아닙니다. 신뢰도는 확률이 아닌
        기록값입니다.
      </p>
      {report ? (
        <p className="routing-meta">
          마지막 목록 수신(한국 시각):{" "}
          <time dateTime={new Date(query.result.dataUpdatedAt).toISOString()}>
            {formatDateTime(query.result.dataUpdatedAt)}
          </time>
        </p>
      ) : null}
      {notice ? <InlineNotice tone="info">{notice}</InlineNotice> : null}
      {!query.automaticRead && !denied ? (
        <InlineNotice tone="info">
          이 조회에서는 자동 새로고침이 중지되어 있습니다. ‘결정 목록 다시 조회’로 최신 자료를 확인하세요.
        </InlineNotice>
      ) : null}
      {query.result.isFetching && report ? (
        <p role="status">
          목록을 다시 조회하는 동안 이전 결과를 표시합니다. 새 근거 선택은 잠시 사용할 수 없습니다.
        </p>
      ) : null}
      {query.result.isError ? (
        <InlineNotice
          tone="danger"
          title={denied ? "도메인 결정 로그를 볼 수 없습니다." : "최신 결정 목록을 확인하지 못했습니다."}
        >
          {denied
            ? domainDecisionDenied
            : report
              ? "이전 결과를 표시합니다. 결정 목록을 다시 조회하세요."
              : "결정 목록을 다시 조회하세요."}
          {requestId ? <p>요청 ID: {domainDecisionText(requestId, access.prefixes)}</p> : null}
        </InlineNotice>
      ) : null}
      {denied ? (
        <EmptyState title="표시할 수 없습니다." description={domainDecisionDenied} />
      ) : (
        <RowContext
          value={{
            access,
            ready: query.ready,
            open,
            register: (item, node) => {
              if (node) triggers.current.set(item.id, node);
              else triggers.current.delete(item.id);
            },
          }}
        >
          <DataTable
            caption="도메인 결정 로그"
            columns={columns}
            data={rows.slice(page * 20, (page + 1) * 20)}
            emptyMessage="결정 로그가 없습니다."
            error={query.result.isError && !report ? "결정 목록을 불러오지 못했습니다." : undefined}
            loading={query.result.isPending}
            getRowId={(_row, index) => String(index)}
            onRetry={refresh}
          />
        </RowContext>
      )}
      {!denied && pageCount > 1 ? (
        <nav className="domain-decision-pagination" aria-label="현재 결정 응답 페이지">
          <Button disabled={page === 0} onClick={() => setPagination({ report, page: page - 1 })}>
            이전 페이지
          </Button>
          <span aria-live="polite">
            {page + 1} / {pageCount}
          </span>
          <Button disabled={page >= pageCount - 1} onClick={() => setPagination({ report, page: page + 1 })}>
            다음 페이지
          </Button>
        </nav>
      ) : null}
      {selected && !denied ? (
        <DomainDecisionDialog
          access={access}
          source={selected.source}
          snapshot={selected.snapshot}
          query={query}
          onClose={close}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
    </>
  );
}
function Content({ access, window, route }: Props & { access: DomainDecisionsAccess }) {
  const [params, updateSearch] = useSearchState();
  const requestID = normalizeDomainDecisionRequestID(params.get("request_id") ?? "");
  const [draft, setDraft] = useState({ owner: requestID, value: requestID });
  const input = draft.owner === requestID ? draft.value : requestID;
  const [error, setError] = useState<string>();
  if (draft.owner !== requestID) {
    setDraft({ owner: requestID, value: requestID });
    setError(undefined);
  }
  const heading = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filters = useMemo<RoutingDomainDecisionsQuery>(
    () => ({
      window,
      ...(route === "" ? {} : { route }),
      ...(requestID === "" ? {} : { request_id: requestID }),
      limit: 50,
    }),
    [window, route, requestID],
  );
  const apply = () => {
    try {
      access.assertRead();
    } catch {
      return;
    }
    const value = normalizeDomainDecisionRequestID(input);
    const problem = containsPotentialSecret(value, access.prefixes)
      ? secretSearchMessage
      : domainDecisionRequestIDError(value);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setError(undefined);
    setDraft({ owner: value, value });
    updateSearch({ request_id: value || undefined });
  };
  return (
    <SectionCard
      className="domain-decisions-section"
      title={
        <span tabIndex={-1} ref={heading}>
          도메인 결정 로그
        </span>
      }
      description="요청을 찾아 당시 결정값과 함께 조회된 근거를 확인합니다. 조회만 하며 라우팅이나 검토 상태를 바꾸지 않습니다."
    >
      <form
        className="domain-decision-filter"
        aria-label="결정 로그 조회 조건"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="form-field">
          <span>요청 ID</span>
          <input
            ref={inputRef}
            className="input"
            value={input}
            placeholder="전체 요청"
            aria-invalid={Boolean(error)}
            aria-describedby="domain-decision-filter-help"
            onChange={(event) => {
              setDraft({ owner: requestID, value: event.target.value });
              setError(undefined);
            }}
          />
        </label>
        <Button type="submit">결정 로그 조회</Button>
      </form>
      <p id="domain-decision-filter-help" className="routing-meta">
        위 학습 구간·라우트 조건을 함께 사용합니다. 요청 ID는 이 결정 목록에만 정확히 일치하는 값으로
        적용됩니다. 비우고 조회하면 요청 ID 조건이 해제됩니다.
      </p>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <Results key={JSON.stringify(filters)} access={access} filters={filters} heading={heading} />
    </SectionCard>
  );
}
export function DomainDecisionsSection(props: Props) {
  const access = useDomainDecisionsAccess();
  return access.readable ? (
    <Content key={access.key} access={access} {...props} />
  ) : (
    <SectionCard title="도메인 결정 로그">
      <InlineNotice tone="info">{domainDecisionPermission}</InlineNotice>
    </SectionCard>
  );
}
