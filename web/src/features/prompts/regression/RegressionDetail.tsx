import { useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import type { GoldenPrompt, GoldenResult, GoldenWorkflow } from "@/shared/api/domains/golden";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Sheet } from "@/shared/components/ui/Sheet";
import { DataTable } from "@/shared/data-table/DataTable";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";
import { canLinkRegressionID, safeRegressionText, type RegressionTab } from "./regression-model";
import { RegressionQueryState } from "./RegressionQueryState";
import { RegressionText } from "./RegressionText";
import { useGoldenPrompts } from "./use-regression";
import { editableDefinition, type DefinitionTarget } from "./editor/definition-form";

const resultHelper = createDataTableColumnHelper<GoldenResult>();
const historyColumns = [
  resultHelper.display({ id: "model", header: "모델", cell: ({ row }) => row.original.model }),
  resultHelper.display({
    id: "passed",
    header: "검사 결과",
    cell: ({ row }) => (
      <Badge tone={row.original.passed ? "success" : "danger"}>
        {row.original.passed ? "통과" : "미통과"}
      </Badge>
    ),
  }),
  resultHelper.display({
    id: "score",
    header: "일치 점수 (0–1)",
    cell: ({ row }) => formatNumber(row.original.score, 2),
  }),
  resultHelper.display({
    id: "cost",
    header: "비용 (원)",
    cell: ({ row }) => formatKRW(row.original.cost_krw),
  }),
  resultHelper.display({
    id: "latency",
    header: "지연",
    cell: ({ row }) => formatDuration(row.original.latency_ms),
  }),
  resultHelper.display({
    id: "time",
    header: "실행 시각",
    cell: ({ row }) => formatDateTime(row.original.created_at),
  }),
  resultHelper.display({
    id: "response",
    header: "응답",
    cell: ({ row }) => (
      <details>
        <summary>응답 보기</summary>
        <RegressionText label="저장된 응답" value={row.original.response} />
      </details>
    ),
  }),
];

function PromptDetail({
  owner,
  id,
  edit,
}: {
  owner: FeatureReadOwner;
  id: string;
  edit?: (target: DefinitionTarget) => void;
}) {
  const { credentialPrefixes } = useAuth();
  const permittedID = canLinkRegressionID(id, credentialPrefixes);
  const query = useGoldenPrompts(owner, 200, id, permittedID);
  const [page, setPage] = useState(0);
  if (!permittedID)
    return <InlineNotice tone="warning">이 식별자로는 개별 결과를 정확히 조회할 수 없습니다.</InlineNotice>;
  const prompt = query.data?.golden_prompts.find((item) => item.id === id);
  const results = query.data?.results ?? [];
  const pages = Math.max(1, Math.ceil(results.length / 25));
  const current = Math.min(page, pages - 1);
  return (
    <div className="page-stack">
      <RegressionQueryState
        error={query.error}
        updatedAt={query.dataUpdatedAt}
        fetching={query.isFetching}
        retry={() => void query.refetch()}
      />
      {query.isPending ? <LoadingState label="프롬프트와 최근 결과를 조회하는 중입니다." /> : null}
      {!query.isPending && !query.isError && !prompt ? (
        <EmptyState
          title="현재 등록된 프롬프트를 찾지 못했습니다."
          description="삭제되었거나 더 이상 조회할 수 없는 항목입니다. 저장된 결과는 아래에서 확인할 수 있습니다."
        />
      ) : null}
      {prompt ? (
        <>
          <h3>{prompt.name || "이름 없음"}</h3>
          <DefinitionEdit
            target={{ kind: "prompt", id, original: prompt }}
            edit={!query.isError && !query.isFetching ? edit : undefined}
          />
          <DefinitionMetadata row={prompt} />
          <RegressionText label="현재 기준 프롬프트" value={prompt.prompt} />
          <RegressionText label="현재 기대 내용" value={prompt.expected} />
        </>
      ) : null}
      <InlineNotice title="이 프롬프트의 최근 저장 결과 · 최대 200건">
        등록된 기준은 현재 값입니다. 과거 실행 시점의 기준 스냅샷은 기록되지 않아 현재 정의와 동일한지 확인할
        수 없습니다. 기대 내용이 비어 있으면 일치 점수 0으로도 통과할 수 있습니다. 통과는 서버의 문자열 검사
        결과이며 품질 전체를 보장하지 않습니다.
      </InlineNotice>
      <DataTable
        caption="선택한 프롬프트의 최근 결과"
        columns={historyColumns}
        data={results.slice(current * 25, (current + 1) * 25)}
        getRowId={(row) => row.id}
        loading={query.isPending}
        error={query.isError && !query.data ? "최근 결과를 조회하지 못했습니다." : undefined}
        onRetry={() => void query.refetch()}
        pageIndex={current}
        pageCount={pages}
        onPageChange={setPage}
        emptyMessage="이 프롬프트에 저장된 최근 결과가 없습니다."
      />
    </div>
  );
}

