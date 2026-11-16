import { useRef, useState, type FormEvent } from "react";
import { Filter, Search } from "lucide-react";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import { Button } from "@/shared/components/ui/Button";
import { isValidIPAddress } from "@/shared/utils/ip-address";
import { FilterSuggestions } from "./FilterSuggestions";
import { RequestTimePresets } from "./RequestTimePresets";
import { requestPresetRange } from "./request-time-presets";
import { advancedRequestFilterKeys } from "./request-filter-summary";
import {
  defaultLimit,
  defaultTimeZone,
  exactHTTPStatusPattern,
  standardPageLimits,
} from "./request-page-query";

function RequestIPFilter({ initialValue }: { initialValue: string }): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const error = value.trim() !== "" && !isValidIPAddress(value) ? "올바른 IP 주소를 입력하세요." : "";

  return (
    <label>
      클라이언트 IP
      <input
        name="ip"
        aria-label="클라이언트 IP"
        value={value}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "request-ip-error" : undefined}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      {error ? (
        <span id="request-ip-error" className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function RequestFilters({
  query,
  searchParams,
  filterError,
  onSubmit,
  onReset,
  onInput,
}: {
  query: AppRequestsQuery;
  searchParams: URLSearchParams;
  filterError?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReset: () => void;
  onInput: () => void;
}): React.JSX.Element {
  const selectedStatus = query.status ?? "";
  const selectedTimeZone = query.tz ?? defaultTimeZone;
  const selectedLimit = query.limit ?? defaultLimit;
  const customStatus = exactHTTPStatusPattern.test(selectedStatus) ? selectedStatus : undefined;
  const customLimit = standardPageLimits.includes(selectedLimit as (typeof standardPageLimits)[number])
    ? undefined
    : selectedLimit;
  const deepLinkIP = searchParams.get("ip")?.trim() ?? "";
  const deepLinkIPError = deepLinkIP !== "" && !isValidIPAddress(deepLinkIP);
  const advancedCount = advancedRequestFilterKeys.filter((key) => Boolean(query[key])).length;
  const modelInput = useRef<HTMLInputElement>(null);
  const languageInput = useRef<HTMLInputElement>(null);
  const [timeRange, setTimeRange] = useState({ from: query.from ?? "", to: query.to ?? "" });
  const [timeNotice, setTimeNotice] = useState<string>();
  // Fetch suggestions only after this field is focused.
  const [suggestFields, setSuggestFields] = useState<Record<string, boolean>>({});
  const enableSuggest = (field: string) => (): void =>
    setSuggestFields((current) => (current[field] ? current : { ...current, [field]: true }));
  return (
    <form className="request-filters" onInput={onInput} onSubmit={onSubmit}>
      <div className="request-filter-heading">
        <Filter aria-hidden="true" />
        <strong>조회 필터</strong>
        <span>필터와 페이지 위치는 URL에 저장됩니다.</span>
      </div>
      <RequestTimePresets
        notice={timeNotice}
        onSelect={(preset) => {
          setTimeRange(requestPresetRange(preset));
          setTimeNotice(`${preset.label}을 입력했습니다. 조회를 누르면 적용합니다.`);
          onInput();
        }}
      />
      <div className="request-filter-grid">
        <label>
          시작 시각
          <input
            name="from"
            type="text"
            maxLength={64}
            aria-describedby="request-time-preset-help"
            placeholder="예: 2026-09-04T09:00 또는 RFC3339"
            value={timeRange.from}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setTimeRange((current) => ({ ...current, from: value }));
              setTimeNotice(undefined);
            }}
          />
        </label>
        <label>
          종료 시각
          <input
            name="to"
            type="text"
            maxLength={64}
            aria-describedby="request-time-preset-help"
            placeholder="예: 2026-09-04T18:00 또는 RFC3339"
            value={timeRange.to}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setTimeRange((current) => ({ ...current, to: value }));
              setTimeNotice(undefined);
            }}
          />
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
        <div className="request-filter-field">
          <label>
            모델
            <input
              name="model"
              ref={modelInput}
              maxLength={256}
              list="request-filter-models"
              defaultValue={searchParams.get("model") ?? ""}
              onFocus={enableSuggest("model")}
            />
          </label>
          {/* Outside the label: a datalist inside one becomes part of the field's name. */}
          <FilterSuggestions
            enabled={suggestFields.model === true}
            field="model"
            id="request-filter-models"
            inputRef={modelInput}
          />
        </div>
        <label>
          요청 ID
          <input name="request_id" maxLength={512} defaultValue={searchParams.get("request_id") ?? ""} />
        </label>
        <label>
          공급자 참조
          <input name="provider_ref" maxLength={47} defaultValue={searchParams.get("provider_ref") ?? ""} />
        </label>
        <details className="request-advanced" open={deepLinkIPError || undefined}>
          <summary>
            <span>고급 필터</span>
            {advancedCount > 0 && <span className="request-advanced-count">{advancedCount}개 적용</span>}
          </summary>
          <div className="request-filter-grid">
            <label>
              추적 ID
              <input name="trace_id" maxLength={512} defaultValue={searchParams.get("trace_id") ?? ""} />
            </label>
            <label>
              세션 ID
              <input name="session_id" maxLength={512} defaultValue={searchParams.get("session_id") ?? ""} />
            </label>
            <label>
              API 키 ID
              <input name="api_key_id" maxLength={512} defaultValue={searchParams.get("api_key_id") ?? ""} />
            </label>
            <RequestIPFilter initialValue={deepLinkIP} />
            <div className="request-filter-field">
              <label>
                언어
                <input
                  name="language"
                  ref={languageInput}
                  maxLength={64}
                  list="request-filter-languages"
                  defaultValue={searchParams.get("language") ?? ""}
                  onFocus={enableSuggest("language")}
                />
              </label>
              <FilterSuggestions
                enabled={suggestFields.language === true}
                field="language"
                id="request-filter-languages"
                inputRef={languageInput}
              />
            </div>
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
              <input name="tz" defaultValue={selectedTimeZone} />
            </label>
          </div>
        </details>
      </div>
      {filterError ? (
        <p className="field-error" role="alert">
          {filterError}
        </p>
      ) : null}
      <div className="request-filter-actions">
        <Button type="submit" variant="primary">
          <Search aria-hidden="true" /> 조회
        </Button>
        <Button type="button" variant="ghost" onClick={onReset}>
          필터 초기화
        </Button>
      </div>
    </form>
  );
}
