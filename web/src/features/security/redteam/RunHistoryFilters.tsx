import { runSortLabels } from "./run-history-labels";
import { useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { useSearchState } from "@/shared/hooks/use-search-state";
import {
  readRunQuery,
  runFilterKeys,
  runStatuses,
  runModes,
  runKinds,
  runSortFields,
  validRunRef,
  validRunWindow,
} from "@/shared/utils/redteam-run-query";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { statusLabel, executionModeLabel } from "./redteam-ui";

const refs = [
  ["runs_run_id", "실행 ID"],
  ["runs_campaign_id", "캠페인 ID"],
  ["runs_source_result_id", "원본 결과 ID"],
  ["runs_review_id", "검토 ID"],
] as const;

export function RunHistoryFilters() {
  const [params, update] = useSearchState();
  // Remount on committed URL changes; unfinished text stays out of history.
  return <FilterForm key={params.toString()} params={params} update={update} />;
}
function FilterForm({
  params,
  update,
}: {
  params: URLSearchParams;
  update: ReturnType<typeof useSearchState>[1];
}) {
  const { credentialPrefixes } = useAuth();
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(runFilterKeys.map((key) => [key, params.get(key) ?? ""])),
  );
  const [error, setError] = useState(false);
  const set = (key: string, value: string) => setDraft((previous) => ({ ...previous, [key]: value }));
  const sorts = draft.runs_sort ? draft.runs_sort.split(",") : ["created_at:desc"];
  const sortChange = (index: number, value: string) =>
    set(
      "runs_sort",
      sorts
        .map((old, at) => (at === index ? value : old))
        .filter(Boolean)
        .join(","),
    );
  return (
    <form
      className="rt-stack"
      aria-label="실행 이력 조회 조건"
      onSubmit={(event) => {
        event.preventDefault();
        const next = new URLSearchParams();
        for (const [key, value] of Object.entries(draft)) if (value) next.set(key, value);
        next.delete("runs_page");
        if (!readRunQuery(next, credentialPrefixes).valid) {
          setError(true);
          const invalidRef = refs.find(([key]) => !validRunRef(draft[key] ?? "", credentialPrefixes));
          const field = invalidRef?.[0] ?? "runs_from";
          event.currentTarget.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
          return;
        }
        update({ ...draft, runs_page: null }, { replace: false });
      }}
    >
      <div className="rt-history-filters">
        <label>
          실행 상태
          <Select
            value={draft.runs_status}
            onChange={(e) => set("runs_status", e.target.value)}
            options={[
              { value: "", label: "전체 상태" },
              ...runStatuses.map((value) => ({ value, label: statusLabel(value) })),
            ]}
          />
        </label>
        <label>
          실행 방식
          <Select
            value={draft.runs_mode}
            onChange={(e) => set("runs_mode", e.target.value)}
            options={[
              { value: "", label: "전체 방식" },
              ...runModes.map((value) => ({ value, label: executionModeLabel(value) })),
            ]}
          />
        </label>
        <label>
          이력 종류
          <Select
            value={draft.runs_kind}
            onChange={(e) => set("runs_kind", e.target.value)}
            options={[
              { value: "", label: "전체 이력" },
              ...runKinds.map((value) => ({
                value,
                label: value === "replay" ? "한 건 재실행" : "캠페인 실행",
              })),
            ]}
          />
        </label>
      </div>
      <details
        open={refs.some(([key]) => Boolean(params.get(key))) || Boolean(params.get("runs_from")) || undefined}
      >
        <summary>식별자·기간 상세 조건</summary>
        <p className="rt-muted" id="rt-history-ref-help">
          식별자는 정확히 일치하는 이력만 찾습니다. 비밀 키나 요청 원문을 입력하지 마세요.
        </p>
        <div className="rt-history-filters">
          {refs.map(([key, label]) => (
            <label key={key}>
              {label}
              <Input
                name={key}
                aria-invalid={error && !validRunRef(draft[key] ?? "", credentialPrefixes)}
                value={draft[key]}
                onChange={(e) => set(key, e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="rt-history-ref-help"
              />
            </label>
          ))}
          <label>
            시작 시각(포함)
            <Input
              name="runs_from"
              aria-invalid={error && !validRunWindow(draft.runs_from ?? "", draft.runs_to ?? "")}
              value={draft.runs_from}
              placeholder="2026-11-01T00:00:00+09:00"
              onChange={(e) => set("runs_from", e.target.value)}
              aria-describedby="rt-history-time-help"
            />
          </label>
          <label>
            종료 시각(제외)
            <Input
              name="runs_to"
              aria-invalid={error && !validRunWindow(draft.runs_from ?? "", draft.runs_to ?? "")}
              value={draft.runs_to}
              placeholder="2026-11-02T00:00:00+09:00"
              onChange={(e) => set("runs_to", e.target.value)}
              aria-describedby="rt-history-time-help"
            />
          </label>
        </div>
        <p id="rt-history-time-help" className="rt-muted">
          기간을 지정하려면 시작과 종료를 모두 입력하세요. 시간대가 포함된 ISO 8601 형식을 사용합니다.
        </p>
      </details>
      <div className="rt-history-sorts" aria-label="실행 이력 정렬 우선순위">
        {sorts.map((sort, i) => {
          const [field, direction] = sort.split(":");
          return (
            <div key={i} className="rt-history-sort">
              <label>
                {i + 1}순위
                <Select
                  value={field}
                  onChange={(e) => sortChange(i, `${e.target.value}:${direction}`)}
                  options={runSortFields.map((value) => ({
                    value,
                    label: runSortLabels[value],
                    disabled: sorts.some((other, index) => index !== i && other.startsWith(value + ":")),
                  }))}
                />
              </label>
              <label>
                방향
                <Select
                  aria-label={`${i + 1}순위 정렬 방향`}
                  value={direction}
                  onChange={(e) => sortChange(i, `${field}:${e.target.value}`)}
                  options={[
                    { value: "desc", label: "내림차순" },
                    { value: "asc", label: "오름차순" },
                  ]}
                />
              </label>
              {sorts.length > 1 ? (
                <Button type="button" aria-label={`${i + 1}순위 정렬 제거`} onClick={() => sortChange(i, "")}>
                  제거
                </Button>
              ) : null}
            </div>
          );
        })}
        {sorts.length < 3 ? (
          <Button
            type="button"
            onClick={() => {
              const field = runSortFields.find(
                (value) => !sorts.some((sort) => sort.startsWith(value + ":")),
              );
              if (field) set("runs_sort", [...sorts, `${field}:asc`].join(","));
            }}
          >
            정렬 추가
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert">
          조건을 확인하세요. 식별자는 256자 이하로 입력하고, 기간은 시작보다 종료가 늦어야 합니다. 민감한
          정보는 검색할 수 없습니다.
        </p>
      ) : null}
      <div className="table-actions">
        <Button type="submit" variant="primary">
          조건 적용
        </Button>
        <Button
          type="button"
          onClick={() =>
            update(Object.fromEntries(runFilterKeys.map((key) => [key, null])), { replace: false })
          }
        >
          조건 초기화
        </Button>
      </div>
    </form>
  );
}
