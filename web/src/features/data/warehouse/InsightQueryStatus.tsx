import { DataQueryNotice } from "@/features/data/DataQueryNotice";
import type { InsightQuery } from "./use-insight-query";

export function InsightQueryStatus({
  query,
  label,
}: {
  query: InsightQuery<unknown>;
  label: string;
}): React.JSX.Element {
  return (
    <>
      {query.isError ? (
        <DataQueryNotice
          error={query.error}
          hasPreviousData={query.data !== undefined}
          label={label}
          onRetry={query.refetch}
        />
      ) : null}
      <p className="data-updated-at" role="status" aria-label={`${label} 갱신 상태`}>
        {query.isFetching ? (query.data === undefined ? "조회 중 · " : "이전 데이터 표시 · 갱신 중 · ") : ""}
        마지막 정상 갱신:{" "}
        {query.dataUpdatedAt ? (
          <time
            dateTime={new Date(query.dataUpdatedAt).toISOString()}
            title={new Date(query.dataUpdatedAt).toLocaleString("ko-KR")}
          >
            {new Date(query.dataUpdatedAt).toLocaleTimeString("ko-KR")}
          </time>
        ) : (
          "—"
        )}
      </p>
    </>
  );
}
