import { Activity } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { DynamicRouteGraph } from "@/shared/api/domains/routing-dynamic";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

import { elementTitle, outcomeLabel } from "./dynamic-route-model";
import { useDynamicRouteActivity } from "./use-dynamic-routes";

const ranges = [
  { value: "1", label: "최근 1시간" },
  { value: "24", label: "최근 24시간" },
  { value: "168", label: "최근 7일" },
];

/** What the deployed route actually did: where traffic ended, which limits are filling up, and the newest requests. */
export function DynamicRouteActivityPanel({
  routeId,
  graph,
}: {
  routeId: string;
  graph: DynamicRouteGraph | undefined;
}): React.JSX.Element {
  const [hours, setHours] = useState(24);
  const activity = useDynamicRouteActivity(routeId, hours, true);
  const titleOf = (id: string): string => {
    const element = graph?.elements.find((item) => item.id === id);
    return element ? elementTitle(element) : id || "없음";
  };
  const limitOf = (id: string): number | undefined =>
    graph?.elements.find((item) => item.id === id)?.properties.limit;
  const data = activity.data;
  const total = data?.traffic.reduce((sum, row) => sum + row.requests, 0) ?? 0;
  const failed =
    data?.traffic.filter((row) => row.outcome !== "success").reduce((sum, row) => sum + row.requests, 0) ?? 0;
  const fallbacks = data?.traffic.reduce((sum, row) => sum + row.fallbacks, 0) ?? 0;
  const cost = data?.traffic.reduce((sum, row) => sum + row.cost_krw, 0) ?? 0;

  return (
    <div className="dr-activity">
      <div className="dr-toolbar">
        <label className="dr-inline-label">
          기간{" "}
          <Select
            value={String(hours)}
            options={ranges}
            onChange={(event) => setHours(Number(event.target.value))}
            aria-label="트래픽 기간"
          />
        </label>
        <span className="dr-muted">15초마다 새로 고칩니다.</span>
      </div>
      {activity.isError ? (
        <InlineNotice tone="danger" title="트래픽을 불러오지 못했습니다.">
          {safeAppErrorMessage(activity.error, "잠시 후 다시 시도하세요.")}
        </InlineNotice>
      ) : null}
      <StatGrid label="경로 트래픽 요약">
        <StatCard label="요청" value={formatNumber(total)} />
        <StatCard label="실패·거절" value={formatNumber(failed)} tone={failed > 0 ? "warning" : "default"} />
        <StatCard label="폴백" value={formatNumber(fallbacks)} hint="다음 모델로 넘어간 횟수" />
        <StatCard label="비용" value={formatKRW(cost)} />
      </StatGrid>

      <SectionCard title="어디서 끝났나" description="버전·마지막 요소·결과별 요청 수입니다.">
        {data && data.traffic.length === 0 ? (
          <EmptyState icon={<Activity aria-hidden="true" />} title="이 기간에 처리한 요청이 없습니다." />
        ) : null}
        {data && data.traffic.length > 0 ? (
          <ul className="dr-dist-list">
            {data.traffic.map((row) => (
              <li key={`${row.version}:${row.final_element_id}:${row.outcome}`}>
                <span className="dr-dist-label">
                  v{row.version} · {titleOf(row.final_element_id)}
                  {row.final_model ? <code>{row.final_model}</code> : null}
                  {row.outcome !== "success" ? (
                    <Badge tone="danger">{outcomeLabel(row.outcome)}</Badge>
                  ) : null}
                </span>
                <span className="dr-dist-bar" aria-hidden="true">
                  <span
                    style={{ width: `${total > 0 ? Math.round((row.requests / total) * 1000) / 10 : 0}%` }}
                  />
                </span>
                <span className="dr-dist-value">
                  {formatNumber(row.requests)}건 · 평균 {formatNumber(row.avg_latency_ms)}ms
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      <SectionCard
        title="열려 있는 한도 구간"
        description="아직 끝나지 않은 집계 구간입니다. 키 값은 해시로만 저장되어 보이지 않습니다."
      >
        {data && data.limits.length === 0 ? <p className="dr-hint">열려 있는 한도 구간이 없습니다.</p> : null}
        {data && data.limits.length > 0 ? (
          <div className="data-table-scroll" tabIndex={0} aria-label="한도 구간 표 영역">
            <table className="data-table">
              <caption className="sr-only">한도 요소별 사용량</caption>
              <thead>
                <tr>
                  <th scope="col">한도 요소</th>
                  <th scope="col">범위</th>
                  <th scope="col">사용</th>
                  <th scope="col">구간</th>
                </tr>
              </thead>
              <tbody>
                {data.limits.map((limit, index) => {
                  const cap = limitOf(limit.element_id);
                  return (
                    <tr key={`${limit.element_id}:${limit.window_start}:${index}`}>
                      <th scope="row">{titleOf(limit.element_id)}</th>
                      <td>{limit.scoped ? "키 값 하나" : "공유 한도"}</td>
                      <td>
                        {formatNumber(limit.request_count)}회 · {formatKRW(limit.cost_krw)}
                        {cap ? <span className="dr-muted"> / 한도 {formatNumber(cap)}</span> : null}
                      </td>
                      <td>
                        <time dateTime={limit.window_start}>{formatDateTime(limit.window_start)}</time> ~{" "}
                        <time dateTime={limit.window_end}>{formatDateTime(limit.window_end)}</time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="최근 요청" description="최신 50건입니다. 메타데이터 값은 저장할 때 마스킹됩니다.">
        {data && data.requests.length === 0 ? <p className="dr-hint">아직 요청이 없습니다.</p> : null}
        {data && data.requests.length > 0 ? (
          <div className="data-table-scroll" tabIndex={0} aria-label="최근 요청 표 영역">
            <table className="data-table">
              <caption className="sr-only">동적 경로를 거친 최근 요청</caption>
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">경로</th>
                  <th scope="col">응답 모델</th>
                  <th scope="col">상태</th>
                  <th scope="col">지연·비용</th>
                  <th scope="col">
                    <span className="sr-only">입출력</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((request) => (
                  <tr key={request.request_id}>
                    <td>
                      <time dateTime={request.created_at}>{formatDateTime(request.created_at)}</time>
                      <br />
                      <span className="dr-muted">v{request.version}</span>
                    </td>
                    <td>
                      <ol className="dr-path dr-path-inline" aria-label="지나간 경로">
                        {request.steps.map((step, index) => (
                          <li key={`${step.id}:${index}`} className={`dr-path-step dr-path-${step.outcome}`}>
                            <span className="dr-path-id">{titleOf(step.id)}</span>
                            <span className="dr-path-outcome">{outcomeLabel(step.outcome)}</span>
                          </li>
                        ))}
                      </ol>
                      {Object.keys(request.metadata).length > 0 ? (
                        <code className="dr-meta">{JSON.stringify(request.metadata)}</code>
                      ) : null}
                    </td>
                    <td>
                      {request.final_model ? <code>{request.final_model}</code> : "없음"}
                      {request.final_provider ? (
                        <span className="dr-muted"> · {request.final_provider}</span>
                      ) : null}
                    </td>
                    <td>
                      <Badge
                        tone={
                          request.status_code >= 400 || request.outcome !== "success" ? "danger" : "success"
                        }
                      >
                        {request.status_code || "-"}
                      </Badge>{" "}
                      {request.outcome !== "success" ? outcomeLabel(request.outcome) : null}
                      {request.fallbacks > 0 ? (
                        <span className="dr-muted"> · 폴백 {request.fallbacks}</span>
                      ) : null}
                    </td>
                    <td>
                      {formatNumber(request.latency_ms)}ms
                      <br />
                      <span className="dr-muted">{formatKRW(request.cost_krw)}</span>
                    </td>
                    <td>
                      <Link
                        className="button button-ghost button-small"
                        to={{
                          pathname: "/observability/io",
                          search: new URLSearchParams({ request_id: request.request_id }).toString(),
                        }}
                      >
                        입출력
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
