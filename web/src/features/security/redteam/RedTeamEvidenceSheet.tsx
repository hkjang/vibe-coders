import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Sheet } from "@/shared/components/ui/Sheet";
import { MaskedText, PanelFailure } from "./RedTeamParts";
import { expectedPolicyLabel } from "./redteam-labels";
import { redteamKeys, routeId } from "./use-redteam-data";
import { RedTeamReviewedReplay } from "./RedTeamReviewedReplay";
const redteam = endpoints.domains.redteam;

export function RedTeamEvidenceSheet({
  canWrite,
  onClose,
  onCreateRemediation,
  onOpenRun,
  proxyKey,
  resultId,
  returnFocusRef,
  writeTitle,
}: {
  canWrite: boolean;
  onClose: () => void;
  onCreateRemediation: (resultId: string) => void;
  onOpenRun: (runId: string) => void;
  proxyKey: string;
  resultId: string;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  writeTitle: string | undefined;
}): React.JSX.Element {
  const [pendingRerun, setPendingRerun] = useState(false);
  const queryClient = useQueryClient();
  const replayTrigger = useRef<HTMLButtonElement>(null);
  const evidence = useQuery({
    queryKey: redteamKeys.evidence(resultId),
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(redteam.results.evidence, { id: resultId }), {
        signal,
        routeId,
      }),
    enabled: resultId !== "",
  });

  const record = evidence.data?.evidence;
  const headers = record?.headers_summary ?? {};
  const headerText = (key: string): string => {
    const value = headers[key];
    return value === undefined || value === null ? "" : String(value);
  };
  const findings = Array.isArray(headers.leak_findings) ? headers.leak_findings : [];
  const hasRaw = (record?.raw_prompt ?? "") !== "" || (record?.raw_response ?? "") !== "";

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
        {evidence.isError ? (
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
            {headerText("seed_template") !== "" ? (
              <MaskedText label="요청 시드 (원문 프롬프트)" value={headerText("seed_template")} />
            ) : null}
            <MaskedText label="요청 프롬프트 (실제 전송 형태 · 마스킹)" value={record.masked_prompt} />
            <MaskedText label="대상 응답 (마스킹)" value={record.masked_response} />
            {hasRaw ? (
              <div className="rt-raw-evidence">
                <InlineNotice tone="danger" title="원문 증적 (관리자 전용 · 마스킹 안 됨)">
                  이 캠페인은 원문 보관이 켜져 있어 마스킹하지 않은 요청/응답을 표시합니다.
                </InlineNotice>
                <MaskedText label="실제 요청 프롬프트 (원문)" value={record.raw_prompt} />
                <MaskedText label="실제 모델 응답 (원문)" value={record.raw_response} />
              </div>
            ) : (
              <p className="rt-muted">
                원문 증적 보관이 꺼져 있어 마스킹본만 표시됩니다. &lsquo;조건 검토 후 한 건 재실행&rsquo;으로
                실제 요청/응답을 확인하세요.
              </p>
            )}
            {record.tool_calls.length > 0 ? (
              <JsonBlock label="도구 호출" value={record.tool_calls} />
            ) : (
              <p className="rt-muted">도구 호출 없음</p>
            )}
            <JsonBlock label="헤더 · 메타 요약" value={headers} />
            {record.export_hash !== "" ? (
              <p className="rt-muted">
                증적 해시: <code className="mono">{record.export_hash}</code>
              </p>
            ) : null}
          </div>
        ) : evidence.isPending && resultId !== "" ? (
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
