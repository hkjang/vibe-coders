import { useRunHistoryOwner } from "./run-history-context";
import { featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { readEvidence } from "./evidence-read-api";
import { EvidenceVersionNotice } from "./EvidenceVersionNotice";
import { RedTeamRawEvidence } from "./RedTeamRawEvidence";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Sheet } from "@/shared/components/ui/Sheet";
import { EvidenceText, PanelFailure } from "./RedTeamParts";
import { expectedPolicyLabel } from "./redteam-labels";
import { redteamKeys } from "./use-redteam-data";
import { RedTeamReviewedReplay } from "./RedTeamReviewedReplay";

export function RedTeamEvidenceSheet({
  canWrite,
  onClose,
  onCreateRemediation,
  onOpenRun,
  onOpenHistory,
  proxyKey,
  resultId,
  returnFocusRef,
  writeTitle,
}: {
  canWrite: boolean;
  onClose: () => void;
  onCreateRemediation: (resultId: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenHistory?: (resultId: string) => void;
  proxyKey: string;
  resultId: string;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  writeTitle: string | undefined;
}): React.JSX.Element {
  const [pendingRerun, setPendingRerun] = useState(false);
  const queryClient = useQueryClient();
  const replayTrigger = useRef<HTMLButtonElement>(null);
  const owner = useRunHistoryOwner();
  const auth = useAuth();
  const supported = versionAtLeast(auth.backendVersion, "v0.86.146");
  const evidence = useQuery({
    queryKey: owner ? featureOwnedKey(redteamKeys.evidence(resultId), owner) : redteamKeys.evidence(resultId),
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      if (!owner) throw new Error("증적 조회 권한을 확인하지 못했습니다.");
      return readEvidence(resultId, false, owner, signal);
    },
    enabled: resultId !== "" && supported && Boolean(owner?.readable && !owner.denied),
  });

  const response = supported && owner?.readable && !owner.denied ? evidence.data : undefined;
  const record = response?.evidence;
  const headers: Readonly<Record<string, unknown>> = record?.headers_summary ?? {};
  const headerText = (key: string): string => {
    const value = headers[key];
    return value === undefined || value === null ? "" : String(value);
  };
  const findings = Array.isArray(headers.leak_findings) ? headers.leak_findings : [];

  return (
    <>
      <Sheet
        open={resultId !== ""}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="증적 상세"
        description="어느 제공자·모델에 무엇을 보내 어떤 응답을 받았는지입니다. 기본은 마스킹본입니다."
        returnFocusRef={returnFocusRef}
        size="wide"
      >
        {!supported ? <EvidenceVersionNotice /> : null}
        {supported && evidence.isError ? (
          <PanelFailure
            error={evidence.error}
            hasData={Boolean(evidence.data)}
            label="증적"
            onRetry={() => void evidence.refetch()}
          />
        ) : null}
        {record ? (
          <div className="rt-stack">
            <KeyValueList
              items={[
                { label: "대상", value: headerText("target") },
                { label: "제공자", value: headerText("provider") },
                { label: "모델", value: headerText("model") },
                { label: "HTTP 상태", value: headerText("http_status") },
                { label: "기대 정책", value: expectedPolicyLabel(headerText("expected")) },
                { label: "지연(ms)", value: headerText("latency_ms") },
                { label: "비용(KRW)", value: headerText("cost_krw") },
                {
                  label: "유출 탐지",
                  value:
                    findings.length > 0 ? (
                      <span className="badge-list">
                        {findings.map((finding, index) => (
                          <Badge key={index} tone="danger">
                            {String(finding)}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      "없음"
                    ),
                },
              ]}
            />
            <div className="rt-button-row">
              <Button
                variant="primary"
                ref={replayTrigger}
                disabled={!canWrite}
                title={writeTitle}
                onClick={() => setPendingRerun(true)}
              >
                조건 검토 후 한 건 재실행
              </Button>
              <Button disabled={!canWrite} title={writeTitle} onClick={() => onCreateRemediation(resultId)}>
                이 결과에 조치 생성
              </Button>
            </div>
            <Badge tone="muted">마스킹본</Badge>
            <EvidenceText label="요청 프롬프트 (실제 전송 형태 · 마스킹)" value={record.masked_prompt} />
            <EvidenceText label="대상 응답 (마스킹)" value={record.masked_response} />
            <p className="rt-muted">
              {response && response.tool_call_count > 0
                ? `도구 호출 ${response.tool_call_count}건 · 인수는 원문 조회에서 확인할 수 있습니다.`
                : "도구 호출 없음"}
            </p>
            {response && owner ? (
              <RedTeamRawEvidence key={`${owner.id}:${resultId}`} response={response} owner={owner} />
            ) : null}
            <JsonBlock label="헤더 · 메타 요약" value={headers} />
            {record.export_hash !== "" ? (
              <p className="rt-muted">
                증적 해시: <code className="mono">{record.export_hash}</code>
              </p>
            ) : null}
          </div>
        ) : supported && evidence.isPending && resultId !== "" ? (
          <p role="status">증적을 불러오는 중입니다.</p>
        ) : null}
      </Sheet>

      {pendingRerun && resultId !== "" ? (
        <RedTeamReviewedReplay
          key={resultId}
          resultId={resultId}
          model={headerText("model")}
          proxyKey={proxyKey}
          canWrite={canWrite}
          returnFocusRef={replayTrigger}
          onClose={() => setPendingRerun(false)}
          onResult={() => {
            for (const queryKey of [redteamKeys.runs, redteamKeys.dashboard, redteamKeys.remediations])
              void queryClient.invalidateQueries({ queryKey });
          }}
          onOpenHistory={
            onOpenHistory
              ? (id) => {
                  setPendingRerun(false);
                  onClose();
                  onOpenHistory(id);
                }
              : undefined
          }
          onOpenRun={(id) => {
            setPendingRerun(false);
            onClose();
            onOpenRun(id);
          }}
        />
      ) : null}
    </>
  );
}
