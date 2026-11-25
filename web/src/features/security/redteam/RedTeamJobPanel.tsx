import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/domains/redteam";
import { redTeamJobEndpoints, type RedTeamJobView } from "@/shared/api/domains/redteam-jobs";
import type { ReviewedRedTeamOutcome } from "@/shared/api/domains/redteam-reviewed";
import { AppError, isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { formatDateTime, formatNumber, formatKRW } from "@/shared/utils/format";
import { redTeamJobKey, type RedTeamJobRef } from "@/shared/utils/redteam-job-query";
import { PanelFailure } from "./RedTeamParts";
import { redteamKeys, routeId } from "./use-redteam-data";

const labels: Record<RedTeamJobView["status"], string> = {
  running: "레드팀 검사 진행 중",
  completed: "레드팀 검사 완료",
  stopped: "레드팀 검사 중단",
  unknown: "레드팀 결과 저장 확인 필요",
  interrupted: "레드팀 작업 연결 끊김",
};
type Props = {
  job: RedTeamJobRef;
  onClose: () => void;
  onOutcome: (outcome: ReviewedRedTeamOutcome) => void;
};

export function RedTeamJobPanel(props: Props): React.JSX.Element {
  const owner = useFeatureReadOwner(routeId, `redteam-job:${props.job.id}:${props.job.campaign}`);
  return <JobSession key={owner.id} {...props} owner={owner} />;
}
function JobSession({
  job: ref,
  onClose,
  onOutcome,
  owner,
}: Props & { owner: FeatureReadOwner }): React.JSX.Element {
  const client = useQueryClient();
  const [firstReadAt] = useState(() => Date.now());
  const lastInvalidated = useRef("");
  const job = useQuery<RedTeamJobView>({
    queryKey: featureOwnedKey(redTeamJobKey(ref), owner),
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    retry: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => {
      const { data, error } = query.state;
      if (!owner.isCurrent()) return false;
      // The address is saved before POST. Its first GET may precede admission;
      // a short, read-only check recovers even when the POST response is lost.
      if (!data && isAppError(error) && error.status === 404 && Date.now() - firstReadAt < 30_000)
        return 2_000;
      return !error && data?.status === "running" ? 2_000 : false;
    },
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const value = await apiClient.request(withPathParams(redTeamJobEndpoints.read, { id: ref.campaign }), {
        query: { job_id: ref.id },
        signal,
        routeId,
      });
      assertFeatureRead(owner, signal);
      if (value.id !== ref.id || value.campaign_id !== ref.campaign)
        throw new AppError("실행 작업의 대상을 확인하지 못했습니다.", { kind: "contract" });
      return value;
    },
  });
  const current = owner.isCurrent() ? job.data : undefined;
  useEffect(() => {
    if (
      !owner.isCurrent() ||
      !current ||
      current.status === "running" ||
      lastInvalidated.current === current.id
    )
      return;
    lastInvalidated.current = current.id;
    for (const key of [
      redteamKeys.runs,
      redteamKeys.campaigns,
      redteamKeys.dashboard,
      redteamKeys.baselines,
      redteamKeys.remediations,
    ])
      void client.invalidateQueries({ queryKey: key });
  }, [client, current, owner]);

  if (!owner.readable || owner.denied)
    return (
      <InlineNotice tone="danger" title="레드팀 작업 조회 권한을 확인하세요.">
        현재 계정이 접수한 작업만 조회할 수 있습니다.
        <Button variant="secondary" onClick={onClose}>
          작업 주소 지우기
        </Button>
      </InlineNotice>
    );
  return (
    <SectionCard
      className="rt-job-panel"
      title={current ? labels[current.status] : "레드팀 작업 상태"}
      description="접수한 검사는 화면을 닫아도 서버에서 계속 처리합니다. 이 주소에서 진행 상태를 다시 확인할 수 있습니다."
    >
      {job.isPending ? <p role="status">접수된 작업을 확인하고 있습니다.</p> : null}
      {job.isError ? (
        <PanelFailure
          error={job.error}
          hasData={Boolean(current)}
          label="실행 작업"
          onRetry={() => {
            if (owner.isCurrent()) void job.refetch();
          }}
        />
      ) : null}
      {current ? (
        <div className="rt-stack">
          <div role="status">
            <KeyValueList
              className="rt-job-progress"
              items={[
                {
                  label: "검사 완료",
                  value: `${formatNumber(current.progress.completed_cases)} / ${formatNumber(current.planned_case_executions)}건`,
                },
                {
                  label: "실제 모델 호출",
                  value: `${formatNumber(current.progress.live_calls)} / ${formatNumber(current.planned_live_calls)}회`,
                },
                { label: "기록된 비용", value: formatKRW(current.progress.cost_krw) },
                {
                  label: "마지막 확인",
                  value: <time dateTime={current.updated_at}>{formatDateTime(current.updated_at)}</time>,
                },
              ]}
            />
          </div>
          {current.status !== "running" && current.status !== "completed" ? (
            <InlineNotice tone="warning" title="실행 이력과 저장 상태를 확인하세요.">
              일부 모델 호출은 이미 처리됐을 수 있습니다. 같은 작업을 자동으로 재실행하지 않습니다. 다시
              실행하려면 이력을 확인하고 새로 검토하세요.
            </InlineNotice>
          ) : null}
        </div>
      ) : null}
      <div className="rt-execution-actions">
        <Button
          variant="secondary"
          disabled={job.isFetching}
          onClick={() => {
            if (owner.isCurrent()) void job.refetch();
          }}
        >
          작업 상태 새로고침
        </Button>
        {current?.outcome ? (
          <Button
            variant="secondary"
            onClick={() => {
              if (owner.isCurrent() && current.outcome) onOutcome(current.outcome);
            }}
          >
            저장된 실행 결과
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          작업 표시 닫기
        </Button>
      </div>
    </SectionCard>
  );
}
