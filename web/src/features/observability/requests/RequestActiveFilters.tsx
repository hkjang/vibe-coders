import { X } from "lucide-react";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import { Button } from "@/shared/components/ui/Button";
import { defaultLimit, defaultTimeZone } from "./request-page-query";
import { requestFilterSummary, type RequestFilterKey } from "./request-filter-summary";

export function RequestActiveFilters({
  query,
  credentialPrefixes,
  current,
  onRemove,
}: {
  query: AppRequestsQuery;
  credentialPrefixes: readonly string[];
  current: boolean;
  onRemove: (key: RequestFilterKey) => void;
}) {
  const entries = requestFilterSummary(query, credentialPrefixes);
  return (
    <section className="request-active-filters" aria-label="요청 조회 조건">
      <div className="request-active-heading">
        <strong>
          {current ? "적용 중인 조건" : "조회 요청 조건"} {entries.length}개
        </strong>
        <span>
          표시 시간대 {query.tz ?? defaultTimeZone} · 페이지당 {query.limit ?? defaultLimit}건
        </span>
      </div>
      {entries.length ? (
        <>
          <ul className="request-active-list">
            {entries.map((entry) => (
              <li key={entry.key}>
                <span className="request-active-label">{entry.label}</span>
                <span className="request-active-value" title={entry.value}>
                  {entry.value}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`${entry.label} 필터 해제`}
                  onClick={() => onRemove(entry.key)}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <p>조건을 해제하면 입력 중인 변경을 취소하고 첫 페이지부터 다시 조회합니다.</p>
        </>
      ) : (
        <p>별도 조건 없이 최근 요청을 조회합니다. 입력한 조건은 조회 버튼을 눌러 적용하세요.</p>
      )}
    </section>
  );
}
