import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { z } from "zod";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { WorkflowGraphReview } from "@/shared/api/generated";
import { workflowGraphInputSchema, type GraphInput } from "@/shared/api/domains/workflow-graph.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Textarea } from "@/shared/components/ui/Textarea";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { workflowsKey } from "./use-workflow-mutations";
import { WorkflowGraphEditor } from "./WorkflowGraphEditor";
import { graphDraft, graphIssues, graphRequestWithinLimit } from "./workflow-graph-model";
import { flowDisplay } from "./workflow-flow";

interface Props {
  workflowId?: string;
  owner: FeatureReadOwner;
  canWrite: boolean;
  assertCurrent: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
export function WorkflowGraphDialog(props: Props) {
  const query = useQuery({
    queryKey: featureOwnedKey([...workflowsKey, "graph-review", props.workflowId], props.owner),
    enabled: props.workflowId !== undefined && props.owner.readable && !props.owner.denied,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(props.owner, signal);
      if (!props.workflowId) throw new AppError("워크플로 식별자를 확인하세요.", { kind: "contract" });
      const result = await apiClient.request(endpoints.workflowGraph.review, {
        query: { view: "review", id: props.workflowId },
        signal,
        routeId: "agents.workflows",
      });
      assertFeatureRead(props.owner, signal);
      if (result.workflow.id !== props.workflowId)
        throw new AppError("조회한 워크플로가 일치하지 않습니다.", { kind: "contract" });
      return result;
    },
  });
  if (props.workflowId && !query.data)
    return (
      <Dialog
        open
        title="분기 워크플로 편집"
        description="저장 전 검토할 현재 정의를 불러옵니다."
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        returnFocusRef={props.returnFocusRef}
      >
        {query.isError ? (
          <InlineNotice
            tone="danger"
            title="워크플로를 불러오지 못했습니다."
            actions={<Button onClick={() => void query.refetch()}>다시 조회</Button>}
          >
            {safeAppErrorMessage(query.error, "현재 정의와 조회 권한을 확인하세요.")}
          </InlineNotice>
        ) : (
          <p role="status">최신 정의를 불러오는 중입니다.</p>
        )}
      </Dialog>
    );
  return <GraphForm key={props.workflowId ?? "new"} {...props} baseline={query.data} />;
}

const schema = z.object({
  workflow: workflowGraphInputSchema,
  reason: z
    .string()
    .trim()
    .min(1, "변경 사유를 입력하세요.")
    .refine((value) => [...value].length <= 500, "변경 사유는 500자 이하로 입력하세요."),
});
type Values = z.infer<typeof schema>;
function GraphForm({ baseline, ...props }: Props & { baseline?: WorkflowGraphReview }) {
  const auth = useAuth(),
    client = useQueryClient();
  const [original] = useState(baseline);
  const [initial] = useState(() => {
    try {
      return { draft: graphDraft(original?.workflow) };
    } catch {
      return { error: "이 정의를 분기 편집기로 열 수 없습니다. 지원하는 단계 종류와 한도를 확인하세요." };
    }
  });
  if (!initial.draft)
    return (
      <Dialog
        open
        title="분기 편집 확인 필요"
        description={initial.error ?? "정의를 확인하세요."}
        returnFocusRef={props.returnFocusRef}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <Button onClick={props.onClose}>닫기</Button>
      </Dialog>
    );
  return (
    <GraphFields
      {...props}
      baseline={original}
      initial={initial.draft}
      prefixes={auth.credentialPrefixes}
      onSaved={() => void client.invalidateQueries({ queryKey: workflowsKey })}
    />
  );
}

