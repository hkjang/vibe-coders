import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { workActionIds, workMetricIds, type WorkScope } from "@/shared/api/domains/insights-common";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select, type SelectOption } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";

import { categoryPath, levelNames } from "./drill-path";
import { useCategories, useModels, useTeams } from "./use-usage-queries";
import {
  customRangeUpdates,
  isDefaultFilters,
  maxPeriodDays,
  optionsQuery,
  periodPresets,
  periodRange,
  presetUpdates,
  resetUpdates,
  type UsageFilters,
} from "./usage-filters";
import { actionLabels, knownClients } from "./usage-labels";
import { metricLabels } from "./usage-metrics";

interface UsageFilterBarProps {
  filters: UsageFilters;
  today: string;
  scope: WorkScope | undefined;
  /** Whether option lists may be loaded (false while the analysis is unavailable). */
  enabled: boolean;
  update: (updates: SearchUpdates, options?: { replace?: boolean }) => void;
}

/** Keeps the current value selectable even when the option list does not (yet) contain it. */
function withCurrent(options: readonly SelectOption[], current: string): SelectOption[] {
  if (!current || options.some((option) => option.value === current)) return [...options];
  return [...options, { value: current, label: current }];
}

const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))].sort();

/**
 * The filters every tab shares. Each control writes straight to the URL, so a
 * reload, a shared link and the Back button all restore the same view.
 */
export function UsageFilterBar({
  filters,
  today,
  scope,
  enabled,
  update,
}: UsageFilterBarProps): React.JSX.Element {
  const range = periodRange(filters.period, today);
  const options = optionsQuery(range);
  const [top = "", middle = "", leaf = ""] = categoryPath(filters.category);
  const teams = useTeams(options, enabled);
  const models = useModels(options, enabled);
  const topCategories = useCategories(options, "", enabled);
  const middleCategories = useCategories(options, top, enabled && top !== "");
  const leafCategories = useCategories(options, middle, enabled && middle !== "");

  const set = (updates: SearchUpdates): void => update({ ...updates, page: undefined });
  const categoryOptions = (query: typeof topCategories, current: string): SelectOption[] =>
    withCurrent(
      (query.data?.rows ?? []).map((row) => ({
        value: row.category.id,
        label: row.category.name || row.category.id,
      })),
      current,
    );
  const middleOptions = top ? categoryOptions(middleCategories, middle) : [];
  const leafOptions = middle ? categoryOptions(leafCategories, leaf) : [];
  const teamScoped = scope?.team_scoped === true;

  return (
    <section className="wi-filter-bar" aria-label="업무 활용 분석 조회 조건">
      <div className="wi-filter-row">
        <div className="wi-filter">
          <span id="wi-period-label">기간</span>
          <div className="wi-period">
            <div className="range-picker" role="group" aria-labelledby="wi-period-label">
              {periodPresets.map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={filters.period.kind === "preset" && filters.period.days === days}
                  onClick={() => update(presetUpdates(days))}
                >
                  {days}일
                </button>
              ))}
            </div>
            <CustomRange
              key={`${range.from}|${range.to}|${filters.period.kind}`}
              from={range.from}
              to={range.to}
              active={filters.period.kind === "custom"}
              today={today}
              onApply={(from, to) => {
                const updates = customRangeUpdates(from, to);
                if (updates) update(updates);
                return updates !== undefined;
              }}
            />
          </div>
        </div>
        <div className="wi-filter wi-filter-switch">
          <span aria-hidden="true">비교</span>
          <Switch
            checked={filters.compare}
            onCheckedChange={(checked) => update({ compare: checked ? undefined : "none" })}
            label="직전 기간 비교"
          />
        </div>
        <label className="wi-filter" htmlFor="wi-metric">
          <span>집계 기준</span>
          <Select
            id="wi-metric"
            value={filters.metric}
            onChange={(event) =>
              update({ metric: event.target.value === "sessions" ? undefined : event.target.value })
            }
            options={workMetricIds.map((id) => ({ value: id, label: metricLabels[id] }))}
          />
        </label>
      </div>
      <div className="wi-filter-row">
        <label className="wi-filter" htmlFor="wi-team">
          <span>팀</span>
          <Select
            id="wi-team"
            value={filters.team}
            disabled={teamScoped}
            title={teamScoped ? "팀 범위 관리자는 자기 팀의 데이터만 볼 수 있습니다." : undefined}
            onChange={(event) => set({ team: event.target.value })}
            placeholder={teamScoped ? "내 팀" : "전체 팀"}
            options={withCurrent(
              unique((teams.data?.rows ?? []).map((row) => row.team)).map((team) => ({
                value: team,
                label: team,
              })),
              filters.team,
            )}
          />
        </label>
        <fieldset className="wi-filter wi-filter-category">
          <legend>업무 분류</legend>
          <div className="wi-filter-chain">
            <Select
              aria-label={`업무 분류 ${levelNames[0]}`}
              value={top}
              onChange={(event) => set({ category: event.target.value })}
              placeholder={`전체 ${levelNames[0]}`}
              options={categoryOptions(topCategories, top)}
            />
            {top && (middleOptions.length > 0 || middleCategories.isPending) ? (
              <Select
                aria-label={`업무 분류 ${levelNames[1]}`}
                value={middle}
                onChange={(event) => set({ category: event.target.value || top })}
                placeholder={`전체 ${levelNames[1]}`}
                options={middleOptions}
              />
            ) : null}
            {middle && (leafOptions.length > 0 || leafCategories.isPending) ? (
              <Select
                aria-label={`업무 분류 ${levelNames[2]}`}
                value={leaf}
                onChange={(event) => set({ category: event.target.value || middle })}
                placeholder={`전체 ${levelNames[2]}`}
                options={leafOptions}
              />
            ) : null}
          </div>
        </fieldset>
        <label className="wi-filter" htmlFor="wi-action">
          <span>작업 유형</span>
          <Select
            id="wi-action"
            value={filters.action}
            onChange={(event) => set({ action: event.target.value })}
            placeholder="전체 작업"
            options={workActionIds.map((id) => ({ value: id, label: actionLabels[id] }))}
          />
        </label>
        <label className="wi-filter" htmlFor="wi-model">
          <span>모델</span>
          <Select
            id="wi-model"
            value={filters.model}
            onChange={(event) => set({ model: event.target.value })}
            placeholder="전체 모델"
            options={withCurrent(
              unique((models.data?.rows ?? []).map((row) => row.model)).map((model) => ({
                value: model,
                label: model,
              })),
              filters.model,
            )}
          />
        </label>
        <label className="wi-filter" htmlFor="wi-client">
          <span>클라이언트</span>
          <Select
            id="wi-client"
            value={filters.client}
            onChange={(event) => set({ client: event.target.value })}
            placeholder="전체 클라이언트"
            options={withCurrent(
              knownClients.map((client) => ({ value: client, label: client })),
              filters.client,
            )}
          />
        </label>
        <Button
          className="wi-filter-reset"
          variant="secondary"
          disabled={isDefaultFilters(filters)}
          onClick={() => update(resetUpdates())}
        >
          <RotateCcw aria-hidden="true" /> 필터 초기화
        </Button>
      </div>
      {filters.invalidPeriod ? (
        <p className="wi-filter-error" role="alert">
          주소의 기간을 사용할 수 없어 최근 {filters.period.kind === "preset" ? filters.period.days : 30}일을
          표시합니다. 시작일은 종료일보다 늦을 수 없고 기간은 {maxPeriodDays}일을 넘을 수 없습니다.
        </p>
      ) : null}
    </section>
  );
}

