import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type RefObject } from "react";
import { apiClient } from "@/shared/api/client";
import { dwRetryEndpoints, type DwRetryInput, type DwRetryRunView } from "@/shared/api/domains/dw-retry";
import { AppError, isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { DataQueryNotice } from "@/features/data/DataQueryNotice";
import { dataQueryKeys } from "./use-warehouse-queries";
import { DwRetryDetails } from "./DwRetryDetails";

type Props = {
  canWrite: boolean;
  open: boolean;
  jobId?: string;
  onOpenChange: (open: boolean) => void;
  onJobChange: (id: string | undefined) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
};
const routeId = "data.warehouse";
const outcomeLabels: Record<DwRetryRunView["status"], string> = {
  running: "재처리 진행 중",
  succeeded: "재처리 완료",
  partial_failed: "일부 재처리 미완료",
  failed: "재처리 실패",
  interrupted: "작업 중단 · 결과 확인 필요",
};
export function DwRetryWorkspace(props: Props): React.JSX.Element {
  const owner = useFeatureReadOwner(routeId, "dw-retry-workspace");
  return <RetrySession key={owner.id} {...props} owner={owner} />;
}
function RetrySession({ owner, ...props }: Props & { owner: FeatureReadOwner }): React.JSX.Element {
  const client = useQueryClient();
  const { onJobChange } = props;
  const access = useFeatureMutationAccess([routeId], props.canWrite);
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pendingJobAddress, setPendingJobAddress] = useState<string>();
  const jobId = pendingJobAddress ?? props.jobId;
  const [fieldError, setFieldError] = useState<string>();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const guard = useDraftGuard({
    dirty: props.open && reason !== "" && !attempted,
    keepMounted: true,
    onDiscard: () => {
      setReason("");
      props.onOpenChange(false);
    },
  });
  useEffect(() => {
    // A query-string update is navigation too. Commit only after the draft
    // coordinator has released its submission lock; an attempted reason is
    // immutable until the operator explicitly reviews a fresh snapshot.
    if (!pendingJobAddress || guard.pending || sending.current || !owner.isCurrent()) return;
    onJobChange(pendingJobAddress);
    setPendingJobAddress(undefined);
  }, [pendingJobAddress, guard.pending, owner, onJobChange]);
  const review = useQuery({
    queryKey: featureOwnedKey([...dataQueryKeys.pipeline, "retry-review"], owner),
    enabled: props.open && owner.readable && !owner.denied,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(dwRetryEndpoints.review, { signal, routeId });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
  const jobKey = featureOwnedKey([...dataQueryKeys.pipeline, "retry-job", jobId], owner);
  const job = useQuery<DwRetryRunView>({
    queryKey: jobKey,
    enabled: Boolean(jobId) && owner.readable && !owner.denied,
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => (query.state.error || query.state.data?.status !== "running" ? false : 2_000),
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(dwRetryEndpoints.job, {
        query: { job_id: jobId ?? "" },
        signal,
        routeId,
      });
      assertFeatureRead(owner, signal);
      if (result.id !== jobId)
        throw new AppError("작업 결과의 대상을 확인하지 못했습니다.", { kind: "contract" });
      return result;
    },
  });
  const mutation = useMutationFeedback({
    gcTime: 0,
    ownsResult: owner.isCurrent,
    mutate: async (body: DwRetryInput) => {
      assertFeatureRead(owner);
      access.assertCurrent();
      const result = await apiClient.request(dwRetryEndpoints.start, {
        body,
        query: { reviewed: "1" },
        routeId,
      });
      if (result.id !== `dwr_${body.revision}`)
        throw new AppError("작업 결과의 대상을 확인하지 못했습니다.", { kind: "contract" });
      return result;
    },
    errorMessage: "재처리 접수 결과를 확인하지 못했습니다. 작업 상태를 조회하세요.",
  });
  const lastInvalidated = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      !owner.isCurrent() ||
      !job.data ||
      job.data.status === "running" ||
      lastInvalidated.current === job.data.id
    )
      return;
    lastInvalidated.current = job.data.id;
    void client.invalidateQueries({ queryKey: [...dataQueryKeys.pipeline, "sink-status"] });
    void client.invalidateQueries({ queryKey: [...dataQueryKeys.pipeline, "overview"] });
    void client.invalidateQueries({ queryKey: dataQueryKeys.warehouse });
  }, [client, job.data, owner]);
  const start = async () => {
    if (
      sending.current ||
      attempted ||
      !review.data ||
      review.isFetching ||
      review.isError ||
      !access.allowed ||
      !owner.isCurrent()
    )
      return;
    if (!reason.trim() || [...reason.trim()].length > 1024) {
      setFieldError("실행 사유를 1~1,024자로 입력하세요.");
      reasonRef.current?.focus();
      return;
    }
    const snapshot = review.data;
    const input: DwRetryInput = {
      revision: review.data.revision,
      reviewed_at: review.data.reviewed_at,
      all: review.data.all,
      reason: reason.trim(),
    };
    await guard.run(
      async () => {
        sending.current = true;
        setAttempted(true);
        setFieldError(undefined);
        setPendingJobAddress(snapshot.run_id);
        try {
          const result = await mutation.mutateAsync(input);
          assertFeatureRead(owner);
          const acceptedKey = featureOwnedKey([...dataQueryKeys.pipeline, "retry-job", result.id], owner);
          await client.cancelQueries({ queryKey: acceptedKey, exact: true });
          assertFeatureRead(owner);
          client.setQueryData(acceptedKey, result);
          return result;
        } finally {
          sending.current = false;
        }
      },
      () => {
        /* Inline error preserves uncertain admission for job lookup. */
      },
      () => {
        setReason("");
        props.onOpenChange(false);
      },
    );
  };
  const reReview = async () => {
    if (sending.current || !owner.isCurrent()) return;
    const result = await review.refetch();
    if (owner.isCurrent() && result.isSuccess) {
      setAttempted(false);
      mutation.reset();
    }
  };
  const recover = async () => {
    const result = await job.refetch();
    if (owner.isCurrent() && result.data && !result.isError) {
      setReason("");
      props.onOpenChange(false);
    }
  };
  const current = owner.isCurrent() ? job.data : undefined;
  const reviewData = owner.isCurrent() ? review.data : undefined;
  const staleReview =
    isAppError(mutation.error) && (mutation.error.status === 400 || mutation.error.status === 409);
  return (
    <>
      {owner.denied ? (
        <InlineNotice tone="danger" title="재처리 작업 조회 권한을 확인하세요.">
          현재 계정이 접수한 작업만 조회할 수 있습니다.{" "}
          <Button
            variant="secondary"
            onClick={() => {
              props.onJobChange(undefined);
              owner.restart();
            }}
          >
            작업 주소 지우기
          </Button>
        </InlineNotice>
      ) : null}
      {jobId && !owner.denied ? (
        <SectionCard
          title={current ? outcomeLabels[current.status] : "재처리 작업 상태"}
          description="접수한 작업은 화면을 닫아도 서버에서 계속 처리합니다."
        >
          {job.isPending ? <p role="status">작업 상태를 확인하고 있습니다.</p> : null}
          {job.isError ? (
            <DataQueryNotice
              error={job.error}
              hasPreviousData={Boolean(current)}
              label="재처리 작업"
              onRetry={() => void job.refetch()}
            />
          ) : null}
          {current ? (
            <>
              <p role="status">
                전송 {formatNumber(current.progress.sent_rows)}행 · 검토 당시 예상{" "}
                {formatNumber(current.progress.estimated_rows)}행 · 마지막 확인{" "}
                {formatDateTime(current.updated_at)}
              </p>
              {current.status !== "running" && current.status !== "succeeded" ? (
                <InlineNotice tone="warning" title="남은 대기열을 확인하세요.">
                  일부 전송은 이미 반영됐을 수 있습니다. 연결 상태와 대기열을 확인한 뒤 다시 검토해
                  실행하세요.
                </InlineNotice>
              ) : null}
              <DwRetryDetails rows={current.progress.dimensions} progress />
            </>
          ) : null}
          <div className="data-inline-actions">
            <Button
              variant="secondary"
              onClick={() => void job.refetch()}
              disabled={job.isFetching || !owner.readable}
            >
              상태 새로고침
            </Button>
            <Button variant="ghost" onClick={() => props.onJobChange(undefined)}>
              작업 표시 닫기
            </Button>
          </div>
        </SectionCard>
      ) : null}
      <Dialog
        open={props.open}
        onOpenChange={(open) => {
          if (!open) guard.requestClose();
        }}
        returnFocusRef={props.returnFocusRef}
        wide
        scrollBody
        scrollBodyLabel="재처리 검토 내용"
        title="실패분 재처리 검토"
        description="대상 기간과 예상 행 수를 확인하고 실행 사유를 남기세요. 검토 결과는 5분 동안 유효합니다."
        footer={
          <>
            <Button variant="secondary" onClick={() => guard.requestClose()} disabled={mutation.isPending}>
              닫기
            </Button>
            <Button
              variant="primary"
              onClick={() => void start()}
              disabled={
                !access.allowed ||
                !owner.readable ||
                owner.denied ||
                !reviewData?.eligible_dimensions ||
                review.isFetching ||
                review.isError ||
                attempted ||
                mutation.isPending
              }
            >
              {mutation.isPending ? "접수 중" : "검토한 대상 재처리"}
            </Button>
          </>
        }
      >
        {!access.allowed || owner.denied ? (
          <InlineNotice tone="warning" title="현재 권한으로 실행할 수 없습니다.">
            {access.reason}
          </InlineNotice>
        ) : null}
        {review.isPending ? <p role="status">대상 기간과 예상 건수를 확인하고 있습니다.</p> : null}
        {review.isError ? (
          <DataQueryNotice
            error={review.error}
            hasPreviousData={Boolean(reviewData)}
            label="재처리 대상"
            onRetry={() => void review.refetch()}
          />
        ) : null}
        {reviewData ? (
          <>
            <p>
              실행 가능 {formatNumber(reviewData.eligible_dimensions)}개 구분 · 예상{" "}
              {formatNumber(reviewData.estimated_rows)}행
            </p>
            <DwRetryDetails rows={reviewData.dimensions} />
            <p className="text-muted">
              일별 집계의 기간은 한국 시간 기준이며 양 끝 날짜를 포함합니다. 팩트는 표시된 시각까지
              조회합니다. 검토 후 원본 변경에 따라 실제 전송 건수는 달라질 수 있습니다. 설정 확인이 필요한
              항목은 대기열에 남습니다.
            </p>
          </>
        ) : null}
        <FormField
          label="실행 사유"
          required
          description="예: 연결 복구 후 미전송 데이터를 재처리합니다. 비밀번호나 비밀키는 입력하지 마세요."
          error={fieldError}
        >
          {(control) => (
            <Textarea
              {...control}
              ref={reasonRef}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={mutation.isPending || attempted}
            />
          )}
        </FormField>
        {mutation.error ? (
          <InlineNotice tone="danger" title="재처리 접수 확인">
            {safeAppErrorMessage(mutation.error, "접수 여부를 확인하지 못했습니다.")}
            {isAppError(mutation.error) && mutation.error.requestId ? (
              <p className="request-id">요청 ID: {mutation.error.requestId}</p>
            ) : null}
            <div className="data-inline-actions">
              {!staleReview ? (
                <Button variant="secondary" onClick={() => void recover()} disabled={job.isFetching}>
                  접수 결과 확인
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => void reReview()} disabled={review.isFetching}>
                최신 대상 다시 검토
              </Button>
            </div>
            <p>동일 작업을 자동으로 다시 전송하지 않습니다.</p>
          </InlineNotice>
        ) : null}
      </Dialog>
    </>
  );
}
