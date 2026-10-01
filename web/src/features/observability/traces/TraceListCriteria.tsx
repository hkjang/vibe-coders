import { useId } from "react";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import { flowDisplay } from "./trace-safe-flow-display";
import "./trace-list-criteria.css";

interface TraceListCriteriaProps {
  requested: AppRequestsQuery;
  displayed?: AppRequestsQuery;
  prefixes: readonly string[];
  pending: boolean;
  failed: boolean;
}

function statusLabel(status: AppRequestsQuery["status"]): string {
  switch (status) {
    case undefined:
    case "":
      return "전체";
    case "success":
      return "성공 (HTTP 2xx·3xx)";
    case "error":
      return "오류 (HTTP 4xx·5xx)";
    case "4xx":
      return "HTTP 4xx";
    case "5xx":
      return "HTTP 5xx";
    default:
      return `HTTP ${status}`;
  }
}

function CriteriaValues({ query, prefixes }: { query: AppRequestsQuery; prefixes: readonly string[] }) {
  const values = [
    ["추적 ID", query.trace_id || "지정하지 않음"],
    ["시작 시각", query.from || "지정하지 않음"],
    ["종료 시각", query.to || "지정하지 않음"],
    ["상태", statusLabel(query.status)],
    ["모델", query.model || "지정하지 않음"],
    ["페이지당 최대 건수", query.limit === undefined ? "기본값 (50건)" : `${query.limit}건`],
    ["시간대", query.tz || "기본값 (Asia/Seoul)"],
    ["페이지 위치", query.cursor ? "이동한 페이지" : "첫 페이지"],
  ] as const;
  return (
    <dl>
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{flowDisplay(value, prefixes)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TraceListCriteria({
  requested,
  displayed,
  prefixes,
  pending,
  failed,
}: TraceListCriteriaProps) {
  const id = useId();
  const notice = pending
    ? displayed
      ? "현재 목록을 확인하는 동안 이전 결과를 표시합니다."
      : "현재 조회 기준의 결과를 확인하고 있습니다."
    : failed
      ? displayed
        ? "현재 조회에 실패해 마지막 정상 결과를 표시합니다."
        : "현재 조회 기준의 결과를 확인하지 못했습니다."
      : displayed
        ? "표시 중인 결과의 조회 기준을 확인하세요."
        : "아직 확인된 결과가 없습니다.";
  return (
    <section className="trace-list-criteria" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>추적 조회 기준</h2>
      <p>클라이언트가 전송한 조회 기준입니다. 서버의 정규화 결과를 뜻하지 않습니다.</p>
      <p role="status" aria-live="polite" aria-atomic="true">
        {notice}
      </p>
      <div className="trace-list-criteria-columns">
        <section aria-labelledby={`${id}-requested`}>
          <h3 id={`${id}-requested`}>요청한 조회 기준</h3>
          <CriteriaValues query={requested} prefixes={prefixes} />
        </section>
        <section aria-labelledby={`${id}-displayed`}>
          <h3 id={`${id}-displayed`}>표시 중인 결과의 조회 기준</h3>
          {displayed ? (
            <CriteriaValues query={displayed} prefixes={prefixes} />
          ) : (
            <p>표시할 응답의 조회 기준이 아직 확인되지 않았습니다.</p>
          )}
        </section>
      </div>
      <p>요약·시간축·표는 수신한 현재 페이지(최대 200건) 기준이며 전체 추적의 집계가 아닙니다.</p>
    </section>
  );
}
