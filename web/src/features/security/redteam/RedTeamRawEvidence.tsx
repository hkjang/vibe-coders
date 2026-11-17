import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import type { EvidenceRead } from "@/shared/api/domains/redteam-evidence-read";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { featureOwnedKey, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { EvidenceText, PanelFailure } from "./RedTeamParts";
import { readEvidence } from "./evidence-read-api";
import { redteamKeys } from "./use-redteam-data";

// Mount per result and read owner. Closing unmounts the raw query observer;
// gcTime=0 removes the payload and signal cancellation fences a late response.
export function RedTeamRawEvidence({ response, owner }: { response: EvidenceRead; owner: FeatureReadOwner }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const allowed = response.raw_allowed && auth.capabilities.raw_prompt_view;
  if (!allowed) return <p className="rt-muted">원문 증적 조회 권한이 없어 마스킹본만 표시합니다.</p>;
  if (!response.raw_available) return <p className="rt-muted">저장된 원문 증적이 없습니다.</p>;
  return (
    <section className="rt-stack" aria-label="원문 증적 조회">
      <div className="rt-button-row">
        <Button onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? "원문 닫기" : "원문 보기"}
        </Button>
        <span className="rt-muted">원문을 열면 사용자와 조회 대상이 감사 기록에 남습니다.</span>
      </div>
      {open ? <RawEvidence resultId={response.evidence.result_id} owner={owner} /> : null}
    </section>
  );
}

function RawEvidence({ resultId, owner }: { resultId: string; owner: FeatureReadOwner }) {
  const query = useQuery({
    queryKey: featureOwnedKey([...redteamKeys.evidence(resultId), "raw"], owner),
    queryFn: ({ signal }) => readEvidence(resultId, true, owner, signal),
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    // Broad refresh/invalidation must never trigger an additional original read.
    staleTime: "static",
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
  if (query.isPending) return <p role="status">권한과 감사 기록을 확인한 뒤 원문을 불러오는 중입니다.</p>;
  if (query.isError)
    return (
      <PanelFailure
        error={query.error}
        hasData={false}
        label="원문 증적"
        onRetry={() => void query.refetch()}
      />
    );
  const record = query.data.evidence;
  return (
    <div className="rt-stack rt-raw-evidence">
      <InlineNotice tone="warning" title="마스킹하지 않은 원문입니다.">
        다른 사람에게 공유하기 전에 내용을 확인하세요. 패널을 닫으면 이 화면의 원문 조회 캐시를 지웁니다.
      </InlineNotice>
      <EvidenceText label="실제 요청 프롬프트 (원문)" value={record.raw_prompt ?? ""} />
      <EvidenceText label="실제 모델 응답 (원문)" value={record.raw_response ?? ""} />
      {record.tool_calls.length ? <JsonBlock label="도구 호출 (원문)" value={record.tool_calls} /> : null}
    </div>
  );
}
