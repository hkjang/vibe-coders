import { useId, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { migrationStatusLabels } from "@/config/ui-labels";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";
import {
  consoleFilterReset,
  consoleSearchMessages as text,
  validConsoleSearch,
  type readConsoleFilters,
} from "./console-feature-search";

export function ConsoleFeatureFilters({
  filter,
  update,
}: {
  filter: ReturnType<typeof readConsoleFilters>;
  update: (values: SearchUpdates) => void;
}) {
  const { credentialPrefixes } = useAuth();
  const [search, setSearch] = useState(filter.query);
  const [source, setSource] = useState(filter.query);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const helpId = useId();
  if (source !== filter.query) {
    setSource(filter.query);
    setSearch(filter.query);
    setError(undefined);
  }
  return (
    <form
      aria-label={text.search}
      onSubmit={(event) => {
        event.preventDefault();
        const value = search.trim();
        if (!validConsoleSearch(value, credentialPrefixes)) {
          setError(text.invalid);
          input.current?.focus();
          return;
        }
        setError(undefined);
        update({ console_q: value || null });
      }}
    >
      <Toolbar
        label="전환 기능 조회 조건"
        end={
          <>
            <Button type="submit">검색</Button>
            <Button
              type="button"
              onClick={() => {
                setSearch("");
                setError(undefined);
                update(consoleFilterReset);
              }}
            >
              {text.reset}
            </Button>
          </>
        }
      >
        <FormField label={text.search} error={error}>
          {(control) => (
            <Input
              {...control}
              aria-describedby={[control["aria-describedby"], helpId].filter(Boolean).join(" ")}
              ref={input}
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </FormField>
        <FormField label={text.status}>
          {(control) => (
            <Select
              {...control}
              value={filter.status}
              onChange={(event) => update({ console_status: event.target.value || null })}
            >
              <option value="">전체 상태</option>
              {Object.entries(migrationStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              <option value="unknown">확인 불가</option>
            </Select>
          )}
        </FormField>
        <FormField label={text.readonly}>
          {(control) => (
            <Select
              {...control}
              value={filter.readonly}
              onChange={(event) => update({ console_readonly: event.target.value || null })}
            >
              <option value="">전체 설정</option>
              <option value="true">쓰기 차단</option>
              <option value="false">쓰기 허용</option>
              <option value="unknown">확인 불가</option>
            </Select>
          )}
        </FormField>
      </Toolbar>
      <p id={helpId} className="muted">
        {text.help}
      </p>
    </form>
  );
}
