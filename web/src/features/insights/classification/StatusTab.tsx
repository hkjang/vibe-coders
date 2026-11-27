import { Settings } from "lucide-react";
import { Link } from "react-router";

import type { WorkIntelStatus } from "@/shared/api/domains/insights-classification";
import { Badge } from "@/shared/components/ui/Badge";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import {
  formatDateTime,
  formatKRW,
  formatNumber,
  formatPercent,
  formatRelative,
} from "@/shared/utils/format";

import { formatLag, methodDistribution, workIntelSettingsLink } from "./classification-model";

function OnOff({
  on,
  onLabel = "켜짐",
  offLabel = "꺼짐",
}: {
  on: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return <Badge tone={on ? "success" : "muted"}>{on ? onLabel : offLabel}</Badge>;
}

export function StatusTab({ status }: { status: WorkIntelStatus }): React.JSX.Element {
  const methods = methodDistribution(status.by_method);
  const classified = methods.reduce((sum, row) => sum + row.count, 0);
  const lagging = status.classify_enabled && status.lag_seconds > 300;
  return (
    <>
      <InlineNotice tone="info" title="분류는 요청 처리와 따로 돌아갑니다.">
        분류 워커는 요청이 끝난 뒤 요청 로그를 읽어 백그라운드에서 분류합니다. 요청 경로에서는 실행되지
        않으므로, 분류가 밀리거나 실패하거나 분류 모델이 느려도 API 응답 속도와 스트리밍에는 영향이 없습니다.
        미처리 건수와 지연은 통계가 최신 요청을 얼마나 따라왔는지를 뜻합니다.
      </InlineNotice>

      {!status.classify_enabled ? (
        <InlineNotice tone="warning" title="분류 엔진이 꺼져 있습니다.">
          새 요청이 분류되지 않아 업무 활용 분석에 반영되지 않습니다. 시스템 설정의
          WORK_INTEL_CLASSIFY_ENABLED 로 켤 수 있습니다.
        </InlineNotice>
      ) : !status.worker_active ? (
        <InlineNotice tone="warning" title="분류 워커가 동작하고 있지 않습니다.">
          분류 엔진은 켜져 있지만 지금 일하는 워커가 없습니다. 게이트웨이가 막 시작됐거나 다른 인스턴스가 처리
          중일 수 있습니다. 미처리 건수가 계속 늘면 게이트웨이 로그를 확인하세요.
        </InlineNotice>
      ) : null}
      {status.last_error ? (
        <InlineNotice tone="danger" title="마지막 오류">
          <span className="wc-wrap">{status.last_error}</span>
        </InlineNotice>
      ) : null}

      <SectionCard
        headingLevel={3}
        title="기능 상태"
        description="분류와 분석은 게이트웨이를 다시 시작하지 않고 시스템 설정에서 켜고 끌 수 있습니다."
        actions={
          <Link className="button button-secondary button-small" to={workIntelSettingsLink}>
            <Settings aria-hidden="true" /> 시스템 설정에서 WORK_INTEL_* 열기
          </Link>
        }
      >
        <dl className="wc-feature-list">
          <div>
            <dt>분류 엔진</dt>
            <dd>
              <OnOff on={status.classify_enabled} />{" "}
              {status.classify_enabled ? (
                <OnOff on={status.worker_active} onLabel="워커 동작 중" offLabel="워커 쉬는 중" />
              ) : null}
            </dd>
          </div>
          <div>
            <dt>업무 활용 분석</dt>
            <dd>
              <OnOff on={status.analytics_enabled} />
            </dd>
          </div>
          <div>
            <dt>LLM 의미 분류</dt>
            <dd>
              <OnOff on={status.llm_enabled} />{" "}
              {status.llm_enabled ? (
                <span className="wc-muted">
                  {status.llm_model || "모델 미지정"} ·{" "}
                  {status.llm_external_allowed ? "외부 Provider 전송 허용" : "사설망 Provider만"}
                </span>
              ) : (
                <span className="wc-muted">규칙과 캐시만으로 분류합니다.</span>
              )}
            </dd>
          </div>
          <div>
            <dt>정책 버전</dt>
            <dd>{status.policy_version > 0 ? `버전 ${status.policy_version}` : "배포된 정책 없음"}</dd>
          </div>
        </dl>
      </SectionCard>

      <StatGrid label="분류 처리 현황">
        <StatCard
          label="미처리"
          value={`${formatNumber(status.backlog)}건`}
          tone={status.backlog > 0 && lagging ? "warning" : "default"}
          hint="아직 분류하지 않은 요청"
        />
        <StatCard
          label="지연"
          value={formatLag(status.lag_seconds)}
          tone={lagging ? "warning" : "default"}
          hint="가장 최근 요청과 분류 위치의 차이"
        />
        <StatCard
          label="최근 24시간 처리"
          value={`${formatNumber(status.processed_24h)}건`}
          hint={`누적 ${formatNumber(status.processed_total)}건`}
        />
        <StatCard
          label="실패 (24시간)"
          value={`${formatNumber(status.failures_24h)}건`}
          tone={status.failures_24h > 0 ? "danger" : "default"}
          hint="분류하지 못해 검토 탭으로 간 요청"
        />
        <StatCard
          label="LLM 호출 (24시간)"
          value={`${formatNumber(status.llm_calls_24h)}회`}
          hint={`${formatNumber(status.llm_tokens_24h)} 토큰 · ${formatKRW(status.llm_cost_krw_24h)}`}
        />
        <StatCard
          label="캐시 적중 (24시간)"
          value={`${formatNumber(status.cache_hits_24h)}건`}
          hint="같은 지문의 이전 결과를 재사용"
        />
      </StatGrid>

      <SectionCard
        headingLevel={3}
        title="방식별 분포 (최근 24시간)"
        description="규칙으로 확정한 요청, 캐시를 재사용한 요청, LLM에 물은 요청, 관리자가 보정한 요청의 비중입니다."
      >
        {classified === 0 ? (
          <p className="wc-muted">최근 24시간에 분류한 요청이 없습니다.</p>
        ) : (
          <ul className="wc-bars" aria-label="방식별 분류 건수">
            {methods.map((row) => (
              <li key={row.method}>
                <span className="wc-bar-label">{row.label}</span>
                <span className="wc-bar-track" aria-hidden="true">
                  <span className="wc-bar-fill" style={{ width: `${Math.round(row.share * 100)}%` }} />
                </span>
                <span className="wc-bar-value">
                  {formatNumber(row.count)}건 · {formatPercent(row.share)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard headingLevel={3} title="워커">
        <KeyValueList
          columns={3}
          items={[
            {
              label: "마지막 실행",
              value: status.last_run_at
                ? `${formatDateTime(status.last_run_at)} (${formatRelative(status.last_run_at)})`
                : "",
            },
            {
              label: "분류 위치(커서)",
              value: status.cursor_at ? formatDateTime(status.cursor_at) : "",
            },
            { label: "누적 처리", value: `${formatNumber(status.processed_total)}건` },
          ]}
        />
      </SectionCard>
    </>
  );
}
