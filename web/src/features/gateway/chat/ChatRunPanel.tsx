import { useCallback, useId, useMemo, useRef, useState } from "react";
import { CircleStop, Play, Route, ShieldCheck, Trash2 } from "lucide-react";

import {
  chatTargetOptions,
  safeModelLabel,
  riskLabels,
  type ChatTargetOption,
} from "@/features/gateway/chat/chat-console";
import { streamChatTest } from "@/features/gateway/chat/chat-stream";
import { chatRouteId, useChatTargets } from "@/features/gateway/chat/use-chat-console";
import { apiClient } from "@/shared/api/client";
import type { ChatTestRunBody } from "@/shared/api/domains/gateway";
import type { CodeVerifyReport, RoutingPreview } from "@/shared/api/domains/gateway.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormField } from "@/shared/components/form/FormField";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  pending?: boolean;
  failed?: boolean;
}

interface ChatRunPanelProps {
  canWrite: boolean;
  canPreviewRouting: boolean;
  writeDeniedReason: string;
}

const defaultPrompt = "Reply with pong in one short sentence.";

function turnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ChatRunPanel({
  canPreviewRouting,
  canWrite,
  writeDeniedReason,
}: ChatRunPanelProps): React.JSX.Element {
  const targets = useChatTargets();
  const fieldPrefix = useId();
  const [targetId, setTargetId] = useState("");
  const [model, setModel] = useState("vibe/auto");
  const [provider, setProvider] = useState("");
  const [maxTokens, setMaxTokens] = useState("4096");
  const [temperature, setTemperature] = useState("0");
  const [apiKeyId, setApiKeyId] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [noRoute, setNoRoute] = useState(false);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [runError, setRunError] = useState<{ message: string; requestId?: string } | undefined>();
  const [preview, setPreview] = useState<RoutingPreview | undefined>();
  const [previewError, setPreviewError] = useState<string | undefined>();
  const [previewPending, setPreviewPending] = useState(false);
  const [headers, setHeaders] = useState<Readonly<Record<string, string>>>({});
  const [usage, setUsage] = useState<{ prompt?: number; completion?: number; total?: number }>({});
  const [codeReport, setCodeReport] = useState<CodeVerifyReport | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  const options = useMemo<ChatTargetOption[]>(
    () => chatTargetOptions(targets.data?.grouped, targets.data?.targets ?? []),
    [targets.data?.grouped, targets.data?.targets],
  );
  const groups = useMemo(() => {
    const byGroup = new Map<string, ChatTargetOption[]>();
    for (const option of options) {
      const bucket = byGroup.get(option.group) ?? [];
      bucket.push(option);
      byGroup.set(option.group, bucket);
    }
    return [...byGroup.entries()];
  }, [options]);

  const applyTarget = useCallback(
    (id: string): void => {
      setTargetId(id);
      const option = options.find((candidate) => candidate.value === id);
      if (!option) return;
      if (option.target.model) setModel(option.target.model);
      setProvider(option.target.provider ?? "");
    },
    [options],
  );

  const requestBody = useCallback(
    (messages: ReadonlyArray<{ role: string; content: string }>): ChatTestRunBody => {
      const parsedMax = Number(maxTokens);
      const parsedTemperature = Number(temperature);
      return {
        target_id: targetId || undefined,
        model: model.trim() || "vibe/auto",
        provider: provider.trim() || undefined,
        messages,
        api_key_id: apiKeyId.trim() || undefined,
        bearer_token: bearerToken.trim() || undefined,
        max_tokens: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined,
        temperature: Number.isFinite(parsedTemperature) ? parsedTemperature : undefined,
        no_route: noRoute || undefined,
      };
    },
    [apiKeyId, bearerToken, maxTokens, model, noRoute, provider, targetId, temperature],
  );

  const runPreview = useCallback(async (): Promise<void> => {
    setPreviewPending(true);
    setPreviewError(undefined);
    try {
      const result = await apiClient.request(endpoints.domains.gateway.chat.routingPreview, {
        body: {
          model: model.trim() || "vibe/auto",
          messages: [{ role: "user", content: prompt }],
          api_key_id: apiKeyId.trim() || undefined,
        },
        routeId: chatRouteId,
      });
      setPreview(result);
    } catch (cause) {
      setPreviewError(safeAppErrorMessage(cause, "라우팅 미리보기를 실행하지 못했습니다."));
    } finally {
      setPreviewPending(false);
    }
  }, [apiKeyId, model, prompt]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === "" || streaming) return;
      setRunError(undefined);
      setCodeReport(undefined);
      setCodeError(undefined);
      const history = turns
        .filter((turn) => !turn.failed && turn.content !== "")
        .map((turn) => ({ role: turn.role, content: turn.content }));
      const messages = [...history, { role: "user", content: trimmed }];
      const answerId = turnId();
      setTurns((previous) => [
        ...previous,
        { id: turnId(), role: "user", content: trimmed },
        { id: answerId, role: "assistant", content: "", pending: true },
      ]);
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const appendTo = (patch: (turn: ChatTurn) => ChatTurn): void => {
        setTurns((previous) => previous.map((turn) => (turn.id === answerId ? patch(turn) : turn)));
      };
      try {
        const outcome = await streamChatTest(
          requestBody(messages),
          {
            onContent: (delta) => appendTo((turn) => ({ ...turn, content: turn.content + delta })),
            onReasoning: (delta) =>
              appendTo((turn) => ({ ...turn, reasoning: (turn.reasoning ?? "") + delta })),
            onUsage: (value) =>
              setUsage({
                prompt: value.promptTokens,
                completion: value.completionTokens,
                total: value.totalTokens,
              }),
            onHeaders: setHeaders,
          },
          controller.signal,
        );
        appendTo((turn) => ({ ...turn, content: outcome.content || turn.content, pending: false }));
      } catch (cause) {
        appendTo((turn) => ({ ...turn, pending: false, failed: true }));
        if (!(isAppError(cause) && cause.kind === "aborted")) {
          setRunError({
            message: safeAppErrorMessage(cause, "Chat 호출에 실패했습니다."),
            requestId: isAppError(cause) ? cause.requestId : undefined,
          });
        }
      } finally {
        abortRef.current = undefined;
        setStreaming(false);
      }
    },
    [requestBody, streaming, turns],
  );

  const verifyLastAnswer = useCallback(async (): Promise<void> => {
    const answer = [...turns].reverse().find((turn) => turn.role === "assistant" && turn.content !== "");
    if (!answer) return;
    setCodeError(undefined);
    try {
      const report = await apiClient.request(endpoints.domains.gateway.chat.codeVerify, {
        body: { text: answer.content },
        routeId: chatRouteId,
      });
      setCodeReport(report);
    } catch (cause) {
      setCodeError(safeAppErrorMessage(cause, "코드 검증을 실행하지 못했습니다."));
    }
  }, [turns]);

  const lastAnswer = [...turns].reverse().find((turn) => turn.role === "assistant" && turn.content !== "");

  return (
    <div className="page-stack">
      <SectionCard
        title="호출 설정"
        description="게이트웨이를 통해 모델을 직접 호출합니다. 프롬프트와 응답은 화면에만 남고 주소나 브라우저 저장소에 기록되지 않습니다."
      >
        <div className="form-grid gateway-form-grid">
          <FormField label="테스트 대상" id={`${fieldPrefix}-target`}>
            {(control) => (
              <Select
                {...control}
                value={targetId}
                onChange={(event) => applyTarget(event.target.value)}
                disabled={targets.isPending}
              >
                <option value="">직접 입력</option>
                {groups.map(([group, items]) => (
                  <optgroup key={group} label={group}>
                    {items.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="모델" id={`${fieldPrefix}-model`} required>
            {(control) => (
              <Input {...control} value={model} onChange={(event) => setModel(event.target.value)} />
            )}
          </FormField>
          <FormField label="공급자" id={`${fieldPrefix}-provider`} description="비우면 라우터가 선택합니다.">
            {(control) => (
              <Input {...control} value={provider} onChange={(event) => setProvider(event.target.value)} />
            )}
          </FormField>
          <FormField label="최대 토큰" id={`${fieldPrefix}-max-tokens`}>
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            )}
          </FormField>
          <FormField label="Temperature" id={`${fieldPrefix}-temperature`}>
            {(control) => (
              <Input
                {...control}
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={temperature}
                onChange={(event) => setTemperature(event.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="API Key ID"
            id={`${fieldPrefix}-api-key-id`}
            description="해당 키의 정책으로 호출합니다. 키 원문이 아닌 식별자입니다."
          >
            {(control) => (
              <Input {...control} value={apiKeyId} onChange={(event) => setApiKeyId(event.target.value)} />
            )}
          </FormField>
          <FormField
            label="Proxy Bearer 토큰"
            id={`${fieldPrefix}-bearer`}
            description="입력 전용입니다. 저장하거나 다시 표시하지 않습니다."
          >
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="off"
                value={bearerToken}
                onChange={(event) => setBearerToken(event.target.value)}
              />
            )}
          </FormField>
        </div>
        <Checkbox
          label="라우팅 우회 (X-Proxy-No-Route)"
          description="지능형 라우팅을 건너뛰고 입력한 모델을 그대로 호출합니다."
          checked={noRoute}
          onChange={(event) => setNoRoute(event.target.checked)}
        />
        <FormField label="프롬프트" id={`${fieldPrefix}-prompt`} required>
          {(control) => (
            <Textarea
              {...control}
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          )}
        </FormField>
        {targets.isError ? (
          <InlineNotice tone="warning" title="테스트 대상 목록을 불러오지 못했습니다.">
            직접 모델을 입력해 호출할 수 있습니다.{" "}
            <Button size="small" variant="ghost" onClick={() => void targets.refetch()}>
              다시 시도
            </Button>
          </InlineNotice>
        ) : null}
        {!canWrite ? (
          <InlineNotice tone="warning" title="호출 권한이 없습니다.">
            {writeDeniedReason}
          </InlineNotice>
        ) : null}
        <div className="toolbar">
          <div className="toolbar-start">
            <Button
              variant="primary"
              disabled={!canWrite || streaming || prompt.trim() === ""}
              onClick={() => void send(prompt)}
            >
              <Play aria-hidden="true" /> {streaming ? "스트리밍 중" : "Chat 호출"}
            </Button>
            <Button
              variant="secondary"
              disabled={!canPreviewRouting || previewPending}
              onClick={() => void runPreview()}
            >
              <Route aria-hidden="true" /> 라우팅 미리보기
            </Button>
            {streaming ? (
              <Button variant="danger" onClick={() => abortRef.current?.abort()}>
                <CircleStop aria-hidden="true" /> 취소
              </Button>
            ) : null}
          </div>
          <div className="toolbar-end">
            <Button
              variant="ghost"
              disabled={turns.length === 0 || streaming}
              onClick={() => {
                setTurns([]);
                setUsage({});
                setHeaders({});
                setCodeReport(undefined);
                setRunError(undefined);
              }}
            >
              <Trash2 aria-hidden="true" /> 대화 지우기
            </Button>
          </div>
        </div>
        {runError ? (
          <p className="form-error" role="alert">
            {runError.message}
            {runError.requestId ? <span className="request-id"> 요청 ID: {runError.requestId}</span> : null}
          </p>
        ) : null}
      </SectionCard>

      {previewError ? (
        <InlineNotice tone="warning" title="라우팅 미리보기 실패">
          {previewError}
        </InlineNotice>
      ) : null}
      {preview ? (
        <SectionCard title="라우팅 미리보기" description="실제 호출 없이 계획만 계산합니다.">
          <KeyValueList
            items={[
              { label: "요청 모델", value: safeModelLabel(preview.requested_model) },
              { label: "선택 모델", value: safeModelLabel(preview.selected_model) },
              { label: "선택 공급자", value: preview.selected_provider || "-" },
              { label: "복잡도", value: formatNumber(preview.complexity ?? null, 2) },
              { label: "위험도", value: formatNumber(preview.risk ?? null, 2) },
              { label: "상태 점수", value: formatNumber(preview.health_score ?? null, 0) },
              { label: "모델 재작성", value: preview.would_rewrite ? "예" : "아니오" },
              { label: "판단 근거", value: preview.decision_reason || preview.route_reason || "-" },
            ]}
          />
        </SectionCard>
      ) : null}

      <SectionCard
        title="응답"
        description="스트리밍 응답이 도착하는 즉시 표시합니다."
        actions={
          <Button
            size="small"
            variant="secondary"
            disabled={!lastAnswer}
            onClick={() => void verifyLastAnswer()}
          >
            <ShieldCheck aria-hidden="true" /> 코드 검증
          </Button>
        }
      >
        {turns.length === 0 ? (
          <EmptyState
            title="아직 호출한 응답이 없습니다."
            description="위에서 모델과 프롬프트를 지정하고 Chat 호출을 실행하면 대화가 여기에 쌓입니다."
          />
        ) : (
          <ol className="chat-transcript">
            {turns.map((turn) => (
              <li key={turn.id} className={`chat-turn chat-turn-${turn.role}`}>
                <span className="chat-turn-role">{turn.role === "user" ? "요청" : "응답"}</span>
                {turn.reasoning ? (
                  <details className="chat-reasoning">
                    <summary>추론 과정</summary>
                    <pre className="mono">{turn.reasoning}</pre>
                  </details>
                ) : null}
                <pre className="chat-turn-body mono">{turn.content}</pre>
                {turn.pending ? (
                  <span role="status" className="chat-turn-status">
                    응답을 받는 중입니다.
                  </span>
                ) : null}
                {turn.failed ? (
                  <span role="status" className="chat-turn-status">
                    응답을 완료하지 못했습니다.
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {streaming ? (
          <p role="status" className="chat-turn-status">
            모델이 응답을 생성하고 있습니다.
          </p>
        ) : null}
        <div className="chat-followup">
          <FormField label="이어서 질문" id={`${fieldPrefix}-followup`}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                placeholder="Enter로 전송, Shift+Enter로 줄바꿈"
                disabled={!canWrite || streaming || turns.length === 0}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  const input = event.currentTarget;
                  const value = input.value;
                  input.value = "";
                  void send(value);
                }}
              />
            )}
          </FormField>
        </div>
      </SectionCard>

      {codeError ? (
        <InlineNotice tone="warning" title="코드 검증 실패">
          {codeError}
        </InlineNotice>
      ) : null}
      {codeReport ? (
        <SectionCard title="코드 검증 결과" description={codeReport.note ?? undefined}>
          <div className="toolbar">
            <div className="toolbar-start">
              <Badge
                tone={
                  codeReport.risk === "high" ? "danger" : codeReport.risk === "medium" ? "warning" : "success"
                }
              >
                위험도 {riskLabels[codeReport.risk ?? "none"] ?? codeReport.risk}
              </Badge>
              <Badge tone="muted">코드 블록 {formatNumber(codeReport.block_count ?? 0)}개</Badge>
            </div>
          </div>
          {(codeReport.blocks ?? []).length === 0 ? (
            <p className="metric-note">검출된 코드 블록이 없습니다.</p>
          ) : (
            <ul className="gateway-list">
              {(codeReport.blocks ?? []).map((block, index) => (
                <li key={`code-block-${index}`}>
                  <strong>
                    #{formatNumber(block.index ?? index)} · {block.lang || "미상"} ·{" "}
                    {riskLabels[block.risk ?? "none"] ?? block.risk}
                  </strong>
                  <span>
                    {(block.findings ?? []).length === 0
                      ? "지적 사항 없음"
                      : (block.findings ?? [])
                          .map((finding) => `${finding.severity ?? ""} ${finding.rule ?? ""}`.trim())
                          .join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}

      {Object.keys(headers).length > 0 || usage.total !== undefined ? (
        <SectionCard title="디버그" description="마지막 호출의 진단 헤더와 토큰 사용량입니다.">
          <KeyValueList
            items={[
              { label: "입력 토큰", value: formatNumber(usage.prompt ?? null) },
              { label: "출력 토큰", value: formatNumber(usage.completion ?? null) },
              { label: "전체 토큰", value: formatNumber(usage.total ?? null) },
              ...Object.entries(headers).map(([key, value]) => ({ label: key, value })),
            ]}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
