import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { useId, useState } from "react";

import { TimeSeriesChart } from "@/features/observability/charts";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDuration, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

interface WaterfallPanelProps {
  onSessionChange: (sessionId: string) => void;
  sessionId: string;
}

function categoryTone(category: string): "danger" | "info" | "muted" | "success" | "warning" {
  if (category === "error") return "danger";
  if (category === "fallback") return "warning";
  if (category === "cache") return "info";
  if (category === "complex") return "warning";
  return "success";
}

const sessionPageSize = 25;

/** Session transaction waterfall (GET /admin/waterfall?session_id=). */
export function WaterfallPanel({ onSessionChange, sessionId }: WaterfallPanelProps): React.JSX.Element {
  const inputId = useId();
  const slowId = useId();
  const [draft, setDraft] = useState(sessionId);
  const [slowMs, setSlowMs] = useState("");

  const [page, setPage] = useState(0);
  const sessions = useQuery({
    queryKey: ["observability", "xview", "waterfall-sessions", page],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.sessions, {
        query: { limit: sessionPageSize, offset: page * sessionPageSize },
        signal,
        routeId: "observability.xview.waterfall-sessions",
      }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const costTimeline = useQuery({
    queryKey: ["observability", "xview", "session-timeline", sessionId],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.sessionTimeline, {
        query: { session_id: sessionId, limit: 500 },
        signal,
        routeId: "observability.xview.session-timeline",
      }),
    enabled: sessionId !== "",
    staleTime: 30_000,
  });

  const waterfall = useQuery({
    queryKey: ["observability", "xview", "waterfall", sessionId, slowMs],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.xview.waterfall, {
        query: {
          session_id: sessionId,
          limit: 500,
          ...(Number(slowMs) > 0 ? { slow_ms: Number(slowMs) } : {}),
        },
        signal,
        routeId: "observability.xview.waterfall",
      }),
    enabled: sessionId !== "",
    staleTime: 30_000,
  });

  const trace = waterfall.data;
  const wall = Math.max(1, trace?.wall_ms ?? 1);

  const exportCsv = (): void => {
    if (!trace) return;
    downloadCsv(
      `waterfall-${trace.session_id || "session"}.csv`,
      toCsv(trace.spans, [
        { header: "seq", value: (row) => row.seq },
        { header: "request_id", value: (row) => row.request_id },
        { header: "model", value: (row) => row.model },
        { header: "provider", value: (row) => row.provider },
        { header: "endpoint", value: (row) => row.endpoint },
        { header: "status_code", value: (row) => row.status_code },
        { header: "start_offset_ms", value: (row) => row.start_offset_ms },
        { header: "ttfb_ms", value: (row) => row.ttfb_ms },
        { header: "total_ms", value: (row) => row.total_ms },
        { header: "gap_before_ms", value: (row) => row.gap_before_ms },
        { header: "category", value: (row) => row.category },
        { header: "total_tokens", value: (row) => row.total_tokens },
        { header: "cost_krw", value: (row) => row.cost_krw },
      ]),
    );
  };

  return (
    <div className="obs-section-stack">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSessionChange(draft.trim());
        }}
      >
        <Toolbar
          label="세션 워터폴 조회"
          end={
            <Button type="submit" variant="primary">
              <Search aria-hidden="true" /> 조회
            </Button>
          }
        >
          <label htmlFor={inputId}>
            세션 ID
            <Input
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="세션 ID를 입력하세요"
            />
          </label>
          <label htmlFor={slowId}>
            느림 기준(ms)
            <Input
              id={slowId}
              type="number"
              min={0}
              value={slowMs}
              onChange={(event) => setSlowMs(event.target.value)}
              placeholder="자동"
            />
          </label>
        </Toolbar>
      </form>

      <SectionCard title="최근 세션" description="세션을 선택하면 그 세션의 요청 타임라인이 아래에 열립니다.">
        {sessions.isError ? (
          <InlineNotice tone="warning" title="세션 목록을 불러오지 못했습니다.">
            {safeAppErrorMessage(sessions.error, "세션 목록을 불러오지 못했습니다.")}
            {isAppError(sessions.error) && sessions.error.requestId ? (
              <span className="request-id"> 요청 ID: {sessions.error.requestId}</span>
            ) : null}
          </InlineNotice>
        ) : null}
        {!sessions.isPending && (sessions.data?.sessions ?? []).length === 0 ? (
          <EmptyState
            title="표시할 세션이 없습니다."
            description="개발도구가 session_id와 함께 요청을 보내면 세션이 만들어집니다."
          />
        ) : (
          <>
            <div className="data-table-scroll" tabIndex={0} aria-label="최근 세션 표 영역">
              <table className="data-table">
                <caption className="sr-only">워터폴을 열 수 있는 최근 세션</caption>
                <thead>
                  <tr>
                    <th scope="col">세션 ID</th>
                    <th scope="col">마지막 메시지</th>
                    <th scope="col">요청</th>
                    <th scope="col">토큰</th>
                    <th scope="col">비용</th>
                    <th scope="col">오류</th>
                    <th scope="col">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {(sessions.data?.sessions ?? []).map((session) => (
                    <tr key={session.session_id}>
                      <th scope="row" className="mono truncate">
                        {session.session_id || "—"}
                      </th>
                      <td className="truncate">{session.last_message || "—"}</td>
                      <td className="cell-number">{formatNumber(session.requests)}</td>
                      <td className="cell-number">{formatNumber(session.tokens)}</td>
                      <td className="cell-number">{formatKRW(session.cost_krw)}</td>
                      <td className="cell-number">{formatNumber(session.errors)}</td>
                      <td>
                        <Button
                          size="small"
                          aria-label={`${session.session_id} 워터폴 열기`}
                          onClick={() => {
                            setDraft(session.session_id);
                            onSessionChange(session.session_id);
                          }}
                        >
                          보기
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="data-table-pagination" aria-label="최근 세션 페이지">
              <Button size="small" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>
                이전
              </Button>
              <span aria-live="polite">{page + 1} 페이지</span>
              <Button
                size="small"
                disabled={!(sessions.data?.page.has_more ?? false)}
                onClick={() => setPage((current) => current + 1)}
              >
                다음
              </Button>
            </nav>
          </>
        )}
      </SectionCard>

      {sessionId === "" ? (
        <EmptyState
          title="세션을 선택하세요."
          description="위 목록에서 세션을 고르거나 세션 ID를 입력하면 이 세션의 요청 타임라인을 볼 수 있습니다."
        />
      ) : waterfall.isPending ? (
        <div role="status" aria-live="polite">
          워터폴을 불러오는 중입니다.
        </div>
      ) : waterfall.isError || !trace ? (
        <InlineNotice
          tone="danger"
          title="워터폴을 불러오지 못했습니다."
          actions={
            <Button size="small" onClick={() => void waterfall.refetch()}>
              다시 시도
            </Button>
          }
        >
          {safeAppErrorMessage(waterfall.error, "워터폴을 불러오지 못했습니다.")}
          {isAppError(waterfall.error) && waterfall.error.requestId ? (
            <span className="request-id"> 요청 ID: {waterfall.error.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : (
        <>
          <StatGrid label="세션 타이밍">
            <StatCard label="요청" value={formatNumber(trace.requests)} />
            <StatCard label="전체 소요" value={formatDuration(trace.wall_ms)} />
            <StatCard
              label="업스트림 사용"
              value={formatDuration(trace.busy_ms)}
              hint={formatPercent(trace.busy_ratio)}
            />
            <StatCard label="대기(유휴)" value={formatDuration(trace.idle_ms)} />
            <StatCard
              label="느린 요청"
              value={formatNumber(trace.slow_count)}
              tone={trace.slow_count > 0 ? "warning" : "default"}
              hint={`기준 ${formatDuration(trace.slow_ms)}`}
            />
            <StatCard label="누적 비용" value={formatKRW(trace.total_cost_krw)} />
          </StatGrid>

          {trace.truncated ? (
            <InlineNotice tone="warning" title="일부 요청만 표시했습니다.">
              세션 요청이 상한(500건)을 넘어 최근 구간만 계산했습니다.
            </InlineNotice>
          ) : null}

          <InlineNotice tone="info" title="병목 분석">
            가장 느린 요청은 #{formatNumber(trace.bottleneck.slowest_seq)} ·{" "}
            {formatDuration(trace.bottleneck.slowest_ms)} (전체의 {trace.bottleneck.slowest_pct.toFixed(1)}%),
            가장 긴 대기는 #{formatNumber(trace.bottleneck.longest_gap_seq)} 앞의{" "}
            {formatDuration(trace.bottleneck.longest_gap_ms)} 입니다.
          </InlineNotice>

          <SectionCard
            title="요청 타임라인"
            description="세션 시작 기준 각 요청의 시작 위치와 지속 시간입니다."
            actions={
              <Button size="small" onClick={exportCsv} disabled={trace.spans.length === 0}>
                <Download aria-hidden="true" /> CSV 내보내기
              </Button>
            }
          >
            {trace.spans.length === 0 ? (
              <EmptyState title="표시할 요청이 없습니다." description="이 세션에는 기록된 요청이 없습니다." />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="요청 타임라인 표 영역">
                <table className="data-table">
                  <caption className="sr-only">세션 요청 워터폴</caption>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">모델</th>
                      <th scope="col">구분</th>
                      <th scope="col">타임라인</th>
                      <th scope="col">지연</th>
                      <th scope="col">첫 응답</th>
                      <th scope="col">직전 대기</th>
                      <th scope="col">비용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trace.spans.map((span) => (
                      <tr key={`${span.seq}-${span.request_id}`}>
                        <th scope="row">{span.seq}</th>
                        <td className="truncate" title={span.request_id}>
                          {span.model || "—"}
                        </td>
                        <td>
                          <Badge tone={categoryTone(span.category)}>{span.category || "normal"}</Badge>
                          {span.slow ? <Badge tone="warning">느림</Badge> : null}
                        </td>
                        <td>
                          <div
                            className="obs-bar-track"
                            role="img"
                            aria-label={`시작 ${formatDuration(span.start_offset_ms)}, 지속 ${formatDuration(span.total_ms)}`}
                          >
                            <span
                              className="obs-bar-fill"
                              data-tone={
                                span.category === "error"
                                  ? "danger"
                                  : span.slow || span.category === "fallback"
                                    ? "warning"
                                    : undefined
                              }
                              style={{
                                left: `${(span.start_offset_ms / wall) * 100}%`,
                                width: `${Math.max(1, (span.total_ms / wall) * 100)}%`,
                              }}
                            />
                          </div>
                        </td>
                        <td className="cell-number">{formatDuration(span.total_ms)}</td>
                        <td className="cell-number">{formatDuration(span.ttfb_ms)}</td>
                        <td className="cell-number">{formatDuration(span.gap_before_ms)}</td>
                        <td className="cell-number">{formatKRW(span.cost_krw)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title="비용 타임라인" description="세션이 진행되며 쌓인 누적 비용과 토큰입니다.">
            {costTimeline.isError ? (
              <InlineNotice tone="warning" title="비용 타임라인을 불러오지 못했습니다.">
                {safeAppErrorMessage(costTimeline.error, "비용 타임라인을 불러오지 못했습니다.")}
              </InlineNotice>
            ) : null}
            {(costTimeline.data?.points ?? []).length === 0 && !costTimeline.isPending ? (
              <EmptyState
                title="누적 비용 정보가 없습니다."
                description="이 세션의 요청에 비용이 기록되지 않았습니다."
              />
            ) : (
              <TimeSeriesChart
                caption="세션 누적 비용"
                series={[
                  {
                    id: "cumulative_cost",
                    name: "누적 비용",
                    colorVar: "--obs-series-1",
                    points: (costTimeline.data?.points ?? []).map((point, index) => ({
                      label: `${index + 1}`,
                      value: point.cumulative_cost_krw,
                    })),
                  },
                ]}
                format={(value) => formatKRW(value)}
                valueLabel="누적 비용"
              />
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
