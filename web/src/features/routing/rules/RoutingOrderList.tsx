import { useLayoutEffect, useRef } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { OrderSnapshot } from "@/shared/api/domains/routing-order";
import { Button } from "@/shared/components/ui/Button";
import { orderDisplay, orderText } from "./routing-order-state";

export function RoutingOrderList({
  snapshot,
  ids,
  prefixes,
  disabled,
  move,
}: {
  snapshot: OrderSnapshot;
  ids: readonly string[];
  prefixes: readonly string[];
  disabled: boolean;
  move: (from: number, to: number) => void;
}) {
  const dragged = useRef<number | undefined>(undefined);
  const focusAfterMove = useRef<string | undefined>(undefined);
  const elements = useRef(new Map<string, HTMLLIElement>());
  useLayoutEffect(() => {
    const id = focusAfterMove.current;
    focusAfterMove.current = undefined;
    if (id) elements.current.get(id)?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [ids]);
  const byID = new Map(snapshot.rules.map((rule) => [rule.id, rule]));
  return (
    <section aria-label="변경 전후 우선순위" className="routing-order-list-region">
      <p id="routing-order-help">{orderText.moveHelp}</p>
      <ol className="routing-order-list" aria-describedby="routing-order-help">
        {ids.map((id, index) => {
          const rule = byID.get(id);
          if (!rule) return null;
          const name = orderDisplay(rule.target_model, prefixes);
          return (
            <li
              key={id}
              ref={(element) => {
                if (element) elements.current.set(id, element);
                else elements.current.delete(id);
              }}
              draggable={!disabled}
              onDragStart={(event) => {
                if (disabled) {
                  event.preventDefault();
                  return;
                }
                dragged.current = index;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
              }}
              onDragEnd={() => {
                dragged.current = undefined;
              }}
              onDragOver={(event) => {
                if (!disabled && dragged.current !== undefined) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragged.current;
                dragged.current = undefined;
                if (!disabled && from !== undefined) move(from, index);
              }}
            >
              <div className="routing-order-row-copy">
                <strong>
                  {index + 1}. {name}
                </strong>
                <span>
                  우선순위 {rule.priority} → {index + 1} · {rule.enabled ? "사용 중" : "사용 안 함"}
                </span>
                <span>
                  {orderDisplay(rule.match_pattern, prefixes)} · 복잡도 {rule.min_complexity}~
                  {rule.max_complexity}
                </span>
              </div>
              <div className="routing-order-move-buttons">
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label={`${index + 1}번째 규칙 위로`}
                  disabled={disabled || index === 0}
                  onClick={() => {
                    focusAfterMove.current = id;
                    move(index, index - 1);
                  }}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label={`${index + 1}번째 규칙 아래로`}
                  disabled={disabled || index === ids.length - 1}
                  onClick={() => {
                    focusAfterMove.current = id;
                    move(index, index + 1);
                  }}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
