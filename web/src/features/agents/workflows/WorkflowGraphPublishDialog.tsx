import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { WorkflowGraphReview } from "@/shared/api/generated";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { withPathParams } from "../endpoint-path";
import { workflowsKey } from "./use-workflow-mutations";
import { WorkflowGraphRead } from "./WorkflowGraphRead";
import { flowDisplay } from "./workflow-flow";

interface Props {
  workflowId: string;
  owner: FeatureReadOwner;
  canWrite: boolean;
  assertCurrent: () => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
export function WorkflowGraphPublishDialog(props: Props) {
  const query = useQuery({
    queryKey: featureOwnedKey([...workflowsKey, "graph-publish", props.workflowId], props.owner),
    enabled: props.owner.readable && !props.owner.denied,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(props.owner, signal);
      const result = await apiClient.request(endpoints.workflowGraph.review, {
        query: { view: "review", id: props.workflowId },
        signal,
        routeId: "agents.workflows",
      });
      assertFeatureRead(props.owner, signal);
      if (result.workflow.id !== props.workflowId || !result.workflow.flow)
        throw new AppError("게시할 분기 정의가 바뀌었습니다. 다시 조회하세요.", { kind: "contract" });
      return result;
    },
  });
  if (!query.data)
    return (
      <Dialog
        open
        title="분기 게시 검토"
        description="게시할 현재 정의를 조회합니다."
        returnFocusRef={props.returnFocusRef}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        {query.isError ? (
          <InlineNotice
            tone="danger"
            title="게시할 정의를 불러오지 못했습니다."
            actions={<Button onClick={() => void query.refetch()}>다시 조회</Button>}
          >
            {safeAppErrorMessage(query.error, "조회 권한과 정의를 확인하세요.")}
          </InlineNotice>
        ) : (
          <p role="status">현재 정의를 불러오는 중입니다.</p>
        )}
      </Dialog>
    );
  return <PublishReview {...props} baseline={query.data} />;
}
function PublishReview({ baseline, ...props }: Props & { baseline: WorkflowGraphReview }) {
  const [original] = useState(baseline),
    [attempted, setAttempted] = useState(false);
  const attemptedRef = useRef(false),
    mounted = useRef(false);
  const client = useQueryClient(),
    auth = useAuth();
  const prefixKey = JSON.stringify(auth.credentialPrefixes);
  const authority = useMemo(
    () => ({ allowed: props.canWrite, assert: props.assertCurrent, prefixKey }),
    [props.canWrite, props.assertCurrent, prefixKey],
  );
  const [initialAuthority] = useState(authority);
  const latest = useRef(authority);
  useLayoutEffect(() => {
    latest.current = authority;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const changed = authority !== initialAuthority;
  const wf = original.workflow;
  return (
    <ConfirmDialog
      observation="activate"
      open
      scrollBody
      title="분기 워크플로 게시"
      description="검토한 정의를 버전 이력으로 남기고 사용 상태로 바꿉니다. 다음 실행은 현재 저장된 정의를 사용하며 게시 버전에 고정되지 않습니다."
      confirmLabel="검토한 정의 게시"
      requireReason
      confirmDisabled={!props.canWrite || changed || attempted}
      returnFocusRef={props.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      onConfirm={async (note) => {
        props.assertCurrent();
        assertFeatureRead(props.owner);
        if (
          !mounted.current ||
          attemptedRef.current ||
          latest.current !== initialAuthority ||
          !latest.current.allowed
        )
          throw new AppError("현재 권한으로 다시 검토하세요.", { kind: "permission" });
        if ([...note].length > 500 || containsPotentialSecret(note, auth.credentialPrefixes))
          throw new AppError("사유는 비밀키 없이 500자 이하로 입력하세요.", {
            kind: "contract",
            code: "workflow_graph_publish_reason",
          });
        attemptedRef.current = true;
        setAttempted(true);
        const result = await apiClient.request(
          withPathParams(endpoints.workflowGraph.publish, { id: wf.id }),
          {
            body: { expected_revision: original.revision, note },
            routeId: "agents.workflows",
            retryUnauthorized: false,
          },
        );
        props.assertCurrent();
        assertFeatureRead(props.owner);
        if (!mounted.current || latest.current !== initialAuthority)
          throw new AppError("게시 결과를 최신 정의에서 확인하세요.", { kind: "aborted" });
        if (result.workflow_id !== wf.id || !result.enabled || !result.published)
          throw new AppError("게시 결과가 일치하지 않습니다. 최신 정의를 확인하세요.", { kind: "contract" });
        void client.invalidateQueries({ queryKey: workflowsKey });
      }}
    >
      <KeyValueList
        items={[
          { label: "이름", value: flowDisplay(wf.name, auth.credentialPrefixes) },
          { label: "상태 변경", value: wf.enabled ? "사용 → 사용 (새 버전 기록)" : "중지 → 사용" },
          { label: "실행 허용 팀", value: flowDisplay(wf.allowed_teams || "전체", auth.credentialPrefixes) },
          { label: "정의 단계", value: String(wf.steps?.length ?? 0) },
        ]}
      />
      {changed ? (
        <InlineNotice tone="warning">권한이 변경됐습니다. 닫은 뒤 다시 조회해 검토하세요.</InlineNotice>
      ) : null}
      {attempted ? (
        <InlineNotice tone="warning">
          게시 요청을 보냈습니다. 응답을 확인하지 못한 경우에도 적용됐을 수 있으므로 다시 전송하지 않습니다.
          닫은 뒤 현재 상태와 버전 이력을 조회하세요.
        </InlineNotice>
      ) : null}
      <WorkflowGraphRead workflow={wf} prefixes={auth.credentialPrefixes} />
      <p>게시 사유는 비밀키를 포함하지 않고 500자 이하로 입력하세요.</p>
    </ConfirmDialog>
  );
}
