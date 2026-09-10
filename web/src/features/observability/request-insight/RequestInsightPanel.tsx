import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  noteWriteDeniedReason,
  rawAccessDeniedReason,
} from "@/features/observability/request-insight/request-access";
import { RequestSpanWaterfall } from "@/features/observability/request-insight/RequestSpanWaterfall";
import { apiClient } from "@/shared/api/client";
import type { RequestExplain } from "@/shared/api/domains/observability.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";
import "@/features/observability/request-insight/request-insight.css";

const routeId = "observability.request-insight";

interface RequestInsightPanelProps {
  /** Operator may write the request note (`admin:write`). */
  canWriteNote: boolean;
  /** Operator may read prompt originals, so analysis and replay are allowed. */
  canInspectRaw: boolean;
  requestId: string;
}

const noteFormSchema = z.object({
  tags: z.string().trim().max(200, "태그는 200자까지 입력할 수 있습니다."),
  note: z
    .string()
    .trim()
    .max(2000, "메모는 2000자까지 입력할 수 있습니다.")
    .refine((value) => !containsPotentialSecret(value), secretSearchMessage),
});
type NoteFormValues = z.infer<typeof noteFormSchema>;

function requestErrorText(error: unknown, fallback: string): string {
  const requestId = isAppError(error) ? error.requestId : undefined;
  return `${safeAppErrorMessage(error, fallback)}${requestId ? ` (요청 ID: ${requestId})` : ""}`;
}

function explainItems(explain: RequestExplain): Array<{ label: string; value: string }> {
  const { cache, cost, routing } = explain;
  return [
    { label: "선택된 Provider", value: routing.chosen_provider || "—" },
    { label: "선택된 모델", value: routing.chosen_model || "—" },
    {
      label: "요청한 모델",
      value: routing.model_changed
        ? `${routing.requested_model || "—"} → ${routing.chosen_model}`
        : "변경 없음",
    },
    { label: "라우팅 사유", value: routing.reason_text || routing.reason || "—" },
    { label: "복잡도", value: `${formatNumber(routing.complexity)} (${routing.tier || "—"})` },
    { label: "위험 점수", value: `${formatNumber(routing.risk_score)} (${routing.risk_tier || "—"})` },
    { label: "건전성 점수", value: formatNumber(routing.health_score) },
    { label: "엔드포인트", value: routing.endpoint || "—" },
    { label: "캐시", value: cache.hit ? "적중" : "미적중" },
    { label: "캐시 토큰", value: formatNumber(cache.cached_tokens) },
    { label: "실제 비용", value: formatKRW(cost.actual_krw) },
    { label: "정가 대비", value: cost.priced ? formatKRW(cost.list_krw) : "가격표 없음" },
    { label: "절감액", value: formatKRW(cost.savings_krw + cache.cached_savings_krw) },
    { label: "토큰 출처", value: cost.token_source || "—" },
    {
      label: "토큰",
      value: `입력 ${formatNumber(cost.prompt_tokens)} · 출력 ${formatNumber(cost.completion_tokens)} · 합계 ${formatNumber(cost.total_tokens)}`,
    },
  ];
}

/**
 * Callers mount this with `key={requestId}` so switching requests drops the
 * analysis and replay answers instead of carrying captured content across.
 *
 * Why one request was slow, costly or routed the way it was, plus the operator
 * actions that hang off it: the shared note, a model-written analysis and an
 * upstream replay. Analysis and replay answers may quote the captured prompt, so
 * they render only inside a disclosure the operator opens, and are never put in
 * the URL or in storage.
 */
