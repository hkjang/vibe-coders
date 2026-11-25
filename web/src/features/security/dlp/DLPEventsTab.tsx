import { FilterX, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import type {
  DLPAction,
  DLPCheck,
  DLPConfig,
  DLPEventCount,
  DLPEventsQuery,
  DLPSettings,
} from "@/shared/api/domains/security-dlp";
import { dlpActions, dlpChecks } from "@/shared/api/domains/security-dlp";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import {
  actionLabels,
  actionTones,
  checkLabels,
  confidenceLabels,
  entryName,
  profileName,
  profileOptions,
} from "./dlp-model";
import { useDLPEvents } from "./use-dlp";

const windows = [
  { hours: 1, label: "최근 1시간" },
  { hours: 24, label: "최근 24시간" },
  { hours: 168, label: "최근 7일" },
  { hours: 720, label: "최근 30일" },
] as const;

function oneOf<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return (values as readonly string[]).includes(value ?? "") ? (value as T) : undefined;
}

export function DLPEventsTab({
  settings,
  draft,
  refreshInterval,
}: {
  settings: DLPSettings;
  draft: DLPConfig;
  refreshInterval: number | false;
}): React.JSX.Element {
  const [params, update] = useSearchState();
  const hours = windows.find((w) => String(w.hours) === params.get("hours"))?.hours ?? 24;
  const action = oneOf<DLPAction>(dlpActions, params.get("action"));
  const check = oneOf<DLPCheck>(dlpChecks, params.get("check"));
  const options = profileOptions(settings.catalog, draft);
  const requestedProfile = params.get("profile") ?? "";
  const profile = requestedProfile && requestedProfile.length <= 80 ? requestedProfile : undefined;
  const query: DLPEventsQuery = {
    hours,
    limit: 200,
    ...(action ? { action } : {}),
    ...(check ? { check } : {}),
    ...(profile ? { profile } : {}),
  };
  const filtered = hours !== 24 || Boolean(action || check || profile);
  const events = useDLPEvents(query, refreshInterval);
  const data = events.data;
  const rows = data?.events ?? [];

  return (
    <>
      <SectionCard
        title="필터"
        description="탐지 이벤트는 요청 로그 보존 기간이 지나면 함께 지워집니다. 아래 요약의 막대를 누르면 그 값으로 걸러 봅니다."
        actions={
          filtered ? (
            <Button
              size="small"
              variant="ghost"
              onClick={() =>
                update({ hours: undefined, action: undefined, check: undefined, profile: undefined })
              }
            >
              <FilterX aria-hidden="true" /> 필터 초기화
            </Button>
          ) : undefined
        }
      >
        <div className="dlp-filter-grid">
          <FormField label="기간">
            {(control) => (
              <Select
                {...control}
                value={String(hours)}
                onChange={(event) =>
                  update({ hours: event.target.value === "24" ? undefined : event.target.value })
                }
              >
                {windows.map((w) => (
                  <option key={w.hours} value={w.hours}>
                    {w.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="동작">
            {(control) => (
              <Select
                {...control}
                value={action ?? ""}
                onChange={(event) => update({ action: event.target.value || undefined })}
              >
                <option value="">전체</option>
                {dlpActions.map((value) => (
                  <option key={value} value={value}>
                    {actionLabels[value]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="검사 대상">
            {(control) => (
              <Select
                {...control}
                value={check ?? ""}
                onChange={(event) => update({ check: event.target.value || undefined })}
              >
                <option value="">전체</option>
                {dlpChecks.map((value) => (
                  <option key={value} value={value}>
                    {checkLabels[value]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="프로필">
            {(control) => (
              <Select
                {...control}
                value={profile ?? ""}
                onChange={(event) => update({ profile: event.target.value || undefined })}
              >
                <option value="">전체</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      </SectionCard>

      {events.isError ? (
        <InlineNotice tone="danger" title="탐지 이벤트를 불러오지 못했습니다.">
          {safeAppErrorMessage(events.error, "잠시 후 다시 시도하세요.")}
        </InlineNotice>
      ) : null}

      {data && rows.length > 0 ? (
        <div className="dlp-summary-grid">
          <SummaryBars
            title="동작별"
            rows={data.summary.by_action}
            label={(key) => actionLabels[key as DLPAction] ?? key}
            tone={(key) => actionTones[key as DLPAction] ?? "info"}
            active={action}
            onPick={(key) => update({ action: key === action ? undefined : key })}
          />
          <SummaryBars
            title="프로필별"
            rows={data.summary.by_profile}
            label={(key) => profileName(key, settings.catalog, draft)}
            active={profile}
            onPick={(key) => update({ profile: key === profile ? undefined : key })}
          />
          <SummaryBars
            title="날짜별"
            rows={[...data.summary.by_day].sort((a, b) => a.key.localeCompare(b.key))}
            label={(key) => key.slice(5)}
          />
        </div>
      ) : null}

      <SectionCard
        title="탐지 이벤트"
        description={
          events.isPending
            ? "불러오는 중…"
            : `${formatNumber(rows.length)}건${rows.length >= 200 ? " (최근 200건)" : ""} · 값은 저장하지 않으며 부분 미리보기와 지문만 남습니다.`
        }
      >
        {!events.isPending && rows.length === 0 && !events.isError ? (
          <EmptyState
            icon={<ShieldCheck aria-hidden="true" />}
            title="이 조건의 탐지 이벤트가 없습니다."
            description={
              draft.enabled
                ? "정책에 걸린 요청이나 응답이 생기면 여기에 쌓입니다."
                : "DLP가 꺼져 있습니다. 개요 탭에서 켤 수 있습니다."
            }
          />
        ) : null}
        {rows.length > 0 ? (
          <div className="data-table-scroll" tabIndex={0} aria-label="DLP 탐지 이벤트 표 영역">
            <table className="data-table dlp-event-table">
              <caption className="sr-only">DLP 탐지 이벤트</caption>
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">대상·동작</th>
                  <th scope="col">프로필·항목</th>
                  <th scope="col">일치</th>
                  <th scope="col">증거</th>
                  <th scope="col">팀·키·모델</th>
                  <th scope="col">
                    <span className="sr-only">요청</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                    </td>
                    <td>
                      <span className="dlp-stack">
                        <span>{checkLabels[event.check]}</span>
                        <Badge tone={actionTones[event.action]}>{actionLabels[event.action]}</Badge>
                      </span>
                    </td>
                    <th scope="row">
                      <span className="dlp-entry-name">
                        {profileName(event.profile_id, settings.catalog, draft)}
                      </span>
                      <span className="dlp-muted dlp-entry-desc">
                        {event.entry_ids.map((id) => entryName(id, settings.catalog, draft)).join(", ")}
                      </span>
                      {event.policy_ids.length > 0 ? (
                        <span className="dlp-muted dlp-entry-desc">정책 {event.policy_ids.join(", ")}</span>
                      ) : null}
                    </th>
                    <td>
                      {formatNumber(event.match_count)}
                      {event.confidence ? (
                        <span className="dlp-muted dlp-entry-desc">
                          {confidenceLabels[event.confidence as keyof typeof confidenceLabels] ??
                            event.confidence}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {event.evidence.length > 0 ? (
                        <ul className="dlp-evidence">
                          {event.evidence.map((item, index) => (
                            <li key={index}>
                              <code>{item}</code>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="dlp-muted">
                          {event.hashes.length > 0 ? `지문 ${event.hashes.length}개` : "—"}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="dlp-stack">
                        <span>{event.team_id || <span className="dlp-muted">팀 없음</span>}</span>
                        <span className="dlp-muted">{event.api_key_id || "키 없음"}</span>
                        <span className="dlp-muted">{event.model || event.endpoint}</span>
                      </span>
                    </td>
                    <td>
                      <Link
                        className="button button-ghost button-small"
                        to={{
                          pathname: "/observability/io",
                          search: new URLSearchParams({ request_id: event.request_id }).toString(),
                        }}
                        aria-label={`요청 ${event.request_id} 입출력 보기`}
                      >
                        요청
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>
    </>
  );
}

function SummaryBars({
  title,
  rows,
  label,
  tone,
  active,
  onPick,
}: {
  title: string;
  rows: readonly DLPEventCount[];
  label: (key: string) => string;
  /** The value the list is filtered by, if any. */
  active?: string;
  /** Filters (or, for the active value, unfilters) by a row. */
  onPick?: (key: string) => void;
  tone?: (key: string) => "info" | "warning" | "danger";
}): React.JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.requests));
  return (
    <SectionCard title={title} description="요청 수 기준">
      <ul className="dlp-bars">
        {rows.slice(0, 8).map((row) => (
          <li key={row.key}>
            {onPick ? (
              <button
                type="button"
                className="dlp-bar-label dlp-link-button"
                aria-pressed={active === row.key}
                title={active === row.key ? "필터 해제" : "이 값으로 걸러 보기"}
                onClick={() => onPick(row.key)}
              >
                {label(row.key)}
              </button>
            ) : (
              <span className="dlp-bar-label">{label(row.key)}</span>
            )}
            <span className="dlp-bar-track" aria-hidden="true">
              <span
                className="dlp-bar-fill"
                data-tone={tone?.(row.key) ?? "info"}
                style={{ width: `${Math.max(4, (row.requests / max) * 100)}%` }}
              />
            </span>
            <span className="dlp-bar-value">{formatNumber(row.requests)}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