function DefinitionEdit({
  target,
  edit,
}: {
  target: DefinitionTarget;
  edit?: (target: DefinitionTarget) => void;
}) {
  const { credentialPrefixes } = useAuth();
  if (!edit) return null;
  const editable = editableDefinition(target, credentialPrefixes);
  return editable ? (
    <Button onClick={() => edit(structuredClone(target))}>정의 편집</Button>
  ) : (
    <InlineNotice tone="warning">원본 일부가 숨겨져 있거나 단계 정보가 없어 편집할 수 없습니다.</InlineNotice>
  );
}

function DefinitionMetadata({ row }: { row: GoldenPrompt | GoldenWorkflow }) {
  const { credentialPrefixes } = useAuth();
  return (
    <dl className="regression-metadata">
      <dt>식별자</dt>
      <dd>{safeRegressionText(row.id, credentialPrefixes)}</dd>
      <dt>태그</dt>
      <dd>{row.tags?.join(", ") || "미등록"}</dd>
      <dt>등록 시각</dt>
      <dd>{formatDateTime(row.created_at)}</dd>
      <dt>수정 시각</dt>
      <dd>{formatDateTime(row.updated_at)}</dd>
    </dl>
  );
}

function WorkflowDetail({ workflow }: { workflow: GoldenWorkflow }) {
  const [page, setPage] = useState(0);
  const steps = workflow.steps;
  const pages = Math.max(1, Math.ceil((steps?.length ?? 0) / 10));
  const current = Math.min(page, pages - 1);
  return (
    <div className="page-stack">
      <DefinitionMetadata row={workflow} />
      <RegressionText label="설명" value={workflow.description} />
      <InlineNotice title="독립적인 프롬프트를 순서대로 검사합니다.">
        앞 단계의 출력이 다음 단계로 전달되지 않습니다. 아래 기준 점수는 등록 시 참고 정보이며 현재 검증
        결과가 아닙니다. 기존 API에는 워크플로 실행 이력 조회가 없습니다.
      </InlineNotice>
      {steps === null ? (
        <InlineNotice tone="warning" title="단계 정보를 확인할 수 없습니다.">
          등록된 단계가 없거나 저장된 정의를 해석할 수 없습니다. 정상적인 빈 세트로 간주하지 않습니다.
        </InlineNotice>
      ) : steps.length === 0 ? (
        <EmptyState title="등록된 검증 단계가 없습니다." />
      ) : (
        <>
          <p>
            전체 {steps.length}단계 중 {current * 10 + 1}–{Math.min((current + 1) * 10, steps.length)}단계
          </p>
          <ol className="regression-steps" start={current * 10 + 1}>
            {steps.slice(current * 10, (current + 1) * 10).map((step, index) => (
              <li className="regression-step" key={current * 10 + index}>
                <h3>{step.name || `검증 단계 ${current * 10 + index + 1}`}</h3>
                <RegressionText label="검사 프롬프트" value={step.prompt} />
                <RegressionText label="기대 내용" value={step.expected} />
                <dl className="regression-metadata">
                  <dt>선택 모델</dt>
                  <dd>{step.selected_model || "미등록"}</dd>
                  <dt>등록 시 기준 점수</dt>
                  <dd>
                    {step.baseline_score === undefined ? "미기록" : formatNumber(step.baseline_score, 2)}
                  </dd>
                  <dt>작업 유형</dt>
                  <dd>{step.task_type || "미등록"}</dd>
                  <dt>출력 계약</dt>
                  <dd>{step.contract_id || "미등록"}</dd>
                  <dt>평가 기준</dt>
                  <dd>{step.rubric_id || "미등록"}</dd>
                  <dt>원본 실행</dt>
                  <dd>{step.source_run_id || "미기록"}</dd>
                </dl>
              </li>
            ))}
          </ol>
          {pages > 1 ? (
            <nav className="toolbar" aria-label="워크플로 단계 페이지">
              <Button disabled={current === 0} onClick={() => setPage(current - 1)}>
                이전 단계
              </Button>
              <span>
                {current + 1} / {pages}
              </span>
              <Button disabled={current === pages - 1} onClick={() => setPage(current + 1)}>
                다음 단계
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function ResultDetail({ result }: { result: GoldenResult }) {
  const { credentialPrefixes } = useAuth();
  return (
    <div className="page-stack">
      <Badge tone={result.passed ? "success" : "danger"}>{result.passed ? "통과" : "미통과"}</Badge>
      <dl className="regression-metadata">
        <dt>결과 식별자</dt>
        <dd>{safeRegressionText(result.id, credentialPrefixes)}</dd>
        <dt>프롬프트 식별자</dt>
        <dd>{safeRegressionText(result.prompt_id, credentialPrefixes)}</dd>
        <dt>모델</dt>
        <dd>{result.model || "미기록"}</dd>
        <dt>일치 점수 (0–1)</dt>
        <dd>{formatNumber(result.score, 2)}</dd>
        <dt>비용</dt>
        <dd>{formatKRW(result.cost_krw)}</dd>
        <dt>지연</dt>
        <dd>{formatDuration(result.latency_ms)}</dd>
        <dt>실행 시각</dt>
        <dd>{formatDateTime(result.created_at)}</dd>
      </dl>
      <InlineNotice>
        통과 여부는 저장된 서버 검사 결과입니다. 기대 내용이 비어 있으면 점수가 0이어도 통과할 수 있으며, 실패
        원인과 모델 품질 전체를 뜻하지 않습니다.
      </InlineNotice>
      <RegressionText label="저장된 응답" value={result.response} />
    </div>
  );
}

export function RegressionDetail({
  owner,
  tab,
  id,
  workflows,
  results,
  loading,
  error,
  updatedAt,
  retry,
  close,
  returnFocusRef,
  edit,
}: {
  owner: FeatureReadOwner;
  tab: RegressionTab;
  id: string;
  workflows: readonly GoldenWorkflow[];
  results: readonly GoldenResult[];
  loading: boolean;
  error: unknown;
  updatedAt: number;
  retry: () => void;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  edit?: (target: DefinitionTarget) => void;
}) {
  const workflow = workflows.find((row) => row.id === id);
  const result = results.find((row) => row.id === id);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      returnFocusRef={returnFocusRef}
      size="wide"
      title={
        tab === "prompts"
          ? "기준 프롬프트 상세"
          : tab === "workflows"
            ? "검증 워크플로 상세"
            : "실행 결과 상세"
      }
      description="저장된 정의와 결과를 확인합니다."
      footer={<Button onClick={close}>닫기</Button>}
    >
      {tab === "prompts" ? (
        <PromptDetail key={id} owner={owner} id={id} edit={edit} />
      ) : (
        <>
          <RegressionQueryState error={error} updatedAt={updatedAt} fetching={loading} retry={retry} />
          {loading && !updatedAt ? (
            <LoadingState />
          ) : workflow && tab === "workflows" ? (
            <>
              <DefinitionEdit
                target={{ kind: "workflow", id, original: workflow }}
                edit={!error && !loading ? edit : undefined}
              />
              <WorkflowDetail key={id} workflow={workflow} />
            </>
          ) : result && tab === "results" ? (
            <ResultDetail result={result} />
          ) : !error ? (
            <EmptyState
              title="현재 조회 범위에서 항목을 찾지 못했습니다."
              description="삭제되었거나 최근 결과 범위에서 벗어났을 수 있습니다. 목록을 다시 조회하세요."
            />
          ) : null}
        </>
      )}
    </Sheet>
  );
}
