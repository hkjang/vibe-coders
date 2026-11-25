import { ArrowRight, Ban, EyeOff, Flag, ShieldCheck, Sparkles } from "lucide-react";

import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Switch } from "@/shared/components/ui/Switch";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import type { DLPEditorProps } from "./DLPPage";
import {
  actionLabels,
  actionTones,
  checkLabels,
  formatBytes,
  profileName,
  readinessNotes,
  strongestActions,
  withRecommended,
  type DLPTabId,
} from "./dlp-model";
import { useDLPEvents } from "./use-dlp";

const scanLimits = [64 << 10, 256 << 10, 1 << 20, 4 << 20, 8 << 20];

export function DLPOverviewTab({
  settings,
  draft,
  onChange,
  canWrite,
  writeReason,
  refreshInterval,
  onNavigate,
}: DLPEditorProps & {
  refreshInterval: number | false;
  onNavigate: (tab: DLPTabId) => void;
}): React.JSX.Element {
  const events = useDLPEvents({ hours: 24, limit: 1 }, refreshInterval);
  const summary = events.data?.summary;
  const requestsFor = (action: string): number =>
    summary?.by_action.find((row) => row.key === action)?.requests ?? 0;
  const topProfile = summary?.by_profile[0];
  const strongest = strongestActions(draft.policies);
  const enabledPolicies = draft.policies.filter((policy) => policy.enabled).length;
  const notes = readinessNotes(draft);
  const scanOptions = scanLimits.includes(draft.max_scan_bytes)
    ? scanLimits
    : [...scanLimits, draft.max_scan_bytes].sort((a, b) => a - b);

  return (
    <>
      <SectionCard
        title="상태"
        description={
          settings.revision > 0
            ? `버전 ${settings.revision} · ${settings.updated_by || "알 수 없음"} · ${formatDateTime(settings.updated_at)}`
            : "아직 저장된 설정이 없습니다. 기본값은 꺼짐입니다."
        }
      >
        <div className="dlp-status">
          <Switch
            checked={draft.enabled}
            label={draft.enabled ? "DLP 켜짐" : "DLP 꺼짐"}
            disabled={!canWrite}
            title={canWrite ? undefined : writeReason}
            onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          />
          <dl className="dlp-status-facts">
            <div>
              <dt>켜진 정책</dt>
              <dd>
                {formatNumber(enabledPolicies)} / {formatNumber(draft.policies.length)}
              </dd>
            </div>
            {(["REQUEST", "RESPONSE"] as const).map((check) => (
              <div key={check}>
                <dt>{checkLabels[check]} 검사</dt>
                <dd>
                  {strongest[check] ? (
                    <Badge tone={actionTones[strongest[check]]}>최대 {actionLabels[strongest[check]]}</Badge>
                  ) : (
                    <span className="dlp-muted">검사 안 함</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {notes.length > 0 ? (
          <ul className="dlp-notes">
            {notes.map((note) => (
              <li key={note.text} data-tone={note.tone}>
                {note.text}
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      <StatGrid label="최근 24시간 DLP 탐지">
        <StatCard
          icon={<Ban aria-hidden="true" />}
          label="차단한 요청"
          tone={requestsFor("BLOCK") > 0 ? "danger" : "default"}
          value={events.isPending ? "—" : formatNumber(requestsFor("BLOCK"))}
          hint="최근 24시간"
        />
        <StatCard
          icon={<EyeOff aria-hidden="true" />}
          label="마스킹한 요청"
          tone={requestsFor("MASK") > 0 ? "warning" : "default"}
          value={events.isPending ? "—" : formatNumber(requestsFor("MASK"))}
          hint="최근 24시간"
        />
        <StatCard
          icon={<Flag aria-hidden="true" />}
          label="기록만 한 요청"
          tone="info"
          value={events.isPending ? "—" : formatNumber(requestsFor("FLAG"))}
          hint="최근 24시간"
        />
        <StatCard
          icon={<ShieldCheck aria-hidden="true" />}
          label="가장 많이 탐지된 프로필"
          value={topProfile ? profileName(topProfile.key, settings.catalog, draft) : "—"}
          hint={topProfile ? `${formatNumber(topProfile.matches)}건 일치` : "탐지 없음"}
        />
      </StatGrid>

      {draft.policies.length === 0 ? (
        <SectionCard title="시작하기">
          <EmptyState
            icon={<Sparkles aria-hidden="true" />}
            title="아직 정책이 없습니다."
            description="권장 정책은 인증정보를 마스킹하고, 주민등록번호 같은 국가 식별번호가 담긴 요청을 차단하고, 그 밖의 개인정보·금융·의료 정보는 기록만 합니다. 추가한 뒤 테스트 스캔으로 확인하고 저장하세요."
            actions={
              canWrite ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    onChange(withRecommended(draft, settings.recommended_policies));
                    onNavigate("policies");
                  }}
                >
                  <Sparkles aria-hidden="true" /> 권장 정책 추가
                </Button>
              ) : undefined
            }
          />
        </SectionCard>
      ) : null}

      <SectionCard
        title="작동 방식"
        description="정책은 순서와 상관없이 모두 평가하고, 걸린 정책 중 가장 강한 동작을 적용합니다."
      >
        <ol className="dlp-flow" aria-label="DLP 검사 순서">
          <li>
            <strong>인증</strong>
            <span>키·팀 확인</span>
          </li>
          <li data-active={strongest.REQUEST !== "" || undefined}>
            <strong>요청 검사</strong>
            <span>{strongest.REQUEST ? `최대 ${actionLabels[strongest.REQUEST]}` : "정책 없음"}</span>
          </li>
          <li>
            <strong>라우팅·캐시</strong>
            <span>마스킹된 요청 기준</span>
          </li>
          <li>
            <strong>모델 공급자</strong>
            <span>원래 값은 전달되지 않음</span>
          </li>
          <li data-active={strongest.RESPONSE !== "" || undefined}>
            <strong>응답 검사</strong>
            <span>{strongest.RESPONSE ? `최대 ${actionLabels[strongest.RESPONSE]}` : "정책 없음"}</span>
          </li>
          <li>
            <strong>클라이언트</strong>
            <span>
              <code>{settings.response_header}</code> 헤더
            </span>
          </li>
        </ol>
        <ul className="dlp-facts">
          <li>
            요청 검사는 라우팅과 캐시보다 먼저 일어나, 마스킹된 요청이 라우팅·캐시·공급자·요청 로그 모두에
            쓰입니다.
          </li>
          <li>
            응답을 검사하는 정책이 있으면 스트리밍 응답도 끝까지 받아 검사합니다. 이벤트 사이에 나뉜 값도 이어
            붙여 찾고, 스트림 형식은 그대로 유지합니다.
          </li>
          <li>
            캐시에서 꺼낸 응답도 지금 정책으로 다시 검사합니다. 정책을 강화하면 이미 캐시된 응답에도 바로
            적용됩니다.
          </li>
          <li>
            응답 헤더 <code>{settings.response_header}</code>와 Cloudflare 호환{" "}
            <code>{settings.compat_header}</code>에 걸린 프로필·항목·정책이 JSON으로 실립니다. 값 자체는 싣지
            않습니다.
          </li>
          <li>
            요청 로그의 프롬프트·원문 본문·응답 텍스트에서도 찾은 값을 가립니다. 기록(FLAG) 정책도
            마찬가지입니다.
          </li>
        </ul>
        <Button variant="ghost" onClick={() => onNavigate("test")}>
          테스트 스캔으로 확인하기 <ArrowRight aria-hidden="true" />
        </Button>
      </SectionCard>

      <SectionCard title="검사와 보관" description="모든 정책에 공통으로 적용됩니다.">
        <div className="dlp-form-grid">
          <FormField
            label="증거 보관"
            description="탐지 이벤트에 남기는 내용입니다. 어느 쪽이든 원래 값은 저장하지 않습니다."
          >
            {(control) => (
              <Select
                {...control}
                value={draft.evidence}
                disabled={!canWrite}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    evidence: event.target.value === "hash_only" ? "hash_only" : "partial",
                  })
                }
              >
                <option value="partial">부분 미리보기 + 지문 (예: k•••@e•••.com (21자))</option>
                <option value="hash_only">지문만 (서버 비밀 키로 만든 HMAC 16자리)</option>
              </Select>
            )}
          </FormField>
          <FormField label="검사 상한" description="한 요청·응답에서 검사하는 텍스트의 최대 크기입니다.">
            {(control) => (
              <Select
                {...control}
                value={String(draft.max_scan_bytes)}
                disabled={!canWrite}
                onChange={(event) => onChange({ ...draft, max_scan_bytes: Number(event.target.value) })}
              >
                {scanOptions.map((bytes) => (
                  <option key={bytes} value={bytes}>
                    {formatBytes(bytes)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="상한을 넘으면" description="상한을 넘는 부분을 검사하지 못했을 때의 처리입니다.">
            {(control) => (
              <Select
                {...control}
                value={draft.oversize}
                disabled={!canWrite}
                onChange={(event) =>
                  onChange({ ...draft, oversize: event.target.value === "block" ? "block" : "allow" })
                }
              >
                <option value="allow">최신 내용(끝부분)만 검사하고 통과</option>
                <option value="block">차단 (검사하지 못한 내용은 내보내지 않음)</option>
              </Select>
            )}
          </FormField>
        </div>
        {draft.oversize === "block" ? (
          <InlineNotice tone="warning" title="큰 요청이 거부될 수 있습니다.">
            긴 문서나 대화 기록을 보내는 클라이언트는 검사 상한을 넘으면 400을 받습니다. 상한을 넉넉히
            잡으세요.
          </InlineNotice>
        ) : null}
      </SectionCard>
    </>
  );
}
