import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import type { RunCatalog, RunInput, RunValues } from "./run-model";
import { canLinkRegressionID } from "../regression-model";

export function RunScope({
  catalog,
  form,
  prefixes,
}: {
  catalog: RunCatalog;
  form: UseFormReturn<RunInput, unknown, RunValues>;
  prefixes: readonly string[];
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const ids = useWatch({ control: form.control, name: "ids" });
  const { ref: selectionRef } = form.register("ids");
  const rows = catalog.rows.filter(
    (row) =>
      canLinkRegressionID(row.id, prefixes) &&
      row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const current = Math.min(page, pages - 1);
  const error = form.formState.errors.ids?.message;
  if (catalog.kind === "workflow")
    return (
      <FormField label="실행할 워크플로" required error={error}>
        {(control) => (
          <Select
            {...control}
            name="ids"
            ref={selectionRef}
            value={ids[0] ?? ""}
            onChange={(event) =>
              form.setValue("ids", event.target.value ? [event.target.value] : [], {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          >
            <option value="">워크플로 선택</option>
            {catalog.rows
              .filter((row) => canLinkRegressionID(row.id, prefixes))
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name || "이름 없음"} · {row.steps?.length ?? 0}단계
                </option>
              ))}
          </Select>
        )}
      </FormField>
    );
  return (
    <fieldset className="regression-run-scope">
      {/* The persistent group label owns error focus. Options can unmount without
          becoming the form field's source of truth or rebuilding its value. */}
      <legend ref={selectionRef} tabIndex={-1}>
        실행할 기준 프롬프트
      </legend>
      <FormField label="정의 이름 검색">
        {(control) => (
          <Input
            {...control}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        )}
      </FormField>
      <div className="regression-run-selection">
        <span role="status">
          {ids.length}개 선택 · 검색 결과 {rows.length}개
        </span>
        <Button size="small" onClick={() => form.setValue("ids", [], { shouldDirty: true })}>
          선택 해제
        </Button>
      </div>
      {rows.slice(current * 20, (current + 1) * 20).map((row) => (
        <Checkbox
          key={row.id}
          name="ids"
          value={row.id}
          label={row.name || "이름 없음"}
          checked={ids.includes(row.id)}
          onChange={(event) => {
            // Mounted checkbox refs are only a page, not the complete selection.
            const selected = form.getValues("ids");
            form.setValue(
              "ids",
              event.target.checked
                ? [...new Set([...selected, row.id])]
                : selected.filter((id) => id !== row.id),
              { shouldDirty: true, shouldValidate: true },
            );
          }}
        />
      ))}
      {!rows.length ? (
        <p className="muted">선택할 정의가 없습니다. 검색 조건이나 등록된 세트를 확인하세요.</p>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {pages > 1 ? (
        <div className="regression-run-selection">
          <Button size="small" disabled={current === 0} onClick={() => setPage(current - 1)}>
            이전 정의
          </Button>
          <span>
            {current + 1} / {pages}
          </span>
          <Button size="small" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>
            다음 정의
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
