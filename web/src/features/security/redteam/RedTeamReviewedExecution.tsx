import { captureAction } from "@/shared/telemetry/action-channel";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { submitReviewedJob } from "./submit-reviewed-job";
import { validRedTeamJobId, type RedTeamJobRef } from "@/shared/utils/redteam-job-query";
import { validRunRef } from "@/shared/utils/redteam-run-query";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { AppError, isAppError } from "@/shared/api/error";
import { withPathParams, type RedTeamCampaign } from "@/shared/api/domains/redteam";
import {
  redTeamReviewedEndpoints,
  redTeamReviewSchema,
  reviewedOutcomeSchema,
  type ReviewedRedTeamRun,
  type ReviewedRedTeamOutcome,
} from "@/shared/api/domains/redteam-reviewed";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { executionFormSchema, type ExecutionForm, type ExecutionFormInput } from "./reviewed-execution-form";
import { RedTeamExecutionReviewDetails } from "./RedTeamExecutionReviewDetails";

const prepareError =
  "등록 대상·정확한 모델 이름·승인·외부 제공자 허용·한도를 확인하세요. 이전 서버는 실행 검토를 지원하지 않을 수 있습니다.";
const keyError = "실제 실행 모드와 상단의 전용 실행 키를 확인하세요.";
const unknownOutcome =
  "실행 결과를 확정할 수 없습니다. 같은 검토로 다시 실행하지 않습니다. 실행 이력을 새로 조회해 상태를 확인하세요.";
const unavailable = () =>
  new AppError("현재 권한·캠페인·실행 키를 확인하고 새로 검토하세요.", { kind: "aborted" });
