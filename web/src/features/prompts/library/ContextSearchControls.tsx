import { useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTableSortControls } from "@/shared/data-table/DataTableSortControls";
import type { SearchUpdates } from "@/shared/hooks/use-search-state";
import {
  contextSortColumns,
  contextSortValue,
  validContextSearch,
  type readContextSearch,
} from "./context-search";
import { contextMessages as text } from "./context-registry-messages";

export function ContextSearchControls({
  state,
  update,
}: {
  state: ReturnType<typeof readContextSearch>;
  update: (values: SearchUpdates) => void;
}) {
  const { credentialPrefixes } = useAuth();
  const [search, setSearch] = useState(state.q);
  const [source, setSource] = useState(state.q);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  if (source !== state.q) {
    setSource(state.q);
    setSearch(state.q);
    setError(undefined);
  }
  return (
    <>
      <form
        aria-label={text.searchLabel}
        onSubmit={(event) => {
          event.preventDefault();
          const value = search.trim();
          if (!validContextSearch(value, credentialPrefixes)) {
            setError(text.invalidSearch);
            input.current?.focus();
            return;
          }
          setError(undefined);
          update({ contexts_q: value || null, contexts_page: null });
        }}
      >
        <Toolbar
          label={text.searchLabel}
          end={
            <>
              <Button type="submit" variant="primary">
                {text.searchAction}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setSearch("");
                  setError(undefined);
                  update({
                    contexts_q: null,
                    contexts_sort: null,
                    contexts_state: null,
                    contexts_page: null,
                  });
                }}
              >
                {text.reset}
              </Button>
            </>
          }
        >
          <FormField label={text.searchLabel} description={text.searchHelp} error={error}>
            {(control) => (
              <Input
                {...control}
                ref={input}
                autoComplete="off"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
          </FormField>
        </Toolbar>
      </form>
      <Toolbar
        label="참고자료 정렬"
        end={
          <DataTableSortControls
            columns={contextSortColumns}
            value={state.sorts}
            maxCriteria={3}
            onChange={(sorts) =>
              update({ contexts_sort: contextSortValue(sorts) || null, contexts_page: null })
            }
          />
        }
      >
        <div>
          <p className="muted">{text.sortHelp}</p>
          <p className="muted">
            현재 정렬:{" "}
            {state.sorts.length
              ? state.sorts
                  .map(
                    (sort) =>
                      `${contextSortColumns.find((column) => column.id === sort.columnId)?.label ?? "등록 키"} ${sort.direction === "desc" ? "내림차순" : "오름차순"}`,
                  )
                  .join(" → ")
              : "등록 키 오름차순"}
          </p>
        </div>
      </Toolbar>
    </>
  );
}
