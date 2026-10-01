import { createContext, useContext, useRef, useState } from "react";
import type { RoutingLearningRecommendation } from "@/shared/api/domains/routing-learning";
import { AppError, isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";
import { LearningRecommendationDialog } from "./LearningRecommendationDialog";
import {
  useLearningRecommendationAccess,
  type LearningRecommendationAccess,
} from "./learning-recommendation-access";
import type { RecommendationReview } from "./learning-recommendation-operation";
import { useLearningRecommendationQuery } from "./learning-recommendation-query";
import {
  buildRecommendation,
  currentRecommendation,
  learningBucketLabel,
  learningText,
  learningWindowLabels,
  recommendationChanged,
  recommendationProblem,
  recommendationSource,
  type LearningWindow,
  type RecommendationSource,
} from "./learning-recommendation-state";

interface Props {
  canWrite: boolean;
  window: LearningWindow;
  pendingReviews: number | undefined;
}
interface Selection {
  active: boolean;
  serial: number;
  source: RecommendationSource;
  review: RecommendationReview;
}
interface RowActions {
  access: LearningRecommendationAccess;
  ready: boolean;
  open: (item: RoutingLearningRecommendation, trigger: HTMLButtonElement) => void;
  register: (item: RoutingLearningRecommendation, node: HTMLButtonElement | null) => void;
}
const RowContext = createContext<RowActions | undefined>(undefined);
function RecommendationCell({
  item,
  field,
}: {
  item: RoutingLearningRecommendation;
  field: "task" | "bucket" | "top" | "model" | "actions";
}) {
  const context = useContext(RowContext);
  if (!context) return null;
  const { access, ready, open, register } = context;
  const text = (value: string) => learningText(value, access.prefixes);
  if (field === "task") return text(item.task_type);
  if (field === "bucket")
    return <Badge tone="info">{learningBucketLabel(item.bucket, access.prefixes)}</Badge>;
  if (field === "top")
    return (
      <span>
        {text(item.top_model)} ({formatPercent(item.top_success_rate)})
      </span>
    );
  if (field === "model")
    return (
      <span>
        {text(item.recommended_model)} ({formatPercent(item.success_rate)})
      </span>
    );
  const problem = recommendationProblem(item, access.prefixes);
  return item.differs ? (
    <div>
      <Button
        size="small"
        variant="ghost"
        aria-label={`${text(item.recommended_model)} 추천을 규칙으로 적용`}
        disabled={!access.write.allowed || Boolean(problem)}
        aria-disabled={!ready}
        ref={(node) => register(item, node)}
        title={problem ?? access.write.reason}
        onClick={(event) => open(item, event.currentTarget)}
      >
        규칙 적용
      </Button>
      {problem ? <p className="routing-meta">{problem}</p> : null}
    </div>
  ) : (
    <span className="routing-meta">관측 최다 모델과 동일</span>
  );
}
const column = createDataTableColumnHelper<RoutingLearningRecommendation>();
// Stable cell component identities preserve the row button through query
// notifications; context supplies current guarded callbacks without remounting it.
const columns = column.columns([
  column.display({
    id: "task_type",
    header: "관측 작업 유형",
    cell: ({ row }) => <RecommendationCell item={row.original} field="task" />,
  }),
  column.display({
    id: "bucket",
    header: "복잡도 구간",
    cell: ({ row }) => <RecommendationCell item={row.original} field="bucket" />,
  }),
  column.display({
    id: "top_model",
    header: "관측 최다 모델",
    cell: ({ row }) => <RecommendationCell item={row.original} field="top" />,
  }),
  column.display({
    id: "recommended_model",
    header: "추천 모델",
    cell: ({ row }) => <RecommendationCell item={row.original} field="model" />,
  }),
  column.accessor((row) => row.avg_cost_krw, {
    id: "cost",
    header: "평균 비용",
    cell: ({ getValue }) => formatKRW(getValue()),
  }),
  column.accessor((row) => row.samples, {
    id: "samples",
    header: "추천 모델 표본",
    cell: ({ row, getValue }) => (
      <span>
        {formatNumber(getValue())}건
        {!row.original.confident ? <small> · 일부 비교 모델은 최소 표본 미달</small> : null}
      </span>
    ),
  }),
  column.display({
    id: "actions",
    header: "작업",
    cell: ({ row }) => <RecommendationCell item={row.original} field="actions" />,
  }),
]);
function Content({
  access,
  window,
  pendingReviews,
}: Omit<Props, "canWrite"> & { access: LearningRecommendationAccess }) {
  const query = useLearningRecommendationQuery(window, access);
  const [selected, setSelected] = useState<Selection>();
  const selection = useRef<Selection | undefined>(undefined);
  const serial = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const triggers = useRef(new Map<RoutingLearningRecommendation, HTMLButtonElement>());
  const [notice, setNotice] = useState<string>();
  const text = (value: string | number, empty?: string) => learningText(value, access.prefixes, empty);
  const rows = query.result.data?.recommendations ?? [];
  const open = (item: RoutingLearningRecommendation, trigger: HTMLButtonElement) => {
    try {
      access.assertApproval(access.approval);
      const snapshot = query.capture(item);
      const body = buildRecommendation(item, access.prefixes);
      if (selection.current) selection.current.active = false;
      const next: Selection = {
        active: true,
        serial: ++serial.current,
        source: recommendationSource(window, snapshot.data, item),
        review: Object.freeze({ snapshot, body, approval: access.approval }),
      };
      selection.current = next;
      returnFocusRef.current = trigger;
      setSelected(next);
      setNotice(undefined);
    } catch {
      setNotice(recommendationChanged);
    }
  };
  const close = () => {
    const old = selection.current;
    if (old) old.active = false;
    const row = old && query.result.data && currentRecommendation(old.source, query.result.data);
    returnFocusRef.current = (row && triggers.current.get(row)) || heading.current;
    selection.current = undefined;
    setSelected(undefined);
  };
  const requestId = isAppError(query.result.error) ? query.result.error.requestId : undefined;
  return (
    <div className="learning-recommendation-section">
      <h2 tabIndex={-1} ref={heading}>
        학습 추천 조회
      </h2>
      <section aria-label="추천 조회 기준">
        <p>요청한 조회 기간: {learningWindowLabels[window]}</p>
        {query.result.data ? (
          <p>
            서버 응답의 집계 시작 시각: {text(formatDateTime(query.result.data.since))}. 요청 기간과 응답
            시각은 별도의 기준입니다.
          </p>
        ) : null}
        <p>
          관측 표본의 비교 결과이며, 현재 사용 중인 라우팅 규칙 목록이나 전체 적용 영향을 검증한 결과는
          아닙니다.
        </p>
        <Button
          aria-disabled={query.result.isFetching}
          aria-busy={query.result.isFetching}
          onClick={query.refresh}
        >
          추천 다시 조회
        </Button>
      </section>
      {notice ? <InlineNotice tone="warning">{notice}</InlineNotice> : null}
      {query.result.isFetching && query.result.data ? (
        <p role="status">
          추천을 다시 조회하는 동안 이전 결과를 표시합니다. 새로운 검토는 잠시 사용할 수 없습니다.
        </p>
      ) : null}
      {query.result.isError ? (
        <InlineNotice tone="warning" title="최신 추천을 확인하지 못했습니다.">
          {query.result.data
            ? "이전 결과를 표시합니다. 추천을 다시 조회한 뒤 검토하세요."
            : "추천을 불러오지 못했습니다. 추천을 다시 조회하세요."}
          {requestId ? <p>요청 ID: {text(requestId)}</p> : null}
        </InlineNotice>
      ) : null}
      <StatGrid label="학습 요약">
        <StatCard
          label="학습 셀"
          value={query.result.data ? formatNumber(query.result.data.cells.length) : "—"}
        />
        <StatCard label="추천" value={query.result.data ? formatNumber(rows.length) : "—"} />
        <StatCard
          label="최소 표본"
          value={query.result.data ? formatNumber(query.result.data.min_samples) : "—"}
        />
        <StatCard
          label="검토 대기"
          tone={(pendingReviews ?? 0) > 0 ? "warning" : "default"}
          value={pendingReviews === undefined ? "—" : formatNumber(pendingReviews)}
        />
      </StatGrid>
      <SectionCard
        title="모델 추천 학습"
        description="작업 유형과 복잡도별 관측 성공률·비용을 비교한 추천입니다. 작업 유형은 생성할 규칙의 적용 조건이 아닙니다."
      >
        <RowContext
          value={{
            access,
            ready: query.ready,
            open,
            register: (item, node) => {
              if (node) triggers.current.set(item, node);
              else triggers.current.delete(item);
            },
          }}
        >
          <DataTable
            caption="학습된 모델 추천"
            columns={columns}
            data={rows}
            emptyMessage="이 응답에는 표본 기준을 충족한 추천이 없습니다."
            error={
              query.result.isError && !query.result.data ? "학습 리포트를 불러오지 못했습니다." : undefined
            }
            getRowId={(_row, index) => String(index)}
            loading={query.result.isPending}
            onRetry={query.refresh}
          />
        </RowContext>
      </SectionCard>
      {selected ? (
        <LearningRecommendationDialog
          key={selected.serial}
          access={access}
          query={query}
          source={selected.source}
          initialReview={selected.review}
          returnFocusRef={returnFocusRef}
          onClose={close}
          assertSelected={() => {
            query.assertRead();
            if (!selected.active || selection.current !== selected)
              throw new AppError("종료된 추천 검토입니다.", { kind: "aborted" });
          }}
        />
      ) : null}
    </div>
  );
}
export function LearningRecommendationSection({ canWrite, ...props }: Props) {
  const access = useLearningRecommendationAccess(canWrite);
  return access.readable ? (
    <Content key={`${access.key}:${props.window}`} access={access} {...props} />
  ) : (
    <InlineNotice tone="warning" title="학습 추천 조회 권한을 확인하세요.">
      현재 라우팅 화면의 routing:read 권한이 필요합니다.
    </InlineNotice>
  );
}
