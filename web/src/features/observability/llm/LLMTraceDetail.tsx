import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  canInspectRawRequest,
  canWriteRequestNote,
} from "@/features/observability/request-insight/request-access";
import { RequestInsightPanel } from "@/features/observability/request-insight/RequestInsightPanel";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

interface LLMTraceDetailProps {
  requestId: string;
  /** Opens the feedback composer for this request. */
  onWriteFeedback?: (requestId: string, traceId: string) => void;
  canWriteFeedback: boolean;
  writeDeniedReason: string;
}

function riskTone(risk: string): "danger" | "info" | "success" | "warning" {
  if (risk === "high") return "danger";
  if (risk === "medium") return "warning";
  if (risk === "low") return "success";
  return "info";
}

/** Detail for one LLM call: spans, tool calls, code verification, evaluations, feedback. */
export function LLMTraceDetail({
  canWriteFeedback,
  onWriteFeedback,
  requestId,
  writeDeniedReason,
}: LLMTraceDetailProps): React.JSX.Element {
  const auth = useAuth();
  // The explanation and its actions are fetched only when the operator asks for
  // them: the analysis and replay answers can quote the captured prompt.
  const [insightOpen, setInsightOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["observability", "llm", "trace", requestId],
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.observability.llm.traceDetail, { id: requestId }), {
        signal,
        routeId: "observability.llm.trace",
      }),
    enabled: requestId !== "",
    staleTime: 30_000,
  });

  if (detail.isPending) {
    return (
      <div role="status" aria-live="polite">
        호출 상세를 불러오는 중입니다.
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <InlineNotice
        tone="danger"
        title="호출 상세를 불러오지 못했습니다."
        actions={
          <Button size="small" onClick={() => void detail.refetch()}>
            다시 시도
          </Button>
        }
      >
        {safeAppErrorMessage(detail.error, "호출 상세를 불러오지 못했습니다.")}
        {isAppError(detail.error) && detail.error.requestId ? (
          <span className="request-id"> 요청 ID: {detail.error.requestId}</span>
        ) : null}
      </InlineNotice>
    );
  }

  const { code_verify: codeVerify, evaluations, feedback, request, spans, tools } = detail.data;
  const failedEvaluations = evaluations.filter((item) => !item.passed).length;

  return (
    <div className="obs-section-stack">
      <StatGrid label="호출 요약">
        <StatCard label="지연" value={formatDuration(request.latency_ms)} />
        <StatCard label="첫 응답" value={formatDuration(request.first_chunk_ms)} />
        <StatCard label="토큰" value={formatNumber(request.total_tokens)} />
        <StatCard label="비용" value={formatKRW(request.estimated_cost)} />
        <StatCard
          label="평가 실패"
          value={formatNumber(failedEvaluations)}
          tone={failedEvaluations > 0 ? "danger" : "default"}
        />
        <StatCard label="도구 호출" value={formatNumber(tools.length)} />
      </StatGrid>

      <KeyValueList
        items={[
          { label: "요청 ID", value: request.id, mono: true },
          { label: "추적 ID", value: request.trace_id, mono: true },
          { label: "세션 ID", value: request.session_id, mono: true },
          { label: "모델", value: request.model },
          { label: "Provider", value: request.provider },
          { label: "엔드포인트", value: request.endpoint },
          { label: "상태", value: `HTTP ${formatNumber(request.status_code)}` },
          { label: "프롬프트", value: `${request.prompt_name || "—"} ${request.prompt_version}` },
          { label: "종료 사유", value: request.finish_reason },
          { label: "발생 시각", value: formatDateTime(request.created_at) },
        ]}
      />

      <SectionCard
        headingLevel={3}
        title="원인 설명과 조치"
        description="이 호출이 느리거나 비쌌던 이유, 운영 메모, 모델 분석과 재실행입니다."
        actions={
          <Button size="small" onClick={() => setInsightOpen((current) => !current)}>
            {insightOpen ? "접기" : "원인 설명 열기"}
          </Button>
        }
      >
        {insightOpen ? (
          <RequestInsightPanel
            key={request.id}
            requestId={request.id}
            canInspectRaw={canInspectRawRequest(auth)}
            canWriteNote={canWriteRequestNote(auth)}
          />
        ) : (
          <p className="obs-meta">
            원인 설명에는 업스트림 오류 원문이, 분석·재실행 결과에는 프롬프트 내용이 포함될 수 있어 열었을
            때만 불러옵니다.
          </p>
        )}
      </SectionCard>

      <SectionCard headingLevel={3} title="코드 검증">
        {codeVerify ? (
          <>
            <div className="obs-timeline-badges">
              <Badge tone={riskTone(codeVerify.risk)}>위험도 {codeVerify.risk || "—"}</Badge>
              <Badge tone={codeVerify.has_code ? "info" : "muted"}>
                {codeVerify.has_code ? "코드 포함" : "코드 없음"}
              </Badge>
            </div>
            <KeyValueList
              items={[
                { label: "코드 블록", value: formatNumber(codeVerify.block_count) },
                { label: "언어", value: codeVerify.languages },
                { label: "High 지적", value: formatNumber(codeVerify.high_count) },
                { label: "Medium 지적", value: formatNumber(codeVerify.medium_count) },
                { label: "문법 오류", value: formatNumber(codeVerify.syntax_count) },
                { label: "시크릿 탐지", value: formatNumber(codeVerify.secret_count) },
                { label: "테스트 가능", value: formatNumber(codeVerify.testable_count) },
                { label: "검증 시각", value: formatDateTime(codeVerify.created_at) },
              ]}
            />
          </>
        ) : (
          <EmptyState
            title="코드 검증 결과가 없습니다."
            description="응답에 코드 블록이 없거나 코드 검증이 꺼져 있습니다."
          />
        )}
      </SectionCard>

      <SectionCard headingLevel={3} title="도구 호출">
        {tools.length === 0 ? (
          <EmptyState
            title="도구 호출이 없습니다."
            description="이 호출에서는 함수나 MCP 도구를 사용하지 않았습니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="도구 호출 표 영역">
            <table className="data-table">
              <caption className="sr-only">이 호출에서 사용한 도구</caption>
              <thead>
                <tr>
                  <th scope="col">도구</th>
                  <th scope="col">서버</th>
                  <th scope="col">구분</th>
                  <th scope="col">상태</th>
                  <th scope="col">인자 해시</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((tool, index) => (
                  <tr key={`${tool.id}-${index}`}>
                    <th scope="row">{tool.tool_name || "—"}</th>
                    <td>{tool.server_label || "—"}</td>
                    <td>
                      <Badge tone={tool.is_mcp ? "info" : "muted"}>{tool.is_mcp ? "MCP" : "함수"}</Badge>
                    </td>
                    <td>
                      <Badge tone={tool.is_error ? "danger" : "success"}>
                        {tool.is_error ? "오류" : "정상"}
                      </Badge>
                      {tool.arg_sensitive ? <Badge tone="warning">민감 인자</Badge> : null}
                    </td>
                    <td className="mono truncate">{tool.arg_hash || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard headingLevel={3} title="평가">
        {evaluations.length === 0 ? (
          <EmptyState
            title="평가 결과가 없습니다."
            description="평가기를 연결하면 이 호출의 품질 점수가 쌓입니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="평가 표 영역">
            <table className="data-table">
              <caption className="sr-only">이 호출의 평가 결과</caption>
              <thead>
                <tr>
                  <th scope="col">평가</th>
                  <th scope="col">분류</th>
                  <th scope="col">평가기</th>
                  <th scope="col">점수</th>
                  <th scope="col">결과</th>
                  <th scope="col">사유</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((item, index) => (
                  <tr key={`${item.id}-${index}`}>
                    <th scope="row">{item.name || "—"}</th>
                    <td>{item.category || "—"}</td>
                    <td>{item.evaluator || "—"}</td>
                    <td className="cell-number">{item.score.toFixed(2)}</td>
                    <td>
                      <Badge tone={item.passed ? "success" : "danger"}>
                        {item.label || (item.passed ? "pass" : "fail")}
                      </Badge>
                    </td>
                    <td className="truncate">{item.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="피드백"
        actions={
          onWriteFeedback ? (
            <Button
              size="small"
              variant="primary"
              disabled={!canWriteFeedback}
              title={canWriteFeedback ? undefined : writeDeniedReason}
              onClick={() => onWriteFeedback(request.id, request.trace_id)}
            >
              피드백 남기기
            </Button>
          ) : null
        }
      >
        {!canWriteFeedback ? (
          <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
            {writeDeniedReason}
          </InlineNotice>
        ) : null}
        {feedback.length === 0 ? (
          <EmptyState
            title="등록된 피드백이 없습니다."
            description="이 호출의 품질을 평가하면 프롬프트 개선 근거로 쌓입니다."
          />
        ) : (
          <ul className="obs-timeline">
            {feedback.map((item, index) => (
              <li key={`${item.id}-${index}`} className="obs-timeline-item">
                <div className="obs-timeline-when">{formatDateTime(item.created_at)}</div>
                <div className="obs-timeline-body">
                  <div className="obs-timeline-badges">
                    <Badge tone={item.rating > 0 ? "success" : item.rating < 0 ? "danger" : "muted"}>
                      평점 {formatNumber(item.rating)}
                    </Badge>
                    {item.label ? <Badge tone="info">{item.label}</Badge> : null}
                    {item.source ? <Badge tone="muted">{item.source}</Badge> : null}
                  </div>
                  <div>{item.comment || "—"}</div>
                  <div className="obs-meta">
                    <span>{item.created_by || "—"}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard headingLevel={3} title="LLM 스팬">
        {spans.length === 0 ? (
          <EmptyState title="스팬이 없습니다." description="이 호출에는 기록된 하위 스팬이 없습니다." />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="LLM 스팬 표 영역">
            <table className="data-table">
              <caption className="sr-only">이 호출의 LLM 스팬</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">종류</th>
                  <th scope="col">상태</th>
                  <th scope="col">지연</th>
                  <th scope="col">토큰</th>
                  <th scope="col">비용</th>
                </tr>
              </thead>
              <tbody>
                {spans.map((span, index) => (
                  <tr key={`${span.id}-${index}`}>
                    <th scope="row">{span.name || "—"}</th>
                    <td>{span.kind || "—"}</td>
                    <td>
                      <Badge tone={span.error ? "danger" : "success"}>{span.status || "—"}</Badge>
                    </td>
                    <td className="cell-number">{formatDuration(span.latency_ms)}</td>
                    <td className="cell-number">{formatNumber(span.total_tokens)}</td>
                    <td className="cell-number">{formatKRW(span.estimated_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
