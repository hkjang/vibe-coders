import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import type { ModelProviderOption, ModelStatusFilter } from "@/features/gateway/models/model-catalog";
import { modelStatusPresentation } from "@/features/gateway/models/model-presentation";
import type { HealthRange } from "@/features/health/health-utils";
import { TimeRangePicker } from "@/features/health/health-ui";
import { Button } from "@/shared/components/ui/Button";
import { rejectedSensitiveQuery } from "@/shared/security/app-route-query";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";

const statusLabels: Record<ModelStatusFilter, string> = {
  all: "전체 상태",
  available: modelStatusPresentation.available.label,
  virtual: modelStatusPresentation.virtual.label,
  deprecated: modelStatusPresentation.deprecated.label,
  retired: modelStatusPresentation.retired.label,
  stale: modelStatusPresentation.stale.label,
  shadowed: modelStatusPresentation.shadowed.label,
};

interface ModelToolbarProps {
  onUpdate: (updates: Readonly<Record<string, string | undefined>>) => void;
  provider: string;
  providers: readonly ModelProviderOption[];
  query: string;
  range: HealthRange;
  status: ModelStatusFilter;
  unsafeStoredQuery: boolean;
}

export function ModelToolbar({
  onUpdate,
  provider,
  providers,
  query,
  range,
  status,
  unsafeStoredQuery,
}: ModelToolbarProps): React.JSX.Element {
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchError, setSearchError] = useState<string | undefined>(() =>
    unsafeStoredQuery ? secretSearchMessage : undefined,
  );
  const rejectedQuery = rejectedSensitiveQuery(location.state, "q");
  const visibleError = searchError ?? (unsafeStoredQuery || rejectedQuery ? secretSearchMessage : undefined);

  useEffect(() => {
    if (visibleError) inputRef.current?.focus();
  }, [visibleError]);

  return (
    <div className="model-toolbar">
      <form
        className="model-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const submittedQuery = new FormData(event.currentTarget).get("q");
          const nextQuery = typeof submittedQuery === "string" ? submittedQuery.trim() : "";
          if (containsPotentialSecret(nextQuery)) {
            setSearchError(secretSearchMessage);
            inputRef.current?.focus();
            return;
          }
          setSearchError(undefined);
          onUpdate({ q: nextQuery || undefined, page: undefined });
        }}
      >
        <label htmlFor="model-search">모델 검색</label>
        <div>
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            key={query}
            id="model-search"
            name="q"
            defaultValue={query}
            placeholder="모델 ID, 공급자, 소유자, 사용 지침"
            aria-describedby={visibleError ? "model-search-error" : undefined}
            aria-invalid={visibleError ? "true" : undefined}
            onChange={() => {
              if (searchError) setSearchError(undefined);
            }}
          />
          <Button size="small" type="submit">
            검색
          </Button>
        </div>
        {visibleError ? (
          <p id="model-search-error" className="provider-search-error" role="alert">
            {visibleError}
          </p>
        ) : null}
      </form>
      <label className="model-filter">
        <span>공급자</span>
        <select
          value={provider}
          onChange={(event) =>
            onUpdate({
              provider: event.target.value || undefined,
              model: undefined,
              model_provider: undefined,
              page: undefined,
              source: undefined,
            })
          }
        >
          <option value="">전체 공급자</option>
          {providers.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="model-filter">
        <span>상태</span>
        <select
          value={status}
          onChange={(event) =>
            onUpdate({
              status: event.target.value === "all" ? undefined : event.target.value,
              model: undefined,
              model_provider: undefined,
              page: undefined,
              source: undefined,
            })
          }
        >
          {Object.entries(statusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="model-range">
        <span>품질 기간</span>
        <TimeRangePicker
          value={range}
          onChange={(nextRange) => onUpdate({ range: nextRange, page: undefined })}
        />
      </div>
      <Button
        size="small"
        variant="ghost"
        onClick={() =>
          onUpdate({
            model: undefined,
            model_provider: undefined,
            page: undefined,
            provider: undefined,
            q: undefined,
            status: undefined,
            source: undefined,
          })
        }
      >
        필터 초기화
      </Button>
    </div>
  );
}
