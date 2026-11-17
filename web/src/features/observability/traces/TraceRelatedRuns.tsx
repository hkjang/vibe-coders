import { versionAtLeast } from "@/config/migration-registry";
import { useId } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import type { TraceRelatedRunsQuery } from "@/shared/api/domains/trace-related-runs.schema";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Select } from "@/shared/components/ui/Select";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { ErrorState } from "@/shared/components/state/PageStates";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { relatedRunsCriteria, relatedRunsSearch } from "./related-runs-state";
import { useRelatedRuns } from "./use-related-runs";
import { RelatedRunTable } from "./RelatedRunTable";

export function TraceRelatedRuns() {
  const [search, setSearch] = useSearchParams();
  const auth = useAuth();
  const criteria = relatedRunsCriteria(search, auth.credentialPrefixes);
  const marker = JSON.stringify(criteria);
  const owner = useFeatureReadOwner("observability.traces", `trace-related:${marker}`);
  if (
    criteria.state === "absent" ||
    !auth.backendVersion ||
    !versionAtLeast(auth.backendVersion, "v0.86.152")
  )
    return null;
  if (!owner.readable || owner.denied)
    return (
      <InlineNotice
        tone="danger"
        title="연관 실행 조회 권한 확인 필요"
        actions={
          owner.readable ? (
            <Button onClick={owner.restart}>권한 확인 후 연관 실행 다시 조회</Button>
          ) : undefined
        }
      >
        이전 연관 실행 기록을 닫았습니다. 관리자에게 현재 화면과 팀 조회 권한을 확인해 달라고 요청하세요.
      </InlineNotice>
    );
  if (criteria.state === "invalid")
    return (
      <InlineNotice tone="warning" title="연관 실행 조회 주소를 확인하세요.">
        유효한 추적 ID 하나와 실행 종류, 페이지 위치를 지정하세요.
        <Button
          variant="secondary"
          onClick={() => {
            const next = new URLSearchParams(search);
            ["related_kind", "related_limit", "related_offset"].forEach((key) => next.delete(key));
            setSearch(next);
          }}
        >
          연관 실행 페이지 초기화
        </Button>
      </InlineNotice>
    );
  return <RelatedRunsContent traceId={criteria.traceId} query={criteria.query} owner={owner} />;
}
function RelatedRunsContent({
  traceId,
  query,
  owner,
}: {
  traceId: string;
  query: TraceRelatedRunsQuery;
  owner: FeatureReadOwner;
}) {
  const [search, setSearch] = useSearchParams();
  const headingId = useId();
  const kindId = useId();
  const limitId = useId();
  const result = useRelatedRuns(traceId, query, owner);
  const page = result.isError ? undefined : result.data;
  const update = (changes: Partial<TraceRelatedRunsQuery>) => {
    if (owner.isCurrent()) setSearch(relatedRunsSearch(search, changes));
  };
  const retry = () => {
    if (owner.isCurrent() && !result.isFetching) void result.refetch({ cancelRefetch: false });
  };
  return (
    <section className="trace-panel trace-related" aria-labelledby={headingId}>
      <div className="trace-panel-header">
        <div>
          <h2 id={headingId}>연관 실행</h2>
          <p>같은 추적 ID의 전체 기간 실행입니다. 요청 목록의 기간·상태·모델 필터는 적용되지 않습니다.</p>
          <p>최신 기록부터 표시하며, 각 페이지 조회 시점에 따라 결과가 바뀔 수 있습니다.</p>
        </div>
        <Button variant="secondary" disabled={result.isFetching} onClick={retry}>
          연관 실행 새로고침
        </Button>
      </div>
      <div className="trace-related-controls">
        <label htmlFor={kindId}>
          실행 종류
          <Select
            id={kindId}
            value={query.kind}
            onChange={(event) => update({ kind: event.target.value as "workflow" | "app", offset: 0 })}
          >
            <option value="workflow">워크플로</option>
            <option value="app">앱</option>
          </Select>
        </label>
        <label htmlFor={limitId}>
          페이지당 실행 수
          <Select
            id={limitId}
            value={query.limit}
            onChange={(event) => update({ limit: Number(event.target.value) as 25 | 50 | 100, offset: 0 })}
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}개
              </option>
            ))}
          </Select>
        </label>
      </div>
      {result.isError ? (
        <ErrorState
          title="연관 실행을 불러오지 못했습니다."
          message="조회 권한과 서버 버전을 확인한 뒤 다시 시도하세요. 연관 실행 조회는 v0.86.152 이상에서 지원합니다."
          requestId={isAppError(result.error) ? result.error.requestId : undefined}
          onRetry={retry}
          showLegacy={false}
        />
      ) : (
        <>
          <p role="status">
            {page
              ? `조회 가능한 실행 ${page.total.toLocaleString("ko-KR")}개 · 현재 ${page.items.length.toLocaleString("ko-KR")}개 표시`
              : "연관 실행을 불러오는 중입니다."}
          </p>
          <RelatedRunTable kind={query.kind} rows={page?.items ?? []} loading={result.isPending} />
          <nav className="trace-pagination" aria-label="연관 실행 페이지">
            <Button
              variant="secondary"
              disabled={result.isFetching || query.offset === 0}
              onClick={() => update({ offset: 0 })}
            >
              처음
            </Button>
            <Button
              variant="secondary"
              disabled={result.isFetching || query.offset === 0}
              onClick={() => update({ offset: Math.max(0, query.offset - query.limit) })}
            >
              이전 실행
            </Button>
            <span>{query.offset / query.limit + 1}페이지</span>
            <Button
              variant="secondary"
              disabled={
                result.isFetching ||
                !page ||
                query.offset + query.limit >= page.total ||
                query.offset + query.limit > 1_000_000
              }
              onClick={() => update({ offset: query.offset + query.limit })}
            >
              다음 실행
            </Button>
          </nav>
          {page && query.offset + query.limit > 1_000_000 && query.offset + query.limit < page.total ? (
            <InlineNotice>조회 가능한 페이지 범위에 도달했습니다.</InlineNotice>
          ) : null}
        </>
      )}
      <p className="trace-related-help">
        정의 보기는 현재 설정을 엽니다. 내 실행 영수증은 본인 실행과 대상 화면 권한이 모두 확인될 때
        제공됩니다.
      </p>
    </section>
  );
}
