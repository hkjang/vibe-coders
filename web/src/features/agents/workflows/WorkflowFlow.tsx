import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { WorkflowStep } from "@/shared/api/domains/agents.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { flowDisplay, flowLimit, flowPageSize, flowText, flowType } from "./workflow-flow";
import "./workflow-flow.css";

function MetadataList({
  title,
  values,
  prefixes,
}: {
  title: string;
  values: readonly string[] | null | undefined;
  prefixes: readonly string[];
}) {
  const [visible, setVisible] = useState(25);
  const summary = useRef<HTMLElement>(null);
  if (!values?.length) return <p>{title}: 등록 안 함</p>;
  return (
    <details className="workflow-flow-metadata">
      <summary ref={summary}>
        {title} ({values.length}개)
      </summary>
      <ul>
        {values.slice(0, visible).map((value, index) => (
          <li key={index}>{flowDisplay(value, prefixes)}</li>
        ))}
      </ul>
      {values.length > visible ? (
        <Button
          size="small"
          onClick={() => {
            setVisible(visible + 25);
            if (visible + 25 >= values.length) summary.current?.focus();
          }}
        >
          25개 더 보기
        </Button>
      ) : null}
    </details>
  );
}

/** A view over the stored ordered definition; it never executes or edits steps. */
export function WorkflowFlow({
  steps,
  prefixes,
}: {
  steps: readonly WorkflowStep[];
  prefixes: readonly string[];
}) {
  const [selection, setSelection] = useState({ steps, index: 0 });
  if (selection.steps !== steps) setSelection({ steps, index: 0 });
  const selected = selection.steps === steps ? selection.index : 0;
  const page = Math.floor(selected / flowPageSize);
  const start = page * flowPageSize;
  const shown = steps.slice(start, start + flowPageSize);
  const current = steps[selected];
  const id = useId();
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const focusAfterPage = useRef<"previous" | "next" | undefined>(undefined);
  useLayoutEffect(() => {
    const target = focusAfterPage.current;
    focusAfterPage.current = undefined;
    if (target === "previous") previous.current?.focus();
    if (target === "next") next.current?.focus();
  }, [selected]);
  const choose = (index: number) => setSelection({ steps, index });
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = start + shown.length - 1;
    const target =
      event.key === "Home"
        ? start
        : event.key === "End"
          ? last
          : event.key === "ArrowUp"
            ? Math.max(start, index - 1)
            : event.key === "ArrowDown"
              ? Math.min(last, index + 1)
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    choose(target);
    buttons.current.get(target)?.focus();
  };
  if (!current) return <p>단계가 없습니다.</p>;
  return (
    <div className="workflow-flow">
      <p>{flowText.description}</p>
      <p className="workflow-flow-muted">{flowText.boundary}</p>
      <div className="workflow-flow-columns">
        <div className="workflow-flow-navigation">
          <p role="status">
            {start + 1}–{start + shown.length} / 전체 {steps.length}단계
          </p>
          <div
            role="tablist"
            aria-label="단계 흐름"
            aria-orientation="vertical"
            className="workflow-flow-nodes"
          >
            {shown.map((step, offset) => {
              const index = start + offset;
              const active = index === selected;
              return (
                <button
                  key={index}
                  type="button"
                  role="tab"
                  aria-label={`${index + 1}. ${flowDisplay(step.name || flowType(step), prefixes)} ${flowType(step)}`}
                  id={`${id}-step-${index}`}
                  aria-selected={active}
                  aria-controls={`${id}-detail-${index}`}
                  tabIndex={active ? 0 : -1}
                  className="workflow-flow-node"
                  ref={(element) => {
                    if (element) buttons.current.set(index, element);
                    else buttons.current.delete(index);
                  }}
                  onClick={() => choose(index)}
                  onKeyDown={(event) => navigate(event, index)}
                >
                  <span className="workflow-flow-index" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="workflow-flow-node-copy">
                    <strong>{flowDisplay(step.name || flowType(step), prefixes)}</strong>
                    <span>{flowType(step)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {steps.length > flowPageSize ? (
            <nav aria-label="단계 흐름 페이지" className="workflow-flow-pagination">
              <Button
                ref={previous}
                disabled={start === 0}
                onClick={() => {
                  choose(Math.max(0, start - flowPageSize));
                  if (start === flowPageSize) focusAfterPage.current = "next";
                }}
              >
                이전 25단계
              </Button>
              <Button
                ref={next}
                disabled={start + shown.length >= steps.length}
                onClick={() => {
                  choose(start + flowPageSize);
                  if (start + flowPageSize * 2 >= steps.length) focusAfterPage.current = "previous";
                }}
              >
                다음 25단계
              </Button>
            </nav>
          ) : null}
        </div>
        <section
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`${id}-step-${selected}`}
          id={`${id}-detail-${selected}`}
          className="workflow-flow-inspector"
        >
          <div aria-live="polite" aria-atomic="true">
            <h4>
              {selected + 1}. {flowDisplay(current.name || flowType(current), prefixes)}
            </h4>
            <Badge>{flowType(current)}</Badge>
          </div>
          <KeyValueList
            columns={1}
            items={[
              { label: "참조", value: flowDisplay(current.ref, prefixes), mono: true },
              { label: "등록 시간 한도", value: flowLimit(current.timeout_ms, "ms") },
              { label: "등록 토큰 한도", value: flowLimit(current.max_tokens, "토큰") },
              { label: "등록 비용 한도", value: flowLimit(current.max_cost_krw, "원") },
              { label: "메모", value: flowDisplay(current.note, prefixes) },
            ]}
          />
          <p className="workflow-flow-muted">{flowText.limits}</p>
          <MetadataList
            key={`${selected}-tools`}
            title="허용 도구"
            values={current.allowed_tools}
            prefixes={prefixes}
          />
          <MetadataList
            key={`${selected}-tables`}
            title="허용 테이블"
            values={current.allowed_tables}
            prefixes={prefixes}
          />
        </section>
      </div>
    </div>
  );
}
