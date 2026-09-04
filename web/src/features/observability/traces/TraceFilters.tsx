import { Filter, Search } from "lucide-react";
import { useRef, useState } from "react";

import { traceSubmittedFilterKeys } from "@/features/observability/traces/trace-utils";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import { Button } from "@/shared/components/ui/Button";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import { fitsUTF8Bytes } from "@/shared/utils/utf8";

const standardPageLimits = [25, 50, 100, 200] as const;
const exactHTTPStatusPattern = /^[1-5][0-9]{2}$/u;

interface TraceFiltersProps {
  query: AppRequestsQuery;
  credentialPrefixes: readonly string[];
  onApply: (search: URLSearchParams) => void;
  onReset: () => void;
}

export function TraceFilters({
  query,
  credentialPrefixes,
  onApply,
  onReset,
}: TraceFiltersProps): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const traceIdInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const [traceIdError, setTraceIdError] = useState("");
  const [modelError, setModelError] = useState("");
  const [filterError, setFilterError] = useState("");
  const selectedStatus = query.status ?? "";
  const selectedLimit = query.limit ?? 50;
  const customStatus = exactHTTPStatusPattern.test(selectedStatus) ? selectedStatus : undefined;
  const customLimit = standardPageLimits.includes(selectedLimit as (typeof standardPageLimits)[number])
    ? undefined
    : selectedLimit;

  const submitFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    for (const key of traceSubmittedFilterKeys) {
      const value = String(form.get(key) ?? "").trim();
      if (value !== "" && containsPotentialSecret(value, credentialPrefixes)) {
        setFilterError(secretSearchMessage);
        const control = event.currentTarget.elements.namedItem(key);
        if (control instanceof HTMLElement) control.focus();
        return;
      }
    }
    const temporalError = validateRequestTimeFilters({
      from: String(form.get("from") ?? ""),
      to: String(form.get("to") ?? ""),
      tz: String(form.get("tz") ?? ""),
    });
    if (temporalError) {
      setFilterError(temporalError.message);
      const control = event.currentTarget.elements.namedItem(temporalError.field);
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    setFilterError("");
    const traceID = String(form.get("trace_id") ?? "").trim();
    if (!fitsUTF8Bytes(traceID, 512)) {
      setTraceIdError("추적 ID는 UTF-8 기준 512바이트 이하여야 합니다.");
      traceIdInputRef.current?.focus();
      return;
    }
    setTraceIdError("");
    const model = String(form.get("model") ?? "").trim();
    if (!fitsUTF8Bytes(model, 256)) {
      setModelError("모델은 UTF-8 기준 256바이트 이하여야 합니다.");
      modelInputRef.current?.focus();
      return;
    }
    setModelError("");
    const next = new URLSearchParams();
    for (const key of traceSubmittedFilterKeys) {
      const value = String(form.get(key) ?? "").trim();
      if (value) next.set(key, value);
    }
    onApply(next);
  };

  const resetFilters = (): void => {
    formRef.current?.reset();
    setTraceIdError("");
    setModelError("");
    setFilterError("");
    onReset();
  };

  return (
    <form
      ref={formRef}
      className="trace-filters"
      aria-label="추적 조회 필터"
      onInput={() => setFilterError("")}
      onSubmit={submitFilters}
    >
      <div className="trace-filter-heading">
        <Filter aria-hidden="true" />
        <div>
          <strong>추적 조회</strong>
          <span>필터와 선택한 요청은 URL에 저장됩니다.</span>
        </div>
      </div>
      <div className="trace-filter-grid">
        <label className="trace-id-filter">
          추적 ID
          <input
            ref={traceIdInputRef}
            name="trace_id"
            aria-label="추적 ID"
            aria-describedby={`trace-id-help${traceIdError ? " trace-id-error" : ""}`}
            aria-invalid={traceIdError ? "true" : undefined}
            maxLength={512}
            placeholder="예: trace-01H..."
            defaultValue={query.trace_id ?? ""}
            onInput={(event) => {
              if (traceIdError && fitsUTF8Bytes(event.currentTarget.value.trim(), 512)) {
                setTraceIdError("");
              }
            }}
          />
          <small id="trace-id-help">비워 두면 최근 요청의 추적 흐름을 표시합니다.</small>
          {traceIdError ? (
            <small id="trace-id-error" className="field-error" role="alert">
              {traceIdError}
            </small>
          ) : null}
        </label>
        <label>
          상태
          <select name="status" defaultValue={selectedStatus}>
            <option value="">전체</option>
            <option value="success">성공 (2xx·3xx)</option>
            <option value="error">오류 (4xx·5xx)</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            {customStatus ? <option value={customStatus}>HTTP {customStatus}</option> : null}
          </select>
        </label>
        <label>
          모델
          <input
            ref={modelInputRef}
            name="model"
            aria-describedby={modelError ? "trace-model-error" : undefined}
            aria-invalid={modelError ? "true" : undefined}
            maxLength={256}
            defaultValue={query.model ?? ""}
            onInput={(event) => {
              if (modelError && fitsUTF8Bytes(event.currentTarget.value.trim(), 256)) {
                setModelError("");
              }
            }}
          />
          {modelError ? (
            <small id="trace-model-error" className="field-error" role="alert">
              {modelError}
            </small>
          ) : null}
        </label>
        <label>
          시작 시각
          <input
            name="from"
            type="text"
            maxLength={64}
            placeholder="예: 2026-09-04T09:00 또는 RFC3339"
            defaultValue={query.from ?? ""}
          />
        </label>
        <label>
          종료 시각
          <input
            name="to"
            type="text"
            maxLength={64}
            placeholder="예: 2026-09-04T18:00 또는 RFC3339"
            defaultValue={query.to ?? ""}
          />
        </label>
        <label>
          표시 건수
          <select name="limit" defaultValue={String(selectedLimit)}>
            {customLimit ? <option value={customLimit}>{customLimit}건</option> : null}
            <option value="25">25건</option>
            <option value="50">50건</option>
            <option value="100">100건</option>
            <option value="200">200건</option>
          </select>
        </label>
        <label>
          시간대
          <input name="tz" maxLength={64} defaultValue={query.tz ?? "Asia/Seoul"} />
        </label>
      </div>
      {filterError ? (
        <p className="field-error" role="alert">
          {filterError}
        </p>
      ) : null}
      <div className="trace-filter-actions">
        <Button type="submit" variant="primary">
          <Search aria-hidden="true" /> 흐름 조회
        </Button>
        <Button type="button" variant="ghost" onClick={resetFilters}>
          필터 초기화
        </Button>
      </div>
    </form>
  );
}