function GraphFields({
  initial,
  baseline,
  prefixes,
  onSaved,
  ...props
}: Props & {
  initial: GraphInput;
  baseline?: WorkflowGraphReview;
  prefixes: readonly string[];
  onSaved: () => void;
}) {
  const form = useZodForm<Values, Values>(schema, { workflow: initial, reason: "" });
  const draft = form.watch("workflow"),
    reason = form.watch("reason");
  const fingerprint = JSON.stringify({ workflow: draft, reason });
  const prefixKey = JSON.stringify(prefixes);
  const authority = useMemo(
    () => ({ allowed: props.canWrite, assertCurrent: props.assertCurrent, prefixKey }),
    [props.canWrite, props.assertCurrent, prefixKey],
  );
  const latest = useRef({ fingerprint, authority, canWrite: props.canWrite });
  useLayoutEffect(() => {
    latest.current = { fingerprint, authority, canWrite: props.canWrite };
  });
  const [review, setReview] = useState<{ fingerprint: string; authority: object }>();
  const [problems, setProblems] = useState<string[]>([]);
  const [attempted, setAttempted] = useState(false);
  const attemptedRef = useRef(false),
    mounted = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (review || problems.length) {
      heading.current?.focus();
      heading.current?.scrollIntoView?.({ block: "start" });
    }
  }, [review, problems]);
  const reviewCurrent =
    !!review && review.fingerprint === fingerprint && review.authority === authority && props.canWrite;
  const prepare = async () => {
    if (attemptedRef.current || !props.canWrite) return;
    try {
      props.assertCurrent();
    } catch {
      setProblems(["조회 또는 변경 권한이 바뀌었습니다. 현재 권한을 확인한 뒤 다시 여세요."]);
      return;
    }
    const stamp = authority;
    const valid = await form.trigger(undefined, { shouldFocus: true });
    if (!mounted.current || latest.current.authority !== stamp || !latest.current.canWrite) return;
    const values = form.getValues();
    const issues = graphIssues(values.workflow);
    if (!graphRequestWithinLimit(values.workflow, values.reason, baseline?.revision ?? ""))
      issues.push(
        "단계 정의가 너무 큽니다. 메모와 참조 값을 줄인 뒤 다시 검토하세요. 요청 한도는 256KiB입니다.",
      );
    if (containsPotentialSecret(JSON.stringify(values), prefixes))
      issues.push("비밀키로 보이는 값이 있습니다. 단계 정의와 사유에서 제거한 뒤 검토하세요.");
    setProblems(issues);
    if (valid && !issues.length) setReview({ fingerprint: JSON.stringify(values), authority: stamp });
  };
  return (
    <FormDialog
      open
      wide
      scrollBody
      title={baseline ? "분기 워크플로 수정" : "새 분기 워크플로"}
      description="현재 저장된 정의가 실행됩니다. 사용 상태로 저장하면 다음 실행부터 반영됩니다. 게시 버전은 이력용 스냅샷입니다."
      form={form}
      returnFocusRef={props.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      submitLabel="검토한 정의 저장"
      submitDisabled={!reviewCurrent || attempted}
      onSubmit={async (values) => {
        props.assertCurrent();
        assertFeatureRead(props.owner);
        if (
          !review ||
          review.authority !== latest.current.authority ||
          review.fingerprint !== latest.current.fingerprint ||
          attemptedRef.current ||
          !mounted.current
        )
          throw new AppError("변경 내용과 현재 권한을 다시 검토하세요.", { kind: "permission" });
        if (graphIssues(values.workflow).length)
          throw new AppError("단계와 연결을 다시 확인하세요.", { kind: "contract" });
        attemptedRef.current = true;
        setAttempted(true);
        const result = await apiClient.request(endpoints.workflowGraph.save, {
          query: { review: "graph" },
          body: {
            workflow: values.workflow,
            reason: values.reason,
            expected_revision: baseline?.revision ?? "",
          },
          routeId: "agents.workflows",
          retryUnauthorized: false,
        });
        if (
          !mounted.current ||
          !props.owner.isCurrent() ||
          latest.current.authority !== review.authority ||
          !latest.current.canWrite
        )
          throw new AppError("현재 화면에서 결과를 확인할 수 없습니다.", { kind: "aborted" });
        if (result.workflow.id !== initial.id)
          throw new AppError("저장된 대상이 일치하지 않습니다. 현재 정의를 다시 조회하세요.", {
            kind: "contract",
          });
        onSaved();
      }}
    >
      {!props.canWrite ? (
        <InlineNotice tone="warning">현재 조회·변경 권한 또는 읽기 전용 설정을 확인하세요.</InlineNotice>
      ) : null}
      {baseline && !baseline.workflow.flow ? (
        <InlineNotice tone="warning" title="순차 정의를 분기로 전환합니다.">
          전환안은 중지 상태로 시작합니다. MCP 단계는 실제 도구 호출로 바뀌며, 조건이 거짓이면 종료 경로를
          따릅니다. 적용되지 않던 비용·테이블 제한과 채팅 도구 등록 값은 제거합니다. 아래 전후 정의를
          검토하세요.
        </InlineNotice>
      ) : null}
      <fieldset disabled={!props.canWrite || attempted} className="form-grid form-dialog-fields">
        <FormField label="워크플로 이름" required error={form.formState.errors.workflow?.name?.message}>
          {(control) => <Input {...control} {...form.register("workflow.name")} />}
        </FormField>
        <FormField label="설명" error={form.formState.errors.workflow?.description?.message}>
          {(control) => <Textarea {...control} {...form.register("workflow.description")} rows={2} />}
        </FormField>
        <FormField
          label="허용 팀"
          description="쉼표로 구분합니다. 비워 두면 모든 팀이 실행할 수 있습니다."
          error={form.formState.errors.workflow?.allowed_teams?.message}
        >
          {(control) => <Input {...control} {...form.register("workflow.allowed_teams")} />}
        </FormField>
        <FormField label="실행 허용">
          {(control) => (
            <Checkbox
              {...control}
              label="저장한 정의를 실행할 수 있게 합니다."
              {...form.register("workflow.enabled")}
            />
          )}
        </FormField>
        <WorkflowGraphEditor
          draft={draft}
          disabled={!props.canWrite || attempted}
          onChange={(value) => form.setValue("workflow", value, { shouldDirty: true, shouldValidate: true })}
        />
        <FormField label="변경 사유" required error={form.formState.errors.reason?.message}>
          {(control) => <Textarea {...control} {...form.register("reason")} rows={2} />}
        </FormField>
        <Button onClick={() => void prepare()}>변경 내용 검토</Button>
      </fieldset>
      {problems.length ? (
        <section>
          <h3 ref={heading} tabIndex={-1}>
            연결과 입력을 확인하세요
          </h3>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {reviewCurrent ? (
        <section className="workflow-graph-review">
          <h3 ref={heading} tabIndex={-1}>
            저장 전 검토
          </h3>
          <p>
            {draft.enabled
              ? "저장 후 이 정의로 새 실행을 시작할 수 있습니다."
              : "중지 상태로 저장합니다. 새 실행은 시작할 수 없습니다."}{" "}
            이미 시작한 실행은 당시 읽은 정의를 사용합니다.
          </p>
          <p>
            연결의 구조를 확인했습니다. 실제 모델·도구 호출, 전체 트래픽 영향과 비용은 검증하지 않았습니다.
          </p>
          <div className="workflow-graph-fields">
            <div>
              <h4>변경 전</h4>
              <pre>
                {baseline
                  ? flowDisplay(
                      JSON.stringify({
                        name: baseline.workflow.name,
                        enabled: baseline.workflow.enabled,
                        allowed_teams: baseline.workflow.allowed_teams,
                      }),
                      prefixes,
                    )
                  : "새 워크플로"}
              </pre>
            </div>
            <div>
              <h4>변경 후</h4>
              <pre>
                {flowDisplay(
                  JSON.stringify({
                    name: draft.name,
                    enabled: draft.enabled,
                    allowed_teams: draft.allowed_teams,
                  }),
                  prefixes,
                )}
              </pre>
            </div>
          </div>
          <details>
            <summary>단계와 연결의 전체 전후 정의 보기</summary>
            <div className="workflow-graph-fields">
              <pre>
                {baseline
                  ? containsPotentialSecret(JSON.stringify(baseline.workflow), prefixes)
                    ? "민감정보가 포함될 수 있어 전체 정의를 표시하지 않습니다."
                    : JSON.stringify(baseline.workflow, null, 2)
                  : "없음"}
              </pre>
              <pre>{JSON.stringify(draft, null, 2)}</pre>
            </div>
          </details>
        </section>
      ) : review ? (
        <p role="status">입력 또는 권한이 바뀌었습니다. 변경 내용을 다시 검토하세요.</p>
      ) : null}
      {attempted ? (
        <InlineNotice tone="info">
          저장 요청을 보냈습니다. 결과가 불명확하거나 충돌하면 이 창을 닫고 최신 정의를 다시 조회하세요. 같은
          요청은 자동으로 재전송하지 않습니다.
        </InlineNotice>
      ) : null}
    </FormDialog>
  );
}