export function RedTeamReviewedExecution({
  campaign,
  proxyKey,
  canWrite,
  onClose,
  onResult,
  onPending,
  onJobTracked,
  onJobAccepted,
  historyAvailable,
  onOpenHistory,
  returnFocusRef,
}: {
  campaign: RedTeamCampaign;
  proxyKey: string;
  canWrite: boolean;
  onClose: () => void;
  onResult: (outcome: ReviewedRedTeamOutcome) => void;
  onPending: (pending: boolean) => void;
  onJobTracked?: (job: RedTeamJobRef) => void;
  onJobAccepted?: (job: RedTeamJobRef) => void;
  historyAvailable?: (reviewId: string) => boolean;
  onOpenHistory?: (reviewId: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const access = useFeatureMutationAccess(["security.redteam"], canWrite);
  const { credentialPrefixes } = useAuth();
  const [originalKey] = useState(proxyKey);
  const currentKey = useRef(proxyKey);
  const active = useRef(true);
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  const sent = useRef(false);
  const reviewRef = useRef<ReviewedRedTeamRun | undefined>(undefined);
  const [review, setReview] = useState<ReviewedRedTeamRun>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [consumed, setConsumed] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  useLayoutEffect(() => {
    if (consumed) {
      feedbackRef.current?.focus();
      if (error) feedbackRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [consumed, error]);
  const form = useZodForm<ExecutionFormInput, ExecutionForm>(executionFormSchema, {
    kind: campaign.execution_mode === "active-controlled" ? "live" : "simulation",
    reason: "",
    models: "",
    max_calls: "20",
    max_output_tokens: "512",
    budget_limit_krw: String(
      campaign.budget_limit_krw > 0 ? Math.min(campaign.budget_limit_krw, 1000) : 1000,
    ),
  });
  useLayoutEffect(() => {
    currentKey.current = proxyKey;
  }, [proxyKey]);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      reviewRef.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (proxyKey !== originalKey) onClose();
  }, [proxyKey, originalKey, onClose]);
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
    if (!active.current || currentKey.current !== originalKey) throw unavailable();
  };
  const createReview = async (values: ExecutionForm) => {
    assertCurrent();
    if (values.kind === "live" && (campaign.execution_mode !== "active-controlled" || !originalKey.trim()))
      throw new AppError(keyError, { kind: "permission", code: "review_key" });
    const body = {
      kind: values.kind,
      reason: values.reason,
      models: values.models,
      limits: {
        max_calls: values.max_calls,
        max_output_tokens: values.max_output_tokens,
        budget_limit_krw: values.budget_limit_krw,
      },
    };
    let result: ReviewedRedTeamRun;
    try {
      result = redTeamReviewSchema.parse(
        await apiClient.request(withPathParams(redTeamReviewedEndpoints.review, { id: campaign.id }), {
          body,
          routeId: "security.redteam",
          retryUnauthorized: false,
        }),
      );
    } catch (e) {
      throw new AppError(prepareError, {
        kind: "contract",
        code: "review_prepare",
        requestId: isAppError(e) ? e.requestId : undefined,
      });
    }
    assertCurrent();
    if (
      result.campaign_id !== campaign.id ||
      result.campaign_name !== campaign.name ||
      result.kind !== body.kind ||
      result.reason !== body.reason ||
      JSON.stringify(result.limits) !== JSON.stringify(body.limits) ||
      Date.parse(result.expires_at) <= Date.now()
    )
      throw unavailable();
    reviewRef.current = result;
    setReview(result);
  };
  const close = () => {
    active.current = false;
    reviewRef.current = undefined;
    onPending(false);
    onClose();
  };
  const execute = async () => {
    const candidate = reviewRef.current;
    if (!candidate || sent.current || confirmation !== candidate.campaign_name) return;
    let observation: ReturnType<typeof captureAction>;
    try {
      assertCurrent();
      if (Date.parse(candidate.expires_at) <= Date.now()) throw unavailable();
      if (
        candidate.job_id &&
        (!onJobTracked ||
          !onJobAccepted ||
          !validRedTeamJobId(candidate.job_id) ||
          !validRunRef(campaign.id, credentialPrefixes))
      )
        throw unavailable();
      observation = captureAction("run_request", undefined, assertCurrent);
      sent.current = true;
      setConsumed(true);
      setPending(true);
      onPending(!candidate.job_id);
      if (candidate.job_id) {
        onJobTracked?.({ id: candidate.job_id, campaign: campaign.id });
        const job = await submitReviewedJob(candidate, originalKey);
        assertCurrent();
        observation?.success();
        onJobAccepted?.({ id: job.id, campaign: job.campaign_id });
        return;
      }
      const result = reviewedOutcomeSchema.parse(
        await apiClient.request(withPathParams(redTeamReviewedEndpoints.execute, { id: campaign.id }), {
          body: {
            review_token: candidate.review_token,
            ...(candidate.kind === "live" ? { proxy_key: originalKey.trim() } : {}),
          },
          routeId: "security.redteam",
          retryUnauthorized: false,
          timeoutMs: 130_000,
        }),
      );
      assertCurrent();
      if (
        reviewRef.current !== candidate ||
        result.campaign_id !== candidate.campaign_id ||
        result.review_id !== candidate.review_id ||
        result.execution_kind !== candidate.kind ||
        JSON.stringify(result.limits) !== JSON.stringify(candidate.limits) ||
        result.planned_live_calls !== candidate.planned_live_calls ||
        result.planned_case_executions !== candidate.case_executions
      ) {
        observation?.failure(new AppError("실행 응답을 확인할 수 없습니다.", { kind: "contract" }));
        throw unavailable();
      }
      observation?.success();
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
      if (active.current) {
        setPending(false);
        onPending(false);
      }
    }
  };
  if (proxyKey !== originalKey) return <></>;
  if (review)
    return (
      <Sheet
        open
        title="실행 조건 최종 확인"
        description="대상과 한도를 확인하고 캠페인 이름을 입력하세요."
        returnFocusRef={returnFocusRef}
        size="wide"
        scrollLabel="실행 조건 검토 내용"
        onOpenChange={(open) => {
          if (!open) {
            active.current = false;
            reviewRef.current = undefined;
            onPending(false);
            onClose();
          }
        }}
        footer={
          <div className="rt-execution-actions">
            <Button onClick={close}>닫기</Button>
            {consumed && onOpenHistory && historyAvailable?.(review.review_id) ? (
              <Button
                onClick={() => {
                  const id = review.review_id;
                  close();
                  onOpenHistory(id);
                }}
              >
                이 검토의 실행 이력
              </Button>
            ) : null}
            <Button
              variant={review.kind === "live" ? "danger" : "primary"}
              disabled={
                !access.allowed || pending || consumed || expired || confirmation !== review.campaign_name
              }
              onClick={() => void execute()}
            >
              {pending
                ? review.job_id
                  ? "작업 접수 확인 중…"
                  : "실행 결과 확인 중…"
                : "검토한 조건으로 한 번 실행"}
            </Button>
          </div>
        }
      >
        <div className="rt-stack">
          <RedTeamExecutionReviewDetails review={review} />
          {expired && !consumed ? (
            <InlineNotice tone="warning" title="검토가 만료되었습니다.">
              닫고 현재 조건으로 다시 검토하세요.
            </InlineNotice>
          ) : null}
          <div ref={feedbackRef} className="rt-execution-feedback" tabIndex={-1} role="status">
            {pending ? (
              <p role="status">
                {review.job_id
                  ? "작업 접수를 확인하고 있습니다. 접수한 검사는 서버에서 계속 처리하며, 패널을 닫으면 작업 상태를 확인할 수 있습니다."
                  : "실행 중입니다. 패널을 닫아도 이미 전송한 호출은 취소되지 않을 수 있습니다."}
              </p>
            ) : null}
            {error ? (
              <InlineNotice tone="danger" title={error.message}>
                {error.requestId ? `요청 ID: ${error.requestId}` : null}
              </InlineNotice>
            ) : null}
          </div>
          <FormField
            label="캠페인 이름 확인"
            description={`다음 이름을 그대로 입력하세요: ${review.campaign_name}`}
            required
          >
            {(control) => (
              <Input
                {...control}
                value={confirmation}
                disabled={consumed}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            )}
          </FormField>
        </div>
      </Sheet>
    );
  const errors = form.formState.errors;
  return (
    <FormDialog
      form={form}
      open
      title="캠페인 실행 검토"
      description="실행 사유와 이번 실행의 한도를 정합니다. 검토 단계에서는 모델을 호출하지 않습니다."
      onSubmit={createReview}
      onOpenChange={(open) => {
        if (!open && !reviewRef.current) close();
      }}
      returnFocusRef={returnFocusRef}
      errorFormatter={(e, fallback) =>
        isAppError(e) && e.code === "review_prepare"
          ? prepareError
          : isAppError(e) && e.code === "review_key"
            ? keyError
            : safeAppErrorMessage(e, fallback)
      }
      submitLabel="실행 조건 검토"
      submitDisabled={!access.allowed}
      scrollBody
      wide
    >
      <FormField
        label="이번 실행 방식"
        description="실제 호출은 전용 실행 키가 필요합니다. Text2SQL·MCP·앱·워크플로 대상은 시뮬레이션으로 처리합니다."
      >
        {(control) => (
          <Select {...control} {...form.register("kind")}>
            <option value="simulation">시뮬레이션만 실행</option>
            <option value="live" disabled={campaign.execution_mode !== "active-controlled"}>
              실제 호출 포함
            </option>
          </Select>
        )}
      </FormField>
      <FormField label="실행 사유" required error={errors.reason?.message}>
        {(control) => (
          <Textarea
            {...control}
            {...form.register("reason")}
            placeholder="점검 목적과 승인 근거를 입력하세요."
          />
        )}
      </FormField>
      <FormField
        label="정확한 모델 이름"
        description="필요하면 한 줄에 하나씩 입력합니다. 비우면 캠페인의 저장된 모델 또는 대상의 구체적인 모델을 사용합니다. 별표 패턴, 자동 검색과 다단계 가상 모델(Text2SQL·MCP·에이전트)은 실제 호출 대상으로 허용하지 않습니다."
        error={errors.models?.message}
      >
        {(control) => <Textarea {...control} {...form.register("models")} />}
      </FormField>
      <FormField
        label="실제 모델 호출 수 상한"
        required
        description="1~200회"
        error={errors.max_calls?.message}
      >
        {(control) => <Input {...control} {...form.register("max_calls")} inputMode="numeric" />}
      </FormField>
      <FormField
        label="호출당 출력 토큰 요청 상한"
        required
        description="1~4,096 토큰"
        error={errors.max_output_tokens?.message}
      >
        {(control) => <Input {...control} {...form.register("max_output_tokens")} inputMode="numeric" />}
      </FormField>
      <FormField
        label="비용 중단 기준(원)"
        required
        description="0보다 커야 하며, 캠페인에 설정된 예산을 넘을 수 없습니다."
        error={errors.budget_limit_krw?.message}
      >
        {(control) => <Input {...control} {...form.register("budget_limit_krw")} inputMode="decimal" />}
      </FormField>
    </FormDialog>
  );
}
