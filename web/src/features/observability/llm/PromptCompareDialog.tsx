import { useQuery } from "@tanstack/react-query";
import { useState, type RefObject } from "react";

import { apiClient } from "@/shared/api/client";
import type { LLMScopeQuery } from "@/shared/api/domains/observability";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Select } from "@/shared/components/ui/Select";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

interface PromptCompareDialogProps {
  onOpenChange: (open: boolean) => void;
  prompt: { name: string; version: string } | undefined;
  returnFocusRef: RefObject<HTMLElement | null>;
  scope: LLMScopeQuery;
}

function signed(value: number, format: (input: number) => string): string {
  return `${value > 0 ? "+" : ""}${format(value)}`;
}

/** Compares one prompt version against a baseline (GET /admin/llm/prompts/compare). */
export function PromptCompareDialog({
  onOpenChange,
  prompt,
  returnFocusRef,
  scope,
}: PromptCompareDialogProps): React.JSX.Element {
  const [baseline, setBaseline] = useState("");
  const open = prompt !== undefined;

  const comparison = useQuery({
    queryKey: ["observability", "llm", "prompt-compare", prompt?.name, prompt?.version, baseline, scope],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.promptCompare, {
        query: {
          ...scope,
          prompt_name: prompt?.name ?? "",
          ...(prompt?.version ? { candidate: prompt.version } : {}),
          ...(baseline ? { baseline } : {}),
        },
        signal,
        routeId: "observability.llm.prompt-compare",
      }),
    enabled: open && (prompt?.name ?? "") !== "",
    staleTime: 30_000,
  });

  const data = comparison.data;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title="프롬프트 버전 비교"
      description="선택한 버전과 기준 버전의 호출량, 비용, 오류율을 비교합니다."
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          닫기
        </Button>
      }
    >
      {comparison.isPending && open ? (
        <div role="status" aria-live="polite">
          비교 결과를 불러오는 중입니다.
        </div>
      ) : null}
      {comparison.isError ? (
        <InlineNotice
          tone="danger"
          title="비교 결과를 불러오지 못했습니다."
          actions={
            <Button size="small" onClick={() => void comparison.refetch()}>
              다시 시도
            </Button>
          }
        >
          {safeAppErrorMessage(comparison.error, "비교 결과를 불러오지 못했습니다.")}
          {isAppError(comparison.error) && comparison.error.requestId ? (
            <span className="request-id"> 요청 ID: {comparison.error.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}
      {data ? (
        <div className="obs-section-stack">
          <label>
            기준 버전
            <Select
              value={baseline}
              onChange={(event) => setBaseline(event.target.value)}
              options={[
                { value: "", label: "자동 선택" },
                ...data.available_versions
                  .filter((version) => version !== data.candidate.prompt_version)
                  .map((version) => ({ value: version, label: version })),
              ]}
            />
          </label>
          <KeyValueList
            items={[
              { label: "프롬프트", value: data.prompt_name },
              { label: "비교 버전", value: data.candidate.prompt_version },
              { label: "기준 버전", value: data.baseline?.prompt_version ?? "없음" },
              { label: "기준 선정 사유", value: data.baseline_reason },
            ]}
          />
          <div className="data-table-scroll" tabIndex={0} aria-label="프롬프트 비교 표 영역">
            <table className="data-table">
              <caption className="sr-only">비교 버전과 기준 버전의 지표</caption>
              <thead>
                <tr>
                  <th scope="col">지표</th>
                  <th scope="col">비교 버전</th>
                  <th scope="col">기준 버전</th>
                  <th scope="col">차이</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">호출</th>
                  <td className="cell-number">{formatNumber(data.candidate.calls)}</td>
                  <td className="cell-number">{formatNumber(data.baseline?.calls ?? 0)}</td>
                  <td className="cell-number">{signed(data.delta.calls, formatNumber)}</td>
                </tr>
                <tr>
                  <th scope="row">토큰</th>
                  <td className="cell-number">{formatNumber(data.candidate.tokens)}</td>
                  <td className="cell-number">{formatNumber(data.baseline?.tokens ?? 0)}</td>
                  <td className="cell-number">{signed(data.delta.tokens, formatNumber)}</td>
                </tr>
                <tr>
                  <th scope="row">비용</th>
                  <td className="cell-number">{formatKRW(data.candidate.cost_krw)}</td>
                  <td className="cell-number">{formatKRW(data.baseline?.cost_krw ?? 0)}</td>
                  <td className="cell-number">{signed(data.delta.cost_krw, formatKRW)}</td>
                </tr>
                <tr>
                  <th scope="row">평균 지연</th>
                  <td className="cell-number">{formatNumber(data.candidate.average_latency_ms)}ms</td>
                  <td className="cell-number">{formatNumber(data.baseline?.average_latency_ms ?? 0)}ms</td>
                  <td className="cell-number">
                    {signed(data.delta.average_latency_ms, (value) => `${formatNumber(value)}ms`)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">오류율</th>
                  <td className="cell-number">{formatPercent(data.candidate_error_rate)}</td>
                  <td className="cell-number">{formatPercent(data.baseline_error_rate)}</td>
                  <td className="cell-number">{signed(data.delta.error_rate, formatPercent)}</td>
                </tr>
                <tr>
                  <th scope="row">평가 실패율</th>
                  <td className="cell-number">{formatPercent(data.candidate_eval_failure_rate)}</td>
                  <td className="cell-number">{formatPercent(data.baseline_eval_failure_rate)}</td>
                  <td className="cell-number">{signed(data.delta.eval_failure_rate, formatPercent)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
