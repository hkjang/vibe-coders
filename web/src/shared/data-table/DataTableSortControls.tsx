import { ArrowDown, ArrowUp, ListOrdered, Plus, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Select } from "@/shared/components/ui/Select";
import type { DataTableSort } from "./DataTable";

interface Props {
  columns: readonly { id: string; label: string; initialDirection?: "asc" | "desc" }[];
  value: readonly DataTableSort[];
  onChange: (value: readonly DataTableSort[]) => void;
}
interface Draft extends DataTableSort {
  key: number;
}

/** Controlled ordering only. Never fetches, sorts or persists caller row data. */
export function DataTableSortControls({ columns, value, onChange }: Props): React.JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const inputs = useRef(new Map<number, HTMLSelectElement>());
  const nextKey = useRef(0);
  const focusAfterChange = useRef<number | "add" | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const currentSource = JSON.stringify([columns, value]);
  // Back/Forward or external preference changes invalidate an open draft.
  // Keep the trigger mounted so closing always restores keyboard focus.
  if (open && source !== currentSource) setOpen(false);
  const [draft, setDraft] = useState<readonly Draft[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const available = columns.filter((column) => !draft.some((item) => item.columnId === column.id));
  const valid =
    draft.length <= columns.length &&
    new Set(draft.map((item) => item.columnId)).size === draft.length &&
    draft.every((item) => columns.some((column) => column.id === item.columnId));
  useLayoutEffect(() => {
    const target = focusAfterChange.current;
    if (target !== undefined) {
      (target === "add" ? add.current : inputs.current.get(target))?.focus();
      focusAfterChange.current = undefined;
    }
  }, [draft]);
  const edit = (key: number, changes: Partial<DataTableSort>) =>
    setDraft((previous) => previous.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  const move = (index: number, direction: -1 | 1) => {
    const row = draft[index];
    const destination = index + direction;
    if (!row || destination < 0 || destination >= draft.length) return;
    const next = [...draft];
    next.splice(index, 1);
    next.splice(destination, 0, row);
    focusAfterChange.current = row.key;
    setDraft(next);
    setAnnouncement(
      `${columns.find((column) => column.id === row.columnId)?.label ?? "정렬"} 기준을 ${destination + 1}순위로 이동했습니다.`,
    );
  };
  return (
    <>
      <Button
        ref={trigger}
        size="small"
        variant="secondary"
        onClick={() => {
          setDraft(value.map((row) => ({ ...row, key: ++nextKey.current })));
          setAnnouncement("");
          setSource(currentSource);
          setOpen(true);
        }}
      >
        <ListOrdered aria-hidden="true" /> 다중 정렬
      </Button>
      <Dialog
        scrollBody
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        title="다중 정렬 설정"
        description="위쪽 기준부터 비교하고 값이 같으면 다음 기준을 적용합니다. 모든 기준이 같으면 기본 순서를 유지합니다."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              onClick={() => {
                onChange(draft.map(({ columnId, direction }) => ({ columnId, direction })));
                setOpen(false);
              }}
            >
              정렬 적용
            </Button>
          </>
        }
      >
        <div className="table-sort-criteria">
          {draft.length === 0 ? <p>선택한 기준이 없습니다. 적용하면 기본 순서로 돌아갑니다.</p> : null}
          {draft.map((row, index) => (
            <fieldset key={row.key} className="table-sort-criterion">
              <legend>{index + 1}순위</legend>
              <label>
                정렬 열
                <Select
                  ref={(element) => {
                    if (element) inputs.current.set(row.key, element);
                    else inputs.current.delete(row.key);
                  }}
                  aria-label={`${index + 1}순위 정렬 열`}
                  value={row.columnId}
                  options={columns
                    .filter(
                      (column) =>
                        column.id === row.columnId || !draft.some((item) => item.columnId === column.id),
                    )
                    .map((column) => ({ value: column.id, label: column.label }))}
                  onChange={(event) => {
                    const column = columns.find((item) => item.id === event.currentTarget.value);
                    if (column) edit(row.key, { columnId: column.id });
                  }}
                />
              </label>
              <label>
                방향
                <Select
                  aria-label={`${index + 1}순위 정렬 방향`}
                  value={row.direction}
                  options={[
                    { value: "asc", label: "오름차순" },
                    { value: "desc", label: "내림차순" },
                  ]}
                  onChange={(event) =>
                    edit(row.key, { direction: event.currentTarget.value === "desc" ? "desc" : "asc" })
                  }
                />
              </label>
              <div className="table-sort-actions">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={`${index + 1}순위 기준을 위로 이동`}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={index === draft.length - 1}
                  aria-label={`${index + 1}순위 기준을 아래로 이동`}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`${index + 1}순위 기준 삭제`}
                  onClick={() => {
                    focusAfterChange.current = draft[index + 1]?.key ?? draft[index - 1]?.key ?? "add";
                    setDraft(draft.filter((item) => item.key !== row.key));
                    setAnnouncement(`${index + 1}순위 기준을 삭제했습니다.`);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            ref={add}
            variant="secondary"
            disabled={available.length === 0}
            onClick={() => {
              const column = available[0];
              if (!column) return;
              const key = ++nextKey.current;
              focusAfterChange.current = key;
              setDraft([...draft, { key, columnId: column.id, direction: column.initialDirection ?? "asc" }]);
              setAnnouncement(`${draft.length + 1}순위 기준을 추가했습니다.`);
            }}
          >
            <Plus aria-hidden="true" /> 정렬 기준 추가
          </Button>
        </div>
        <p className="sr-only" role="status">
          {announcement}
        </p>
      </Dialog>
    </>
  );
}
