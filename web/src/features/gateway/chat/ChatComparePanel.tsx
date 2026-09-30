import { useCallback, useId, useMemo, useState } from "react";
import { Calculator, Gavel, Layers, ShieldAlert } from "lucide-react";

import {
  chatStatusLabel,
  judgeVerdictLabels,
  maxCompareModels,
  parseCompareModels,
  safeModelLabel,
} from "@/features/gateway/chat/chat-console";
import { ChatRunActions } from "@/features/gateway/chat/ChatRunActions";
import { useCompareAccess, type CompareAccess } from "./use-compare-access";
import { useComparisonConsole } from "./use-comparison-console";
import { ChatComparisonHistory } from "./ChatComparisonHistory";
import type { MultiRunBody } from "@/shared/api/domains/gateway";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormField } from "@/shared/components/form/FormField";
import { formatKRW, formatNumber } from "@/shared/utils/format";

interface ChatComparePanelProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

const defaultModels = "vibe/auto\n";

export function ChatComparePanel({ canWrite, writeDeniedReason }: ChatComparePanelProps): React.JSX.Element {
  const access = useCompareAccess(canWrite, writeDeniedReason);
  return (
    <ComparisonSession
      key={`${access.epoch}:${access.owner ?? "missing"}:${String(access.known)}`}
      access={access}
      canWrite={canWrite}
      writeDeniedReason={writeDeniedReason}
    />
  );
}

// Only security ownership remounts this state. Run, scope and readonly changes
// keep the user's inputs and open result-action drafts in the same instance.
function ComparisonSession({
  access,
  canWrite,
  writeDeniedReason,
}: ChatComparePanelProps & { access: CompareAccess }): React.JSX.Element {
  const fieldPrefix = useId();
  const [title, setTitle] = useState("");
  const [modelLines, setModelLines] = useState(defaultModels);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [temperature, setTemperature] = useState("0");
  const [judgeMethod, setJudgeMethod] = useState<"rule" | "model">("rule");
  const [judgeModel, setJudgeModel] = useState("");

  const parsed = useMemo(() => parseCompareModels(modelLines), [modelLines]);

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
      // Raw prompt storage is off for this run; hashes/response previews follow
      // server policy and an explicit Golden write separately stores the prompt.
      save_prompt: false,
    };
  }, [maxTokens, parsed.models, systemPrompt, temperature, title, userPrompt]);

  const { run, runPrompt, predict, judge, codeRisk, pending, error, history, refreshHistory, call } =
    useComparisonConsole(access, { body, judgeMethod, judgeModel });

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
          <FormField label="응답 다양성 (Temperature)" id={`${fieldPrefix}-temperature`}>
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
        <FormField label="시스템 지침" id={`${fieldPrefix}-system`}>
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="사용자 질문" id={`${fieldPrefix}-user`} required>
          {(control) => (
            <Textarea
              {...control}
              rows={5}
              value={userPrompt}
              onChange={(event) => setUserPrompt(event.target.value)}
            />
          )}
        </FormField>
        {!access.write.allowed ? (
          <InlineNotice tone="warning" title="새 실행과 저장이 제한됩니다.">
            {access.write.reason} 입력은 유지되며, 권한을 복구한 뒤 수동으로 다시 실행할 수 있습니다.
          </InlineNotice>
        ) : null}
        <div className="toolbar">
          <div className="toolbar-start">
            <Button
              variant="secondary"
              disabled={!access.predictAllowed || pending !== "" || parsed.models.length === 0}
              onClick={() => void call("predict")}
            >
              <Calculator aria-hidden="true" /> 예상 비용
            </Button>
            <Button
              variant="primary"
              disabled={
                !access.write.allowed ||
                pending !== "" ||
                parsed.models.length === 0 ||
                userPrompt.trim() === ""
              }
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
              prompt={runPrompt}
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
                  !access.write.allowed ||
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
                disabled={!access.readAllowed || pending !== "" || !run.run_id}
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
          {codeRisk && access.readAllowed ? (
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

      <ChatComparisonHistory history={history} refresh={refreshHistory} access={access} />
    </div>
  );
}
