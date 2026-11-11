import { useEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { safeDefinitionError } from "../editor/definition-write";
import { RunScope } from "./RunScope";
import { RunReview } from "./RunReview";
import {
  makeRunPlan,
  runError,
  runSchema,
  type RunCatalog,
  type RunPlan,
  type RunReceipt,
} from "./run-model";
import { runErrorMessage } from "./run-messages";
import { useRunExecution } from "./use-run-execution";

export function RunDialog({
  owner,
  catalog,
  refresh,
  close,
  received,
  returnFocusRef,
}: {
  owner: FeatureReadOwner;
  catalog: RunCatalog;
  refresh: () => Promise<RunCatalog>;
  close: () => void;
  received: (receipt: RunReceipt) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { credentialPrefixes } = useAuth();
  const form = useZodForm(runSchema, {
    ids: [],
    models: "",
    passRate: "100",
    maxCalls: "64",
    outputTokens: "512",
  });
  const execution = useRunExecution(owner);
  const revision = useRef(0);
  const mounted = useRef(true);
  const approved = useRef<string | undefined>(undefined);
  const [plan, setPlan] = useState<RunPlan>();
  const [confirmed, setConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const subscription = form.watch(() => {
      revision.current++;
      approved.current = undefined;
      setConfirmed(false);
      setPlan(undefined);
      setReviewError(undefined);
    });
    return () => subscription.unsubscribe();
  }, [form]);
  // Reset only the review when the observed definition changes; retain inputs.
  // The conditional render update prevents an intermediate stale confirmation.
  if (plan && Object.entries(plan.definitions).some(([id, rev]) => catalog.revisions?.[id] !== rev)) {
    setConfirmed(false);
    setPlan(undefined);
    setReviewError("정의가 갱신되었습니다. 실행 내용을 다시 검토하세요.");
  }
  const review = () => {
    if (reviewing) return;
    const generation = revision.current;
    void form.handleSubmit(async (values) => {
      setReviewing(true);
      setReviewError(undefined);
      approved.current = undefined;
      setConfirmed(false);
      setPlan(undefined);
      try {
        assertFeatureRead(owner);
        const latest = await refresh();
        assertFeatureRead(owner);
        if (!mounted.current || revision.current !== generation) return;
        setPlan(makeRunPlan(latest, values, credentialPrefixes));
      } catch (error) {
        if (mounted.current && owner.isCurrent() && revision.current === generation)
          setReviewError(runErrorMessage(safeDefinitionError(error, credentialPrefixes)));
      } finally {
        if (mounted.current) setReviewing(false);
      }
    })();
  };
  const errors = form.formState.errors;
  return (
    <FormDialog
      open
      title="회귀 검사 실행"
      description="검사 대상과 비교 모델을 선택하고 실행 범위를 검토합니다."
      form={form}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      scrollBody
      scrollHint="입력과 실행 검토 영역을 스크롤해 확인하세요. 실행을 시작하면 결과 응답을 기다립니다."
      submitLabel="검토한 내용으로 실행"
      pendingLabel="실행 중"
      submitDisabled={!execution.allowed || execution.uncertain || !confirmed || reviewing}
      errorFormatter={runErrorMessage}
      onSubmit={async (values) => {
        if (!plan || approved.current !== JSON.stringify(values)) throw runError("golden_run_review");
        received(await execution.execute(plan));
      }}
    >
      {!execution.allowed ? (
        <InlineNotice tone="warning">{execution.reason} 실행 설정은 유지됩니다.</InlineNotice>
      ) : null}
      {execution.uncertain ? (
        <InlineNotice tone="warning" title="실행 결과 확인 필요">
          일부 호출과 비용이 발생했을 수 있어 이 창에서는 다시 실행하지 않습니다. 프롬프트 최근 결과와 감사
          기록을 확인하세요. 워크플로 결과는 별도 실행 이력에 저장되지 않습니다. 새 실행은 중복 호출이 될 수
          있습니다.
        </InlineNotice>
      ) : null}
      <fieldset className="regression-editor-fields" disabled={execution.uncertain}>
        <RunScope catalog={catalog} form={form} prefixes={credentialPrefixes} />
        <FormField
          label="비교할 모델 식별자"
          required
          description="모델 이름을 한 줄에 하나씩 입력하세요. 최대 8개이며 첫 모델을 비교 기준으로 표시합니다."
          error={errors.models?.message}
        >
          {(control) => <Textarea {...control} rows={3} {...form.register("models")} />}
        </FormField>
        <div className="regression-run-limits">
          <FormField label="통과 기준 (%)" required error={errors.passRate?.message}>
            {(control) => <Input {...control} inputMode="decimal" {...form.register("passRate")} />}
          </FormField>
          <FormField label="최대 호출 수" required error={errors.maxCalls?.message}>
            {(control) => <Input {...control} inputMode="numeric" {...form.register("maxCalls")} />}
          </FormField>
          <FormField label="호출당 출력 토큰 상한" required error={errors.outputTokens?.message}>
            {(control) => <Input {...control} inputMode="numeric" {...form.register("outputTokens")} />}
          </FormField>
        </div>
        <Button disabled={reviewing} onClick={review}>
          {reviewing ? "최신 정의 확인 중…" : "실행 내용 검토"}
        </Button>
        {reviewError ? (
          <p className="field-error" role="alert">
            {reviewError}
          </p>
        ) : null}
        {plan ? (
          <>
            <RunReview plan={plan} />
            <Checkbox
              label="실행 범위와 실제 모델 호출 비용 발생을 확인했습니다."
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                approved.current = event.target.checked ? JSON.stringify(plan.values) : undefined;
              }}
            />
          </>
        ) : null}
      </fieldset>
    </FormDialog>
  );
}