interface CustomRangeProps {
  from: string;
  to: string;
  active: boolean;
  today: string;
  /** Returns false when the range was rejected. */
  onApply: (from: string, to: string) => boolean;
}

/** "직접 입력": two dates applied together, so a half-typed range never queries. */
function CustomRange({ from, to, active, today, onApply }: CustomRangeProps): React.JSX.Element {
  const [open, setOpen] = useState(active);
  const [draft, setDraft] = useState({ from, to });
  const [rejected, setRejected] = useState(false);
  return (
    <>
      <Button
        size="small"
        variant={active ? "primary" : "secondary"}
        aria-expanded={open}
        aria-pressed={active}
        onClick={() => setOpen((value) => !value)}
      >
        직접 입력
      </Button>
      {open ? (
        <form
          className="wi-custom-range"
          onSubmit={(event) => {
            event.preventDefault();
            setRejected(!onApply(draft.from, draft.to));
          }}
        >
          <label>
            <span>시작일</span>
            <Input
              type="date"
              value={draft.from}
              max={today}
              onChange={(event) => setDraft((value) => ({ ...value, from: event.target.value }))}
            />
          </label>
          <label>
            <span>종료일</span>
            <Input
              type="date"
              value={draft.to}
              max={today}
              onChange={(event) => setDraft((value) => ({ ...value, to: event.target.value }))}
            />
          </label>
          <Button type="submit" size="small" variant="primary">
            적용
          </Button>
          {rejected ? (
            <p className="wi-filter-error" role="alert">
              시작일이 종료일보다 늦거나 기간이 {maxPeriodDays}일을 넘습니다.
            </p>
          ) : null}
        </form>
      ) : null}
    </>
  );
}
