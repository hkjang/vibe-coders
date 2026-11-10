import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Link } from "react-router";

import {
  requestDetailQueryOptions,
  type RequestDetailReadScope,
} from "@/features/observability/request-insight/request-detail-read-scope";
import { apiClient } from "@/shared/api/client";
import type { RequestIODetail, RequestIOMessage } from "@/shared/api/domains/observability.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

import {
  prettyJson,
  requestIOFinishLabel,
  requestIOFinishTone,
  requestIORoleLabel,
  requestStatusTone,
  splitCodeFences,
  splitConversation,
} from "./request-io-model";
import "./request-io.css";

const routeId = "observability.request-io";
const clampChars = 1_200;
const responseCaptureSettingHref = "/system/settings?tab=runtime&q=logging.response_text";

function IOText({ label, text }: { label: string; text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const json = prettyJson(text);
  const display = json ?? text;
  const long = display.length > clampChars;
  const visible = long && !expanded ? `${display.slice(0, clampChars)}…` : display;
  return (
    <div className="io-text-block">
      {json ? (
        <pre className="io-code" tabIndex={0} aria-label={`${label} JSON`}>
          {visible}
        </pre>
      ) : (
        <div className="io-text">
          {splitCodeFences(visible).map((segment, index) =>
            segment.kind === "code" ? (
              <pre
                key={index}
                className="io-code"
                tabIndex={0}
                aria-label={`${label} 코드${segment.language ? ` (${segment.language})` : ""}`}
              >
                {segment.value}
              </pre>
            ) : (
              <span key={index}>{segment.value}</span>
            ),
          )}
        </div>
      )}
      {long ? (
        <Button size="small" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
          {expanded ? "접기" : `전체 보기 (${formatNumber(display.length)}자)`}
        </Button>
      ) : null}
    </div>
  );
}

function IOMessage({
  message,
  emphasized = false,
}: {
  message: RequestIOMessage;
  emphasized?: boolean;
}): React.JSX.Element {
  const label = requestIORoleLabel(message.role);
  return (
    <article className="io-message" data-emphasized={emphasized} data-role={message.role.toLowerCase()}>
      <header className="io-message-head">
        <strong>{label}</strong>
        <span className="obs-meta">{formatNumber(message.chars)}자</span>
        {message.truncated ? <Badge tone="warning">일부만 표시</Badge> : null}
        <span className="io-message-copy">
          <CopyButton label={`${label} 메시지 복사`} size="icon" value={message.text} />
        </span>
      </header>
      <IOText label={`${label} 메시지`} text={message.text} />
    </article>
  );
}

function IOMessageGroup({
  messages,
  summary,
}: {
  messages: readonly RequestIOMessage[];
  summary: string;
}): React.JSX.Element | null {
  if (messages.length === 0) return null;
  return (
    <details className="io-group">
      <summary>{summary}</summary>
      <div className="io-group-body">
        {messages.map((message, index) => (
          <IOMessage key={index} message={message} />
        ))}
      </div>
    </details>
  );
}

function InputColumn({ detail, titleId }: { detail: RequestIODetail; titleId: string }): React.JSX.Element {
  const { input } = detail;
  const conversation = splitConversation(input.messages);
  const count = input.messages.length + input.omitted_messages;
  return (
    <section className="io-column" aria-labelledby={titleId} data-side="input">
      <header className="io-column-head">
        <h3 id={titleId}>입력</h3>
        <span className="obs-meta">메시지 {formatNumber(count)}건</span>
      </header>
      {input.state !== "captured" ? (
        <InlineNotice title="입력 기록이 없습니다.">
          이 경로의 입력을 수집하지 않았거나 보존 기간(RETENTION_PROMPT_DAYS)이 지나 삭제되었습니다.
        </InlineNotice>
      ) : (
        <>
          <IOMessageGroup
            messages={conversation.instructions}
            summary={`시스템 지시 ${formatNumber(conversation.instructions.length)}건`}
          />
          {input.omitted_messages > 0 ? (
            <p className="obs-meta">
              긴 대화라 중간 메시지 {formatNumber(input.omitted_messages)}건을 생략했습니다.
            </p>
          ) : null}
          <IOMessageGroup
            messages={conversation.earlier}
            summary={`이전 대화 ${formatNumber(conversation.earlier.length)}건`}
          />
          {conversation.latest.map((message, index) => (
            <IOMessage key={index} message={message} emphasized={index === 0} />
          ))}
          {input.tool_definitions ? (
            <details className="io-group">
              <summary>전달한 도구 정의</summary>
              <div className="io-group-body">
                <IOText label="도구 정의" text={input.tool_definitions} />
              </div>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function OutputBody({ detail }: { detail: RequestIODetail }): React.JSX.Element {
  const { capture, output } = detail;
  if (output.state === "missing") {
    return (
      <InlineNotice title="응답 기록이 없습니다.">
        {detail.status_code >= 400
          ? "업스트림에 닿기 전에 게이트웨이에서 거절했거나 응답을 기록하지 못했습니다."
          : "응답 기록을 찾을 수 없습니다. 보존 기간이 지났을 수 있습니다."}
      </InlineNotice>
    );
  }
  if (output.state === "not_captured") {
    return (
      <>
        <InlineNotice
          tone={capture.response_text ? "info" : "warning"}
          title="응답 본문을 저장하지 않은 요청입니다."
          actions={
            capture.response_text ? undefined : (
              <Link className="button button-secondary button-small" to={responseCaptureSettingHref}>
                저장 설정 열기
              </Link>
            )
          }
        >
          {capture.response_text
            ? "지금은 저장 중이지만 이 요청이 처리될 때는 저장 설정이 꺼져 있었습니다."
            : "응답 본문 저장(LOG_RESPONSE_TEXT)이 꺼져 있습니다. 켜면 이후 요청부터 민감정보를 포함한 출력이 데이터베이스에 저장됩니다."}
        </InlineNotice>
        <ToolCalls detail={detail} />
      </>
    );
  }
  return (
    <>
      {output.kind === "error" ? (
        <InlineNotice tone="danger" title="업스트림 오류">
          {output.text}
        </InlineNotice>
      ) : output.text ? (
        <article className="io-message" data-emphasized="true" data-role="assistant">
          <header className="io-message-head">
            <strong>{output.kind === "text" ? "응답" : "결과"}</strong>
            <span className="obs-meta">{formatNumber(output.chars)}자</span>
            {output.truncated ? <Badge tone="warning">저장 한도로 일부만 저장</Badge> : null}
            <span className="io-message-copy">
              <CopyButton label="응답 복사" size="icon" value={output.text} />
            </span>
          </header>
          <IOText label="응답" text={output.text} />
        </article>
      ) : null}
      <ToolCalls detail={detail} />
    </>
  );
}

function ToolCalls({ detail }: { detail: RequestIODetail }): React.JSX.Element | null {
  const calls = detail.output.tool_calls;
  if (calls.length === 0) return null;
  return (
    <div className="io-tools">
      {calls.map((call, index) => (
        <article key={index} className="io-message" data-role="tool">
          <header className="io-message-head">
            <strong>도구 호출</strong>
            <code>{call.name || "이름 없음"}</code>
          </header>
          {call.arguments ? (
            <IOText label={`${call.name} 인수`} text={call.arguments} />
          ) : (
            <p className="obs-meta">인수는 저장되지 않았습니다.</p>
          )}
        </article>
      ))}
    </div>
  );
}

function OutputColumn({ detail, titleId }: { detail: RequestIODetail; titleId: string }): React.JSX.Element {
  const finish = detail.output.finish_reason;
  return (
    <section className="io-column" aria-labelledby={titleId} data-side="output">
      <header className="io-column-head">
        <h3 id={titleId}>출력</h3>
        {finish ? <Badge tone={requestIOFinishTone(finish)}>{requestIOFinishLabel(finish)}</Badge> : null}
      </header>
      <OutputBody detail={detail} />
    </section>
  );
}

function Fact({
  label,
  sub,
  value,
}: {
  label: string;
  sub?: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="io-fact">
      <dt>{label}</dt>
      <dd>
        {value}
        {sub ? <span className="io-fact-sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

function FactStrip({ detail }: { detail: RequestIODetail }): React.JSX.Element {
  const modelChanged = detail.requested_model !== "" && detail.requested_model !== detail.resolved_model;
  const tokenDetails = [
    `합계 ${formatNumber(detail.total_tokens)}`,
    detail.cached_tokens > 0 ? `캐시 ${formatNumber(detail.cached_tokens)}` : "",
    detail.reasoning_tokens > 0 ? `추론 ${formatNumber(detail.reasoning_tokens)}` : "",
    detail.token_source === "estimated" ? "추정값" : "",
  ].filter(Boolean);
  return (
    <dl className="io-facts">
      <Fact
        label="결과"
        value={
          <Badge tone={requestStatusTone(detail.status_code)}>HTTP {formatNumber(detail.status_code)}</Badge>
        }
        sub={detail.stream ? "스트리밍" : undefined}
      />
      <Fact
        label="토큰 (입력 → 출력)"
        value={`${formatNumber(detail.prompt_tokens)} → ${formatNumber(detail.completion_tokens)}`}
        sub={tokenDetails.join(" · ")}
      />
      <Fact
        label="지연"
        value={formatDuration(detail.latency_ms)}
        {...(detail.first_chunk_ms > 0 ? { sub: `첫 청크 ${formatDuration(detail.first_chunk_ms)}` } : {})}
      />
      <Fact
        label="비용"
        value={
          detail.currency === "KRW" || detail.currency === ""
            ? formatKRW(detail.estimated_cost)
            : `${formatNumber(detail.estimated_cost, 4)} ${detail.currency}`
        }
      />
      <Fact
        label="모델"
        value={detail.resolved_model || detail.requested_model || "확인 불가"}
        {...(modelChanged ? { sub: `요청 ${detail.requested_model}에서 변경` } : {})}
      />
      <Fact
        label="공급자"
        value={detail.provider || "확인 불가"}
        {...(detail.failover ? { sub: `${detail.fallback_from || "이전 공급자"}에서 폴백` } : {})}
      />
    </dl>
  );
}

/** Keyed on the request id, so switching requests discards revealed originals. */
export function RequestIOPanel({
  requestId,
  readScope,
}: {
  requestId: string;
  readScope?: RequestDetailReadScope;
}): React.JSX.Element {
  return (
    <RequestIOPanelContent key={requestId} requestId={requestId} {...(readScope ? { readScope } : {})} />
  );
}

function RequestIOPanelContent({
  requestId,
  readScope,
}: {
  requestId: string;
  readScope?: RequestDetailReadScope;
}): React.JSX.Element {
  const inputTitleId = useId();
  const outputTitleId = useId();
  const [revealed, setRevealed] = useState<RequestIODetail>();
  const [confirming, setConfirming] = useState(false);
  const revealTrigger = useRef<HTMLButtonElement>(null);
  const path = withPathParams(endpoints.domains.observability.requests.io, { id: requestId });
  const query = useQuery({
    staleTime: 30_000,
    gcTime: 0,
    retry: false,
    ...requestDetailQueryOptions(readScope, requestId, "io", (signal) =>
      apiClient.request(path, { signal, routeId }),
    ),
  });
  // A GET with an audited side effect, so it runs only from the confirmation below and the
  // result stays in component state: never in the query cache, the URL or browser storage.
  const reveal = useMutationFeedback({
    gcTime: 0,
    mutate: () => apiClient.request(path, { query: { reveal: "raw" }, routeId }),
    errorMessage: "원문을 불러오지 못했습니다.",
    ownsResult: () => readScope?.isCurrent() ?? true,
    onSuccess: setRevealed,
  });

  if (query.isPending) {
    return (
      <div role="status" aria-live="polite">
        입력과 출력을 불러오는 중입니다.
      </div>
    );
  }
  if (query.isError) {
    return (
      <InlineNotice tone="danger" title="입력과 출력을 불러오지 못했습니다.">
        {safeAppErrorMessage(query.error, "입력과 출력을 불러오지 못했습니다.")}
        {isAppError(query.error) && query.error.requestId ? (
          <span className="request-id"> 요청 ID: {query.error.requestId}</span>
        ) : null}
      </InlineNotice>
    );
  }
  const detail = revealed ?? query.data;
  // Masking happens on write, so only originals kept by LOG_RAW_PROMPTS or rows stored
  // before responses were masked have anything more to show.
  const hasOriginals =
    detail.input.messages.some((message) => message.original_kept) || detail.output.original_kept;
  return (
    <div className="io-panel">
      <FactStrip detail={detail} />
      <div className="io-privacy">
        {detail.masked ? (
          <Badge tone="success">민감정보 마스킹 적용</Badge>
        ) : (
          <Badge tone="danger">원문 표시 중 · 열람 기록 저장됨</Badge>
        )}
        <span className="obs-meta">{formatDateTime(detail.created_at)}</span>
        {detail.raw_allowed && hasOriginals ? (
          detail.masked ? (
            <Button
              ref={revealTrigger}
              size="small"
              onClick={() => setConfirming(true)}
              disabled={reveal.isPending}
            >
              <Eye aria-hidden="true" /> {reveal.isPending ? "불러오는 중" : "원문 보기"}
            </Button>
          ) : (
            <Button size="small" onClick={() => setRevealed(undefined)}>
              <EyeOff aria-hidden="true" /> 마스킹으로 돌아가기
            </Button>
          )
        ) : null}
      </div>
      {detail.error && detail.output.kind !== "error" ? (
        <InlineNotice tone="warning" title="처리 중 기록된 오류">
          {detail.error}
        </InlineNotice>
      ) : null}
      <div className="io-columns">
        <InputColumn detail={detail} titleId={inputTitleId} />
        <OutputColumn detail={detail} titleId={outputTitleId} />
      </div>
      <details className="io-group">
        <summary>호출 정보</summary>
        <div className="io-group-body">
          <KeyValueList
            columns={2}
            items={[
              { label: "경로", value: `${detail.method} ${detail.endpoint}`, mono: true },
              { label: "클라이언트 IP", value: detail.client_ip, mono: true },
              { label: "API 키", value: detail.api_key_id, mono: true },
              { label: "사용자 에이전트", value: detail.user_agent },
              { label: "세션 ID", value: detail.session_id, mono: true },
              { label: "추적 ID", value: detail.trace_id, mono: true },
              { label: "입력 언어", value: detail.languages.join(", ") },
              { label: "라우팅 사유", value: detail.route_reason },
              { label: "요청 ID", value: detail.request_id, mono: true },
            ]}
          />
        </div>
      </details>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        returnFocusRef={revealTrigger}
        title="이 요청의 원문을 볼까요?"
        description="마스킹하지 않은 입력과 출력을 표시합니다. 열람 사실이 감사 기록에 남으며, 다른 요청으로 이동하면 화면에서 지워집니다."
        confirmLabel="원문 보기"
        tone="danger"
        onConfirm={async () => {
          await reveal.mutateAsync();
        }}
      />
    </div>
  );
}
