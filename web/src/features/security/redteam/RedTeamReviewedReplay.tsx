import { captureAction } from "@/shared/telemetry/action-channel";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { apiClient } from "@/shared/api/client";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { withPathParams } from "@/shared/api/domains/redteam";
import {
  redTeamReplayEndpoints,
  replayReviewSchema,
  replayOutcomeSchema,
  type ReviewedRedTeamReplay,
  type RedTeamReplayOutcome,
} from "@/shared/api/domains/redteam-replay";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Sheet } from "@/shared/components/ui/Sheet";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { replayFormSchema, type ReplayForm, type ReplayFormInput } from "./reviewed-replay-form";
import { RedTeamExecutionReviewDetails } from "./RedTeamExecutionReviewDetails";
import { decisionLabel } from "./redteam-ui";

const unknownOutcome =
  "재실행 결과를 확정할 수 없습니다. 자동으로 다시 실행하지 않습니다. 패널을 닫고 실행 이력을 조회한 뒤 새로 검토하세요.";
const unavailable = () =>
  new AppError("현재 결과·권한·실행 키를 확인하고 다시 검토하세요.", { kind: "aborted" });

export function RedTeamReviewedReplay({
  resultId,
  model,
  proxyKey,
  canWrite,
  onClose,
  onResult,
  onOpenRun,
  onOpenHistory,
  returnFocusRef,
}: {
  resultId: string;
  model: string;
  proxyKey: string;
  canWrite: boolean;
  onClose: () => void;
  onResult: (result: RedTeamReplayOutcome) => void;
  onOpenRun: (id: string) => void;
  onOpenHistory?: (id: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const access = useFeatureMutationAccess(["security.redteam"], canWrite);
  const [originalKey] = useState(proxyKey);
  const [originalId] = useState(resultId);
  const current = useRef({ proxyKey, resultId });
  const active = useRef(true);
  const sent = useRef(false);
  const reviewRef = useRef<ReviewedRedTeamReplay | undefined>(undefined);
  const feedback = useRef<HTMLDivElement>(null);
  const [review, setReview] = useState<ReviewedRedTeamReplay>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [consumed, setConsumed] = useState(false);
  const [expired, setExpired] = useState(false);
  const [outcome, setOutcome] = useState<RedTeamReplayOutcome>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const form = useZodForm<ReplayFormInput, ReplayForm>(replayFormSchema, {
    reason: "",
    model,
    max_output_tokens: "512",
    budget_limit_krw: "10",
    retain_raw_evidence: false,
  });
  useLayoutEffect(() => {
    current.current = { proxyKey, resultId };
  }, [proxyKey, resultId]);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      reviewRef.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    if (consumed) feedback.current?.focus();
  }, [consumed]);
  useEffect(() => {
    if (proxyKey !== originalKey || resultId !== originalId) onClose();
  }, [proxyKey, originalKey, resultId, originalId, onClose]);
  useEffect(() => {
    if (!review) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(review.expires_at) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [review]);
  const assertCurrent = () => {
    access.assertCurrent();
    if (
      !active.current ||
      current.current.proxyKey !== originalKey ||
      current.current.resultId !== originalId
    )
      throw unavailable();
  };
  const close = () => {
    active.current = false;
    reviewRef.current = undefined;
    onClose();
  };
  const createReview = async (values: ReplayForm) => {
    assertCurrent();
    if (!originalKey.trim())
      throw new AppError("화면 상단에 전용 실행 키를 입력하세요.", {
        kind: "permission",
        code: "replay_key",
      });
    const body = {
      reason: values.reason,
      model: values.model,
      retain_raw_evidence: values.retain_raw_evidence,
      limits: {
        max_calls: 1,
        max_output_tokens: values.max_output_tokens,
        budget_limit_krw: values.budget_limit_krw,
      },
    };
    let result: ReviewedRedTeamReplay;
    try {
      result = replayReviewSchema.parse(
        await apiClient.request(withPathParams(redTeamReplayEndpoints.review, { id: originalId }), {
          body,
          routeId: "security.redteam",
          retryUnauthorized: false,
        }),
      );
    } catch (e) {
      throw new AppError(
        "원본 결과·현재 대상·모델·검사 묶음·승인 상태와 한도를 확인하세요. 단일 LLM 호출 대상만 재실행할 수 있습니다.",
        { kind: "contract", code: "replay_prepare", requestId: isAppError(e) ? e.requestId : undefined },
      );
    }
    assertCurrent();
    if (
      result.source_result.id !== originalId ||
      result.reason !== values.reason ||
      result.targets[0]?.models[0] !== values.model ||
      result.retain_raw_evidence !== values.retain_raw_evidence ||
      JSON.stringify(result.limits) !== JSON.stringify(body.limits) ||
      Date.parse(result.expires_at) <= Date.now()
    )
      throw unavailable();
    reviewRef.current = result;
    setReview(result);
  };
  const execute = async () => {
    const candidate = reviewRef.current;
    if (!candidate || sent.current || confirmation !== candidate.source_result.id) return;
    let observation: ReturnType<typeof captureAction>;
    try {
      assertCurrent();
      if (Date.parse(candidate.expires_at) <= Date.now()) throw unavailable();
      observation = captureAction("run_request", undefined, assertCurrent);
      sent.current = true;
      setConsumed(true);
      setPending(true);
      const result = replayOutcomeSchema.parse(
        await apiClient.request(withPathParams(redTeamReplayEndpoints.execute, { id: originalId }), {
          body: { review_token: candidate.review_token, proxy_key: originalKey.trim() },
          routeId: "security.redteam",
          retryUnauthorized: false,
          timeoutMs: 130_000,
        }),
      );
      assertCurrent();
      if (
        reviewRef.current !== candidate ||
        result.source_result_id !== originalId ||
        result.source_run_id !== candidate.source_result.run_id ||
        result.campaign_id !== candidate.campaign_id ||
        result.review_id !== candidate.review_id ||
        JSON.stringify(result.limits) !== JSON.stringify(candidate.limits)
      ) {
        observation?.failure(new AppError("실행 응답을 확인할 수 없습니다.", { kind: "contract" }));
        throw unavailable();
      }
      observation?.success();
      setOutcome(result);
      onResult(result);
    } catch (e) {
      observation?.failure(e);
      if (active.current)
        setError({
          message: sent.current
            ? unknownOutcome
            : "검토가 만료되었거나 실행 조건이 바뀌었습니다. 닫고 다시 검토하세요.",
          requestId: isAppError(e) ? e.requestId : undefined,
        });
    } finally {
      if (active.current) setPending(false);
    }
  };
  const nextRun = outcome?.runs[0];
  if (proxyKey !== originalKey || resultId !== originalId) return <></>;
  if (review)
    return (
      <Sheet
        open
        title="한 건 재실행 최종 확인"
        description="원본 결과와 증적을 보존하고 새 이력에 기록합니다."
        returnFocusRef={returnFocusRef}
        size="wide"
        scrollLabel="재실행 조건 검토 내용"
        onOpenChange={(open) => {
          if (!open) close();
        }}
        footer={
          <>
            <Button onClick={close}>닫기</Button>
            {consumed && !pending && onOpenHistory ? (
              <Button
                onClick={() => {
                  try {
                    assertCurrent();
                    onOpenHistory(resultId);
                  } catch {
                    close();
                  }
                }}
              >
                원본 관련 재실행 이력
              </Button>
            ) : null}
            {nextRun ? (
              <Button
                onClick={() => {
                  try {
                    assertCurrent();
                  } catch {
                    close();
                    return;
                  }
                  onOpenRun(nextRun.id);
                }}
              >
                새 실행 결과 보기
              </Button>
            ) : null}
            <Button
              variant="danger"
              disabled={
                !access.allowed || pending || consumed || expired || confirmation !== review.source_result.id
              }
              onClick={() => void execute()}
            >
              {pending ? "재실행 결과 확인 중…" : "검토한 한 건만 실제 재실행"}
            </Button>
          </>
        }
      >
        <div className="rt-stack">
          <section aria-label="원본 결과와 재실행 범위" className="rt-fieldset">
            <h3>원본 결과와 재실행 범위</h3>
            <p>
              원본 결과: <code>{review.source_result.id}</code>
            </p>
            <p>
              검사: {review.case_key} · 묶음: {review.pack_name}
            </p>
            <p>이전 판정: {decisionLabel(review.source_result.decision)}</p>
            <p>
              원본의 판정과 증적은 그대로 보존합니다. 이 한 건으로 캠페인 상태나 검사 묶음의 통과 기준선을
              갱신하지 않습니다.
            </p>
          </section>
          <RedTeamExecutionReviewDetails review={review} singleCase />
          {expired && !consumed ? (
            <InlineNotice tone="warning" title="검토가 만료되었습니다.">
              닫고 현재 조건으로 다시 검토하세요.
            </InlineNotice>
          ) : null}
          <div ref={feedback} tabIndex={-1} role="status">
            {pending ? <p>실행 중입니다. 닫아도 이미 전송한 호출은 취소되지 않을 수 있습니다.</p> : null}
            {error ? (
              <InlineNotice tone="danger" title={error.message}>
                {error.requestId ? `요청 ID: ${error.requestId}` : null}
              </InlineNotice>
            ) : null}
            {outcome ? (
              <InlineNotice
                tone={outcome.complete ? "success" : "warning"}
                title={
                  outcome.complete
                    ? "재실행과 새 결과 저장을 확인했습니다."
                    : "일부 실행 또는 저장을 확인하지 못했습니다."
                }
              >
                {outcome.complete
                  ? "새 실행에서 판정과 증적을 확인하세요."
                  : "자동으로 다시 실행하지 않습니다. 새 이력과 감사 기록을 확인하세요."}
              </InlineNotice>
            ) : null}
          </div>
          <FormField
            label="원본 결과 ID 확인"
            description={`다음 값을 그대로 입력하세요: ${review.source_result.id}`}
            required
          >
            {(control) => (
              <Input
                {...control}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={consumed}
                autoComplete="off"
              />
            )}
          </FormField>
        </div>
      </Sheet>
    );
  return (
    <FormDialog
      open
      form={form}
      title="한 건 재실행 조건 검토"
      description="현재 정의로 단일 LLM 검사를 다시 실행합니다. 이 단계에서는 호출하지 않습니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open && !reviewRef.current) close();
      }}
      onSubmit={createReview}
      submitLabel="재실행 조건 검토"
      submitDisabled={!access.allowed}
      errorFormatter={(e, fallback) =>
        isAppError(e) && (e.code === "replay_prepare" || e.code === "replay_key")
          ? e.message
          : safeAppErrorMessage(e, fallback)
      }
      scrollBody
      wide
    >
      <FormField label="재실행 사유" required error={form.formState.errors.reason?.message}>
        {(control) => <Textarea {...control} {...form.register("reason")} maxLength={1000} />}
      </FormField>
      <FormField
        label="정확한 모델 이름"
        required
        description="현재 제공자의 실제 모델 이름을 입력하세요. 자동 선택·와일드카드·다단계 가상 모델은 지원하지 않습니다."
        error={form.formState.errors.model?.message}
      >
        {(control) => <Input {...control} {...form.register("model")} />}
      </FormField>
      <p>실제 모델 호출은 한 건으로 제한합니다. 원본 실행과 결과를 덮어쓰지 않습니다.</p>
      <FormField
        label="출력 토큰 요청 상한"
        required
        description="1~4,096 토큰"
        error={form.formState.errors.max_output_tokens?.message}
      >
        {(control) => (
          <Input {...control} type="number" min={1} max={4096} {...form.register("max_output_tokens")} />
        )}
      </FormField>
      <FormField
        label="비용 중단 기준(원)"
        required
        description="호출 후 비용이 확인되므로 실제 과금 상한을 보장하지 않습니다."
        error={form.formState.errors.budget_limit_krw?.message}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            min="0.01"
            max="1000000"
            step="any"
            {...form.register("budget_limit_krw")}
          />
        )}
      </FormField>
      <label className="checkbox">
        <input type="checkbox" {...form.register("retain_raw_evidence")} />새 증적에 입력·응답 원문 보관
      </label>
      <p className="rt-note">
        기본값은 마스킹 보관입니다. 원문 보관을 선택하면 새 요청과 응답의 민감한 내용도 저장될 수 있습니다.
        기존 증적의 보관 상태는 변경하지 않습니다.
      </p>
    </FormDialog>
  );
}