export function RequestInsightPanel({
  canInspectRaw,
  canWriteNote,
  requestId,
}: RequestInsightPanelProps): React.JSX.Element {
  const [analysis, setAnalysis] = useState("");
  const [replayBody, setReplayBody] = useState("");
  const [replayOpen, setReplayOpen] = useState(false);
  const [noteFormError, setNoteFormError] = useState("");
  const replayTriggerRef = useRef<HTMLButtonElement>(null);
  const noteForm = useZodForm<NoteFormValues, NoteFormValues>(noteFormSchema, { tags: "", note: "" });
  const { reset: resetNoteForm } = noteForm;

  const explain = useQuery({
    queryKey: ["observability", "requests", requestId, "explain"],
    enabled: requestId !== "",
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.observability.requests.explain, { id: requestId }), {
        signal,
        routeId,
      }),
  });

  const note = useQuery({
    queryKey: ["observability", "requests", requestId, "note"],
    enabled: requestId !== "",
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.observability.requests.note, { id: requestId }), {
        signal,
        routeId,
      }),
  });

  const noteData = note.data;
  useEffect(() => {
    resetNoteForm({ tags: (noteData?.tags ?? []).join(", "), note: noteData?.note ?? "" });
  }, [noteData, resetNoteForm]);

  const saveNote = useMutationFeedback({
    mutate: (values: NoteFormValues) =>
      apiClient.request(
        withPathParams(endpoints.domains.observability.requests.saveNote, { id: requestId }),
        {
          body: {
            tags: values.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
            note: values.note,
          },
          routeId,
        },
      ),
    invalidates: [["observability", "requests", requestId, "note"]],
    successMessage: "요청 메모를 저장했습니다.",
    errorMessage: "요청 메모를 저장하지 못했습니다.",
  });

  const removeNote = useMutationFeedback({
    mutate: () =>
      apiClient.request(
        withPathParams(endpoints.domains.observability.requests.removeNote, { id: requestId }),
        { routeId },
      ),
    invalidates: [["observability", "requests", requestId, "note"]],
    successMessage: "요청 메모를 삭제했습니다.",
    errorMessage: "요청 메모를 삭제하지 못했습니다.",
    onSuccess: () => resetNoteForm({ tags: "", note: "" }),
  });

  const runAnalysis = useMutationFeedback({
    mutate: () =>
      apiClient.request(withPathParams(endpoints.domains.observability.requests.analyze, { id: requestId }), {
        routeId,
        timeoutMs: 60_000,
      }),
    successMessage: "요청 분석을 마쳤습니다.",
    errorMessage: "요청 분석을 실행하지 못했습니다.",
    onSuccess: (result) => setAnalysis(result.analysis),
  });

  const runReplay = useMutationFeedback({
    mutate: () =>
      apiClient.request(withPathParams(endpoints.domains.observability.requests.replay, { id: requestId }), {
        routeId,
        timeoutMs: 60_000,
      }),
    successMessage: "요청을 재실행했습니다.",
    errorMessage: "요청을 재실행하지 못했습니다.",
    onSuccess: (result) =>
      setReplayBody(typeof result === "string" ? result : JSON.stringify(result, null, 2)),
  });

  const submitNote = noteForm.handleSubmit(async (values) => {
    setNoteFormError("");
    try {
      await saveNote.mutateAsync(values);
    } catch (cause) {
      setNoteFormError(requestErrorText(cause, "요청 메모를 저장하지 못했습니다."));
    }
  });

  return (
    <div className="obs-section-stack">
      <RequestSpanWaterfall requestId={requestId} />

      <SectionCard
        headingLevel={3}
        title="원인 설명"
        description="이 요청이 느리거나 비쌌던 이유를 라우팅·폴백·캐시·안전장치·비용으로 나눠 설명합니다."
        actions={
          <Button size="small" onClick={() => void explain.refetch()} disabled={explain.isFetching}>
            {explain.isFetching ? "불러오는 중" : "다시 불러오기"}
          </Button>
        }
      >
        {explain.isPending ? (
          <div role="status" aria-live="polite">
            원인 설명을 불러오는 중입니다.
          </div>
        ) : explain.isError ? (
          <InlineNotice tone="danger" title="원인 설명을 불러오지 못했습니다.">
            {requestErrorText(explain.error, "원인 설명을 불러오지 못했습니다.")}
          </InlineNotice>
        ) : explain.data ? (
          <>
            <div className="obs-timeline-badges">
              <Badge tone={explain.data.fallback.occurred ? "warning" : "muted"}>
                {explain.data.fallback.occurred
                  ? `폴백 ${explain.data.fallback.from_provider || "—"} → ${explain.data.fallback.to_provider || "—"}`
                  : "폴백 없음"}
              </Badge>
              <Badge tone={explain.data.safety.blocked ? "danger" : "success"}>
                {explain.data.safety.blocked ? "차단됨" : "차단 없음"}
              </Badge>
              <Badge tone={explain.data.safety.finding_count > 0 ? "warning" : "muted"}>
                안전 지적 {formatNumber(explain.data.safety.finding_count)}건
              </Badge>
              <Badge tone={explain.data.governance.approval_count > 0 ? "info" : "muted"}>
                승인 {explain.data.governance.approval_status || "없음"}
              </Badge>
              <Badge tone={explain.data.governance.policy_decision_count > 0 ? "info" : "muted"}>
                정책 판단 {formatNumber(explain.data.governance.policy_decision_count)}건
              </Badge>
              {explain.data.text2sql.span_count > 0 ? (
                <Badge tone={explain.data.text2sql.status === "error" ? "danger" : "info"}>
                  Text2SQL {formatNumber(explain.data.text2sql.span_count)}단계 ·{" "}
                  {formatDuration(explain.data.text2sql.total_latency_ms)}
                </Badge>
              ) : null}
            </div>
            <KeyValueList columns={2} items={explainItems(explain.data)} />
            {explain.data.safety.findings.length > 0 ? (
              <div className="data-table-scroll" tabIndex={0} aria-label="안전 지적 표 영역">
                <table className="data-table">
                  <caption className="sr-only">이 요청의 안전·거버넌스 지적</caption>
                  <thead>
                    <tr>
                      <th scope="col">항목</th>
                      <th scope="col">분류</th>
                      <th scope="col">판정</th>
                      <th scope="col">사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {explain.data.safety.findings.map((finding, index) => (
                      <tr key={`${finding.name}-${index}`}>
                        <th scope="row">{finding.name || "—"}</th>
                        <td>{finding.category || "—"}</td>
                        <td>{finding.label || "—"}</td>
                        <td className="truncate">{finding.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <details className="obs-disclosure">
              <summary>라우팅 판단 원문 보기</summary>
              <p className="obs-meta">
                업스트림 오류 메시지가 그대로 담길 수 있습니다. 다른 곳에 복사하지 마세요.
              </p>
              <KeyValueList
                items={[
                  { label: "라우팅 상세", value: explain.data.routing.detail || "—" },
                  { label: "판단 근거", value: explain.data.routing.decision_reason || "—" },
                  {
                    label: "폴백 경로",
                    value: explain.data.routing.fallback_path.join(" → ") || "—",
                  },
                  { label: "폴백 오류", value: explain.data.fallback.error || "—" },
                  {
                    label: "위험 분류",
                    value: explain.data.routing.risk_categories.join(", ") || "—",
                  },
                  { label: "마스킹", value: explain.data.safety.masking || "—" },
                ]}
              />
            </details>
            <p className="obs-meta">
              추적 ID {explain.data.trace_id || "—"} · 세션 {explain.data.session.session_id || "—"} ·{" "}
              {formatDateTime(explain.data.created_at)}
            </p>
          </>
        ) : null}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="운영 메모"
        description="이 요청에 대해 팀이 공유하는 메모와 태그입니다. 프롬프트 원문은 적지 마세요."
      >
        {note.isError ? (
          <InlineNotice
            tone="warning"
            title="메모를 불러오지 못했습니다."
            actions={
              <Button size="small" onClick={() => void note.refetch()}>
                다시 시도
              </Button>
            }
          >
            {requestErrorText(note.error, "메모를 불러오지 못했습니다.")}
          </InlineNotice>
        ) : null}
        {canWriteNote ? null : (
          <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
            {noteWriteDeniedReason}
          </InlineNotice>
        )}
        <form className="obs-note-form" onSubmit={submitNote}>
          <FormField
            label="태그"
            description="쉼표로 구분합니다. 예: 지연, 재현필요"
            error={noteForm.formState.errors.tags?.message}
          >
            {(control) => <Input {...control} {...noteForm.register("tags")} disabled={!canWriteNote} />}
          </FormField>
          <FormField label="메모" error={noteForm.formState.errors.note?.message}>
            {(control) => (
              <Textarea {...control} rows={3} {...noteForm.register("note")} disabled={!canWriteNote} />
            )}
          </FormField>
          <div className="obs-note-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={!canWriteNote || noteForm.formState.isSubmitting}
              title={canWriteNote ? undefined : noteWriteDeniedReason}
            >
              {noteForm.formState.isSubmitting ? "저장 중" : "메모 저장"}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={!canWriteNote || removeNote.isPending || !note.data?.note}
              title={canWriteNote ? undefined : noteWriteDeniedReason}
              onClick={() => removeNote.mutate()}
            >
              메모 삭제
            </Button>
          </div>
          {noteFormError ? (
            <p className="form-error" role="alert">
              {noteFormError}
            </p>
          ) : null}
        </form>
        {note.data?.updated_at ? (
          <p className="obs-meta">
            마지막 수정 {formatDateTime(note.data.updated_at)} · {note.data.created_by || "—"}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="요청 분석"
        description="모델이 이 요청의 의도와 결과, 오류를 3줄로 정리합니다. 결과에는 프롬프트 내용이 인용될 수 있습니다."
        actions={
          <Button
            size="small"
            variant="primary"
            disabled={!canInspectRaw || runAnalysis.isPending}
            title={canInspectRaw ? undefined : rawAccessDeniedReason}
            onClick={() => runAnalysis.mutate()}
          >
            {runAnalysis.isPending ? "분석 중" : "분석 실행"}
          </Button>
        }
      >
        {canInspectRaw ? null : (
          <InlineNotice tone="warning" title="열람 권한이 없습니다.">
            {rawAccessDeniedReason}
          </InlineNotice>
        )}
        {analysis ? (
          <details className="obs-disclosure">
            <summary>분석 결과 펼치기</summary>
            <p className="obs-meta">프롬프트와 응답 내용이 인용될 수 있습니다.</p>
            <pre className="obs-raw-block" tabIndex={0} aria-label="요청 분석 결과">
              {analysis}
            </pre>
          </details>
        ) : (
          <EmptyState
            title="아직 분석하지 않았습니다."
            description="‘분석 실행’을 누르면 이 요청의 프롬프트와 응답을 모델이 요약합니다."
          />
        )}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="요청 재실행"
        description="저장된 원본 본문을 업스트림에 다시 보냅니다. 실제 호출이므로 비용이 발생하고 부작용이 있을 수 있습니다."
        actions={
          <Button
            ref={replayTriggerRef}
            size="small"
            variant="danger"
            disabled={!canInspectRaw || runReplay.isPending}
            title={canInspectRaw ? undefined : rawAccessDeniedReason}
            onClick={() => setReplayOpen(true)}
          >
            {runReplay.isPending ? "재실행 중" : "재실행"}
          </Button>
        }
      >
        {canInspectRaw ? null : (
          <InlineNotice tone="warning" title="실행 권한이 없습니다.">
            {rawAccessDeniedReason}
          </InlineNotice>
        )}
        {replayBody ? (
          <details className="obs-disclosure">
            <summary>재실행 응답 펼치기</summary>
            <p className="obs-meta">업스트림 응답 원문입니다. 다른 곳에 복사하지 마세요.</p>
            <pre className="obs-raw-block" tabIndex={0} aria-label="재실행 응답 원문">
              {replayBody}
            </pre>
          </details>
        ) : (
          <EmptyState
            title="아직 재실행하지 않았습니다."
            description="원본 본문이 저장된 요청만 재실행할 수 있습니다(LOG_RAW_BODIES)."
          />
        )}
      </SectionCard>

      <ConfirmDialog
        open={replayOpen}
        onOpenChange={setReplayOpen}
        returnFocusRef={replayTriggerRef}
        tone="danger"
        title="이 요청을 다시 실행할까요?"
        description="저장된 원본 본문이 업스트림으로 한 번 더 전송됩니다. 토큰 비용이 발생하고, 도구를 호출하는 요청이면 실제 부작용이 생길 수 있습니다."
        confirmLabel="재실행"
        onConfirm={async () => {
          await runReplay.mutateAsync();
        }}
      />
    </div>
  );
}
