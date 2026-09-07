import { useCallback, useId, useMemo, useState } from "react";
import { Calculator, Gavel, History, Layers, ShieldAlert } from "lucide-react";

import {
  chatStatusLabel,
  judgeVerdictLabels,
  maxCompareModels,
  parseCompareModels,
  safeModelLabel,
} from "@/features/gateway/chat/chat-console";
import { ChatRunActions } from "@/features/gateway/chat/ChatRunActions";
import { chatRouteId, useMultiRunHistory } from "@/features/gateway/chat/use-chat-console";
import { apiClient } from "@/shared/api/client";
import type { MultiRunBody } from "@/shared/api/domains/gateway";
import type {
  MultiRunCodeVerify,
  MultiRunJudge,
  MultiRunPredict,
  MultiRunResponse,
} from "@/shared/api/domains/gateway.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormField } from "@/shared/components/form/FormField";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

interface ChatComparePanelProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

const defaultModels = "vibe/auto\n";

export function ChatComparePanel({ canWrite, writeDeniedReason }: ChatComparePanelProps): React.JSX.Element {
  const fieldPrefix = useId();
  const [title, setTitle] = useState("");
  const [modelLines, setModelLines] = useState(defaultModels);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [temperature, setTemperature] = useState("0");
  const [judgeMethod, setJudgeMethod] = useState<"rule" | "model">("rule");
  const [judgeModel, setJudgeModel] = useState("");
  const [run, setRun] = useState<MultiRunResponse | undefined>();
  const [predict, setPredict] = useState<MultiRunPredict | undefined>();
  const [judge, setJudge] = useState<MultiRunJudge | undefined>();
  const [codeRisk, setCodeRisk] = useState<MultiRunCodeVerify | undefined>();
  const [pending, setPending] = useState<"" | "run" | "predict" | "judge" | "code">("");
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();

  const parsed = useMemo(() => parseCompareModels(modelLines), [modelLines]);
  const history = useMultiRunHistory(true);

  const body = useCallback((): MultiRunBody => {
    const messages = [
      ...(systemPrompt.trim() === "" ? [] : [{ role: "system", content: systemPrompt }]),
      { role: "user", content: userPrompt },
    ];
    const parsedMax = Number(maxTokens);
    const parsedTemperature = Number(temperature);
    return {
      title: title.trim() || undefined,
      models: parsed.models,
      messages,
      params: {
        max_tokens: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined,
        temperature: Number.isFinite(parsedTemperature) ? parsedTemperature : undefined,
      },
      // Prompt text is never persisted server side unless the operator opts in; the
      // console keeps the default (off) so comparison prompts stay on this screen.
      save_prompt: false,
    };
  }, [maxTokens, parsed.models, systemPrompt, temperature, title, userPrompt]);

  const call = useCallback(
    async (kind: "run" | "predict" | "judge" | "code"): Promise<void> => {
      setError(undefined);
      setPending(kind);
      try {
        if (kind === "predict") {
          setPredict(
            await apiClient.request(endpoints.domains.gateway.chat.multiRunPredict, {
              body: body(),
              routeId: chatRouteId,
            }),
          );
        } else if (kind === "run") {
          const result = await apiClient.request(endpoints.domains.gateway.chat.multiRun, {
            body: body(),
            routeId: chatRouteId,
          });
          setRun(result);
          setJudge(undefined);
          setCodeRisk(undefined);
          void history.refetch();
        } else if (kind === "code" && run?.run_id) {
          setCodeRisk(
            await apiClient.request(
              withPathParams(endpoints.domains.gateway.chat.multiRunCodeVerify, {
                id: run.run_id,
              }),
              { routeId: chatRouteId },
            ),
          );
        } else if (run?.run_id) {
          setJudge(
            await apiClient.request(endpoints.domains.gateway.chat.multiRunJudge, {
              body: {
                run_id: run.run_id,
                method: judgeMethod,
                judge_model: judgeMethod === "model" ? judgeModel.trim() : undefined,
              },
              routeId: chatRouteId,
            }),
          );
        }
      } catch (cause) {
        setError({
          message: safeAppErrorMessage(cause, "요청을 완료하지 못했습니다."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
      } finally {
        setPending("");
      }
    },
    [body, history, judgeMethod, judgeModel, run],
  );

  const judgeByModel = useMemo(
    () => new Map((judge?.judgements ?? []).map((item) => [item.model ?? "", item])),
    [judge?.judgements],
  );

  return (
    <div className="page-stack">
      <SectionCard
        title="멀티 모델 비교"
        description={`같은 프롬프트를 여러 모델에 동시에 보내 결과를 나란히 비교합니다. 한 번에 최대 ${maxCompareModels}개까지 실행합니다.`}
      >
        <div className="form-grid gateway-form-grid">
          <FormField label="실행 제목" id={`${fieldPrefix}-title`}>
            {(control) => (
              <Input {...control} value={title} onChange={(event) => setTitle(event.target.value)} />
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
        </div>
        <FormField
          label="비교할 모델"
          id={`${fieldPrefix}-models`}
          description="한 줄에 하나씩 입력합니다. 공급자를 지정하려면 모델:공급자 형식으로 씁니다."
          required
        >
          {(control) => (
            <Textarea
              {...control}
              rows={4}
              value={modelLines}
              onChange={(event) => setModelLines(event.target.value)}
            />
          )}
        </FormField>
        {parsed.overflow > 0 ? (
          <InlineNotice tone="warning" title="모델 수 제한">
            {`${maxCompareModels}개까지만 실행합니다. ${formatNumber(parsed.overflow)}개는 제외됩니다.`}
          </InlineNotice>
        ) : null}
        <FormField label="System 프롬프트" id={`${fieldPrefix}-system`}>
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="User 프롬프트" id={`${fieldPrefix}-user`} required>
          {(control) => (
            <Textarea
              {...control}
              rows={5}
              value={userPrompt}
              onChange={(event) => setUserPrompt(event.target.value)}
            />
          )}
        </FormField>
        {!canWrite ? (
          <InlineNotice tone="warning" title="실행 권한이 없습니다.">
            {writeDeniedReason}
          </InlineNotice>
        ) : null}
        <div className="toolbar">
          <div className="toolbar-start">
            <Button
              variant="secondary"
              disabled={!canWrite || pending !== "" || parsed.models.length === 0}
              onClick={() => void call("predict")}
            >
              <Calculator aria-hidden="true" /> 예상 비용
            </Button>
            <Button
              variant="primary"
              disabled={!canWrite || pending !== "" || parsed.models.length === 0 || userPrompt.trim() === ""}
              onClick={() => void call("run")}
            >
              <Layers aria-hidden="true" /> {pending === "run" ? "실행 중" : "멀티 실행"}
            </Button>
          </div>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error.message}
            {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
          </p>
        ) : null}
        {predict ? (
          <InlineNotice tone="info" title="예상 비용">
            {`입력 토큰 ${formatNumber(predict.input_tokens ?? 0)} · 예상 합계 ${formatKRW(predict.total_cost_krw ?? 0)} · 가격 확인된 모델 ${formatNumber(predict.priced_models ?? 0)}개`}
          </InlineNotice>
        ) : null}
      </SectionCard>

      {run ? (
        <SectionCard title="비교 결과" description={run.run_id ? `실행 ID ${run.run_id}` : undefined}>
          <StatGrid label="비교 요약">
            <StatCard label="모델" value={formatNumber(run.summary?.total_models ?? run.results.length)} />
            <StatCard label="성공" value={formatNumber(run.summary?.success ?? 0)} tone="success" />
            <StatCard label="실패" value={formatNumber(run.summary?.failed ?? 0)} tone="warning" />
            <StatCard label="가장 빠른 모델" value={safeModelLabel(run.summary?.best_latency_model)} />
          </StatGrid>

          {run.run_id ? (
            <ChatRunActions
              runId={run.run_id}
              models={run.results.map((result) => result.model)}
              canWrite={canWrite}
              writeDeniedReason={writeDeniedReason}
              prompt={userPrompt}
            />
          ) : null}

          <div className="toolbar">
            <div className="toolbar-start">
              <FormField label="자동 평가 방식" id={`${fieldPrefix}-judge-method`}>
                {(control) => (
                  <Select
                    {...control}
                    value={judgeMethod}
                    onChange={(event) => setJudgeMethod(event.target.value === "model" ? "model" : "rule")}
                    options={[
                      { value: "rule", label: "규칙 기반" },
                      { value: "model", label: "심사 모델" },
                    ]}
                  />
                )}
              </FormField>
              {judgeMethod === "model" ? (
                <FormField label="심사 모델" id={`${fieldPrefix}-judge-model`} required>
                  {(control) => (
                    <Input
                      {...control}
                      value={judgeModel}
                      onChange={(event) => setJudgeModel(event.target.value)}
                    />
                  )}
                </FormField>
              ) : null}
              <Button
                variant="secondary"
                disabled={
                  !canWrite ||
                  pending !== "" ||
                  !run.run_id ||
                  (judgeMethod === "model" && judgeModel.trim() === "")
                }
                onClick={() => void call("judge")}
              >
                <Gavel aria-hidden="true" /> 자동 평가 실행
              </Button>
              <Button
                variant="secondary"
                disabled={pending !== "" || !run.run_id}
                onClick={() => void call("code")}
              >
                <ShieldAlert aria-hidden="true" /> 코드 위험 비교
              </Button>
            </div>
          </div>
          {judge ? (
            <InlineNotice tone="info" title="자동 평가 완료">
              {`방식 ${judge.method ?? judgeMethod} · 최고 점수 모델 ${safeModelLabel(judge.best_model)}`}
            </InlineNotice>
          ) : null}
          {codeRisk ? (
            <ul className="gateway-list">
              {(codeRisk.leaderboard ?? []).map((row, index) => (
                <li key={`${row.model ?? "model"}-${index}`}>
                  <strong>{safeModelLabel(row.model)}</strong>
                  <span>
                    {`위험도 ${row.risk ?? "-"} · 코드 블록 ${formatNumber(row.block_count ?? 0)} · 높음 ${formatNumber(row.high ?? 0)} · 보통 ${formatNumber(row.medium ?? 0)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <ul className="gateway-compare-grid">
            {run.results.map((result) => {
              const scored = judgeByModel.get(result.model);
              return (
                <li key={`${result.model}-${result.provider ?? ""}`} className="gateway-compare-card">
                  <header>
                    <strong>{safeModelLabel(result.model)}</strong>
                    <Badge tone={result.status === "success" ? "success" : "danger"}>
                      {chatStatusLabel(result.status)}
                    </Badge>
                  </header>
                  <dl className="kv-list" data-columns={2}>
                    <div className="kv-item">
                      <dt>지연</dt>
                      <dd>{formatNumber(result.latency_ms ?? null)} ms</dd>
                    </div>
                    <div className="kv-item">
                      <dt>토큰</dt>
                      <dd>
                        {formatNumber(result.input_tokens ?? null)} /{" "}
                        {formatNumber(result.output_tokens ?? null)}
                      </dd>
                    </div>
                    <div className="kv-item">
                      <dt>예상 비용</dt>
                      <dd>{formatKRW(result.cost_krw_est ?? 0)}</dd>
                    </div>
                    <div className="kv-item">
                      <dt>자동 평가</dt>
                      <dd>
                        {scored
                          ? `${formatNumber(scored.total_score ?? null, 1)}점 · ${judgeVerdictLabels[scored.verdict ?? ""] ?? scored.verdict ?? "-"}`
                          : "미실행"}
                      </dd>
                    </div>
                  </dl>
                  {result.error ? (
                    <p className="form-error" role="alert">
                      {result.error}
                    </p>
                  ) : (
                    <pre className="chat-turn-body mono">{result.content ?? ""}</pre>
                  )}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title="최근 실행 이력"
        description="저장된 멀티 모델 비교 실행입니다. 프롬프트 원문은 저장을 선택한 실행에만 남습니다."
        actions={
          <Button size="small" variant="ghost" onClick={() => void history.refetch()}>
            <History aria-hidden="true" /> 새로고침
          </Button>
        }
      >
        {history.isError ? (
          <InlineNotice tone="warning" title="이력을 불러오지 못했습니다.">
            {safeAppErrorMessage(history.error, "권한 또는 네트워크 상태를 확인하세요.")}
          </InlineNotice>
        ) : (history.data?.runs.length ?? 0) === 0 ? (
          <EmptyState
            title="저장된 비교 실행이 없습니다."
            description="멀티 실행을 한 번 수행하면 이력이 쌓입니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="최근 멀티 모델 실행 표 영역">
            <table className="data-table">
              <caption className="sr-only">최근 멀티 모델 비교 실행</caption>
              <thead>
                <tr>
                  <th scope="col">제목</th>
                  <th scope="col">모델</th>
                  <th scope="col">성공/실패</th>
                  <th scope="col">실행자</th>
                  <th scope="col">시각</th>
                </tr>
              </thead>
              <tbody>
                {(history.data?.runs ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.title || item.id}</td>
                    <td className="cell-number">{formatNumber(item.model_count ?? 0)}</td>
                    <td className="cell-number">
                      {formatNumber(item.success ?? 0)} / {formatNumber(item.failed ?? 0)}
                    </td>
                    <td>{item.created_by || "-"}</td>
                    <td>{formatDateTime(item.created_at)}</td>
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
