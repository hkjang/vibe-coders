import { FlaskConical, Gauge } from "lucide-react";
import { useState } from "react";

import type {
  WorkEvaluation,
  WorkIntelStatus,
  WorkPolicy,
  WorkPolicyConfig,
  WorkPolicyTestResult,
} from "@/shared/api/domains/insights-classification";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import { Textarea } from "@/shared/components/ui/Textarea";
import { formatNumber, formatPercent } from "@/shared/utils/format";

import {
  actionName,
  categoryName,
  categoryPath,
  classificationSamples,
  codingTaskTypes,
  formatConfidence,
  methodLabels,
  splitList,
  statusLabels,
  statusTones,
} from "./classification-model";
import { useClassificationTests } from "./use-classification";

interface TestTabProps {
  policy: WorkPolicy;
  draft: WorkPolicyConfig;
  /** The local draft has edits the server has not seen; a draft test runs the saved draft. */
  dirty: boolean;
  status: WorkIntelStatus | undefined;
  /** Tests are POSTs: the server asks for admin:write even though nothing is stored. */
  canRun: boolean;
  runReason?: string;
}

export function TestTab({
  policy,
  draft,
  dirty,
  status,
  canRun,
  runReason,
}: TestTabProps): React.JSX.Element {
  const { test, evaluate } = useClassificationTests();
  const [text, setText] = useState("");
  const [taskType, setTaskType] = useState("");
  const [languages, setLanguages] = useState("");
  const [mcpTools, setMcpTools] = useState("");
  const [client, setClient] = useState("");
  const [model, setModel] = useState("");
  const [useDraft, setUseDraft] = useState(true);
  const [wantsLLM, setWantsLLM] = useState(false);
  const [result, setResult] = useState<{ data: WorkPolicyTestResult; usedDraft: boolean } | undefined>();
  const [evalDraft, setEvalDraft] = useState(true);
  const [evaluation, setEvaluation] = useState<{ data: WorkEvaluation; usedDraft: boolean } | undefined>();

  const llmAvailable = status?.llm_enabled === true;
  const useLLM = wantsLLM && llmAvailable;
  const neverPublished = policy.published_version === 0;
  // Names come from the policy the test ran against as far as the console has it.
  const categories = draft.categories;

  const run = (): void => {
    if (!canRun || text.trim() === "" || test.isPending) return;
    test.mutate(
      {
        text,
        taskType,
        languages: splitList(languages),
        mcpTools: splitList(mcpTools),
        client: client.trim(),
        model: model.trim(),
        useDraft,
        useLLM,
      },
      { onSuccess: (data) => setResult({ data, usedDraft: useDraft }) },
    );
  };

  return (
    <>
      {!canRun ? (
        <InlineNotice tone="info" title="읽기 전용입니다.">
          {runReason ?? "분류 테스트는 admin:write 권한이 필요합니다."} 테스트와 정확도 확인은 아무것도
          저장하지 않지만 서버가 변경 권한을 요구합니다.
        </InlineNotice>
      ) : null}

      <SectionCard
        headingLevel={3}
        title="샘플 분류"
        description="문장 하나를 정책으로 분류해 보고, 어떤 근거로 어떤 카테고리가 후보가 됐는지 확인합니다. 결과는 저장되지 않고 통계에도 들어가지 않습니다."
      >
        <form
          className="wc-test-form"
          onSubmit={(event) => {
            event.preventDefault();
            run();
          }}
        >
          <div className="wc-samples" role="group" aria-label="예시 문장">
            <span className="wc-muted">예시(가상의 문장):</span>
            {classificationSamples.map((sample) => (
              <Button
                key={sample.id}
                size="small"
                variant="ghost"
                onClick={() => {
                  setText(sample.text);
                  setTaskType(sample.taskType ?? "");
                  setLanguages((sample.languages ?? []).join(", "));
                  setMcpTools((sample.mcpTools ?? []).join(", "));
                  setClient(sample.client ?? "");
                }}
              >
                {sample.label}
              </Button>
            ))}
          </div>
          <FormField
            label="분류할 텍스트"
            required
            description="실제 고객 정보나 비밀값은 넣지 마세요. 서버는 실제 요청과 같이 텍스트를 가린 뒤 분류합니다."
          >
            {(control) => (
              <Textarea
                {...control}
                rows={4}
                value={text}
                maxLength={8000}
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </FormField>
          <div className="wc-form-grid">
            <FormField
              label="코딩 작업 유형"
              description="요청 경로가 붙이는 값입니다. 비우면 없는 것으로 봅니다."
            >
              {(control) => (
                <Select {...control} value={taskType} onChange={(event) => setTaskType(event.target.value)}>
                  <option value="">지정 안 함</option>
                  {codingTaskTypes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="언어" description="쉼표로 구분합니다. 예: go, sql">
              {(control) => (
                <Input
                  {...control}
                  value={languages}
                  autoComplete="off"
                  onChange={(event) => setLanguages(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="MCP 도구" description="쉼표로 구분합니다. 예: kubectl_logs">
              {(control) => (
                <Input
                  {...control}
                  value={mcpTools}
                  autoComplete="off"
                  onChange={(event) => setMcpTools(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="클라이언트" description="예: Claude Code, Cursor">
              {(control) => (
                <Input
                  {...control}
                  value={client}
                  autoComplete="off"
                  onChange={(event) => setClient(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="모델">
              {(control) => (
                <Input
                  {...control}
                  value={model}
                  autoComplete="off"
                  onChange={(event) => setModel(event.target.value)}
                />
              )}
            </FormField>
          </div>
          <div className="wc-toggle-grid">
            <div>
              <Switch
                checked={useDraft}
                label="초안으로 검사"
                onCheckedChange={setUseDraft}
                disabled={neverPublished}
              />
              <p className="wc-muted wc-note">
                {neverPublished
                  ? "아직 배포한 버전이 없어 저장된 초안으로만 검사합니다."
                  : useDraft
                    ? `저장된 초안(리비전 ${policy.revision})으로 검사합니다.`
                    : `배포된 정책 버전 ${policy.published_version}으로 검사합니다.`}
              </p>
            </div>
            <div>
              <Switch
                checked={useLLM}
                label="LLM 사용"
                onCheckedChange={setWantsLLM}
                disabled={!llmAvailable}
                aria-describedby="wc-llm-toggle-note"
              />
              <p id="wc-llm-toggle-note" className="wc-muted wc-note">
                {llmAvailable
                  ? `규칙으로 확정되지 않으면 분류 모델(${status?.llm_model || "설정된 모델"})에 묻습니다. 실제 모델 호출이라 비용이 듭니다.`
                  : "LLM 분류가 꺼져 있어 규칙과 캐시만으로 검사합니다. 시스템 설정의 WORK_INTEL_LLM_ENABLED 로 켤 수 있습니다."}
              </p>
            </div>
          </div>
          {dirty && useDraft ? (
            <InlineNotice tone="warning" title="저장하지 않은 변경은 검사에 반영되지 않습니다.">
              서버에 저장된 초안으로 검사합니다. 지금 편집 중인 내용으로 검사하려면 먼저 저장하세요.
            </InlineNotice>
          ) : null}
          <div className="wc-form-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={!canRun || text.trim() === "" || test.isPending}
              title={canRun ? undefined : runReason}
            >
              <FlaskConical aria-hidden="true" /> {test.isPending ? "분류 중" : "분류"}
            </Button>
          </div>
        </form>

        {result ? (
          <TestResult
            result={result.data}
            usedDraft={result.usedDraft}
            categories={categories}
            draft={draft}
          />
        ) : null}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="정확도 확인"
        description="관리자가 검토 탭에서 보정한 이력을 정답으로 삼아, 정책이 그 요청들을 얼마나 맞게 분류하는지 계산합니다."
      >
        <div className="wc-eval-form">
          <FormField label="평가할 정책">
            {(control) => (
              <Select
                {...control}
                value={evalDraft || neverPublished ? "draft" : "published"}
                onChange={(event) => setEvalDraft(event.target.value === "draft")}
              >
                <option value="draft">초안 (리비전 {policy.revision})</option>
                <option value="published" disabled={neverPublished}>
                  배포본{neverPublished ? " (없음)" : ` (버전 ${policy.published_version})`}
                </option>
              </Select>
            )}
          </FormField>
          <Button
            disabled={!canRun || evaluate.isPending}
            title={canRun ? undefined : runReason}
            onClick={() => {
              const usedDraft = evalDraft || neverPublished;
              evaluate.mutate(
                { useDraft: usedDraft, limit: 500 },
                { onSuccess: (data) => setEvaluation({ data, usedDraft }) },
              );
            }}
          >
            <Gauge aria-hidden="true" /> {evaluate.isPending ? "평가 중" : "정확도 확인"}
          </Button>
        </div>
        {dirty && (evalDraft || neverPublished) ? (
          <p className="wc-muted wc-note">저장하지 않은 변경은 평가에 반영되지 않습니다.</p>
        ) : null}
        {evaluation ? (
          <EvaluationResult evaluation={evaluation.data} usedDraft={evaluation.usedDraft} draft={draft} />
        ) : null}
      </SectionCard>
    </>
  );
}

function TestResult({
  result,
  usedDraft,
  categories,
  draft,
}: {
  result: WorkPolicyTestResult;
  usedDraft: boolean;
  categories: WorkPolicyConfig["categories"];
  draft: WorkPolicyConfig;
}): React.JSX.Element {
  const outcome = result.result;
  const categoryId = outcome.category?.id ?? outcome.category_id;
  const path = categoryPath(categories, categoryId);
  const pathLabel =
    path.length > 0 && categories.some((category) => category.id === categoryId)
      ? path.join(" › ")
      : outcome.category?.name || path.join(" › ") || "분류 없음";
  return (
    <section className="wc-test-result" aria-label="분류 결과">
      <h4 className="wc-subheading">
        분류 결과 <span className="wc-muted">({usedDraft ? "초안" : "배포본"} 기준)</span>
      </h4>
      <div className="wc-result-head">
        <strong className="wc-result-path">{pathLabel}</strong>
        {categoryId ? <code>{categoryId}</code> : null}
        <Badge tone={statusTones[outcome.status] ?? "muted"}>
          {statusLabels[outcome.status] ?? (outcome.status || "상태 없음")}
        </Badge>
      </div>
      <KeyValueList
        columns={3}
        items={[
          { label: "작업 유형", value: actionName(draft, outcome.action_type) },
          { label: "신뢰도", value: formatConfidence(outcome.confidence) },
          { label: "방식", value: methodLabels[outcome.method] ?? outcome.method },
          { label: "업무 제목", value: outcome.work_title },
          { label: "태그", value: outcome.tags.join(", ") },
          { label: "기술", value: outcome.technologies.join(", ") },
        ]}
      />
      {outcome.new_category_hint ? (
        <p className="wc-note">
          신규 카테고리 후보: <strong>{outcome.new_category_hint}</strong>
        </p>
      ) : null}
      {result.llm.error ? (
        <InlineNotice tone="warning" title="LLM 분류에 실패했습니다.">
          {result.llm.error}
        </InlineNotice>
      ) : (
        <p className="wc-muted wc-note">
          {result.llm.used ? "분류 모델에 물어 얻은 결과입니다." : "분류 모델은 쓰지 않았습니다."}
        </p>
      )}

      <h4 className="wc-subheading">후보 카테고리와 근거</h4>
      {result.candidates.length === 0 ? (
        <EmptyState
          title="근거가 맞은 카테고리가 없습니다."
          description="카테고리 탭에서 키워드나 MCP 도구 같은 규칙을 추가해 보세요."
        />
      ) : (
        <div className="data-table-scroll" tabIndex={0} aria-label="후보 카테고리 표 영역">
          <table className="data-table">
            <caption className="sr-only">후보 카테고리</caption>
            <thead>
              <tr>
                <th scope="col">카테고리</th>
                <th scope="col">점수</th>
                <th scope="col">근거</th>
              </tr>
            </thead>
            <tbody>
              {result.candidates.map((candidate) => (
                <tr key={candidate.category.id}>
                  <th scope="row">
                    <span className="wc-stack">
                      <span>
                        {categoryPath(categories, candidate.category.id).join(" › ") ||
                          candidate.category.name}
                      </span>
                      <code className="wc-muted">{candidate.category.id}</code>
                    </span>
                  </th>
                  <td>{formatNumber(candidate.score, 2)}</td>
                  <td>
                    {candidate.evidence.length > 0 ? (
                      <span className="wc-chips">
                        {candidate.evidence.map((item, index) => (
                          <span key={`${item}:${index}`} className="wc-chip">
                            {item}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="wc-muted">근거 없음</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EvaluationResult({
  evaluation,
  usedDraft,
  draft,
}: {
  evaluation: WorkEvaluation;
  usedDraft: boolean;
  draft: WorkPolicyConfig;
}): React.JSX.Element {
  const name = (id: string): string => categoryName(draft.categories, id);
  if (evaluation.accuracy === null) {
    return (
      <InlineNotice tone="info" title="아직 정확도를 계산할 수 없습니다.">
        {evaluation.note || "보정 이력이 충분히 쌓이면 정확도를 계산합니다."} (표본{" "}
        {formatNumber(evaluation.sample)}
        건)
      </InlineNotice>
    );
  }
  return (
    <section className="wc-test-result" aria-label="정확도 확인 결과">
      <h4 className="wc-subheading">
        정확도 <span className="wc-muted">({usedDraft ? "초안" : "배포본"} 기준)</span>
      </h4>
      <KeyValueList
        columns={3}
        items={[
          { label: "표본", value: `${formatNumber(evaluation.sample)}건` },
          { label: "정확도", value: formatPercent(evaluation.accuracy) },
          { label: "대분류 정확도", value: formatPercent(evaluation.top_accuracy) },
        ]}
      />
      {evaluation.note ? <p className="wc-muted wc-note">{evaluation.note}</p> : null}
      <div className="wc-eval-tables">
        <div className="data-table-scroll" tabIndex={0} aria-label="카테고리별 정확도 표 영역">
          <table className="data-table">
            <caption className="sr-only">카테고리별 정확도</caption>
            <thead>
              <tr>
                <th scope="col">카테고리</th>
                <th scope="col">보정 건수</th>
                <th scope="col">맞음</th>
                <th scope="col">정확도</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.by_category.map((row) => (
                <tr key={row.category.id}>
                  <th scope="row">{row.category.name || name(row.category.id)}</th>
                  <td>{formatNumber(row.total)}</td>
                  <td>{formatNumber(row.correct)}</td>
                  <td>{row.total > 0 ? formatPercent(row.correct / row.total) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="data-table-scroll" tabIndex={0} aria-label="자주 헷갈린 분류 표 영역">
          <table className="data-table">
            <caption className="sr-only">자주 헷갈린 분류</caption>
            <thead>
              <tr>
                <th scope="col">정답(보정한 분류)</th>
                <th scope="col">정책이 낸 분류</th>
                <th scope="col">건수</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.confusions.length === 0 ? (
                <tr>
                  <td colSpan={3} className="wc-muted">
                    헷갈린 분류가 없습니다.
                  </td>
                </tr>
              ) : (
                evaluation.confusions.map((row) => (
                  <tr key={`${row.expected}>${row.got}`}>
                    <th scope="row">{name(row.expected)}</th>
                    <td>{name(row.got)}</td>
                    <td>{formatNumber(row.count)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
