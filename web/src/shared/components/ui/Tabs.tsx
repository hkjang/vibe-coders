import { useCallback, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/shared/utils/cn";

export interface TabItem<Id extends string = string> {
  id: Id;
  label: ReactNode;
  /** Optional count or status shown after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

interface TabsProps<Id extends string> {
  ariaLabel: string;
  className?: string;
  items: ReadonlyArray<TabItem<Id>>;
  onChange: (id: Id) => void;
  value: Id;
  /** id prefix so `aria-controls` can point at the matching panel. */
  panelIdPrefix?: string;
}

/**
 * Accessible tab strip (WAI-ARIA tabs pattern with automatic activation). The
 * panel itself is rendered by the caller with `TabPanel`.
 */
export function Tabs<Id extends string>({
  ariaLabel,
  className,
  items,
  onChange,
  panelIdPrefix = "tab",
  value,
}: TabsProps<Id>): React.JSX.Element {
  const enabled = items.filter((item) => !item.disabled);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, current: Id): void => {
      const index = enabled.findIndex((item) => item.id === current);
      if (index < 0) return;
      let next: TabItem<Id> | undefined;
      if (event.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
      else if (event.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
      else if (event.key === "Home") next = enabled[0];
      else if (event.key === "End") next = enabled[enabled.length - 1];
      if (!next) return;
      event.preventDefault();
      onChange(next.id);
      const button = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
        `[data-tab-id="${next.id}"]`,
      );
      button?.focus();
    },
    [enabled, onChange],
  );

  return (
    <div className={cn("tabs", className)} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${panelIdPrefix}-${item.id}-tab`}
            aria-selected={selected}
            aria-controls={`${panelIdPrefix}-${item.id}-panel`}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            data-tab-id={item.id}
            className={cn("tab", selected && "tab-selected")}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, item.id)}
          >
            <span>{item.label}</span>
            {item.badge !== undefined ? <span className="tab-badge">{item.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

interface TabPanelProps {
  children: ReactNode;
  className?: string;
  id: string;
  panelIdPrefix?: string;
}

export function TabPanel({
  children,
  className,
  id,
  panelIdPrefix = "tab",
}: TabPanelProps): React.JSX.Element {
  return (
    <div
      role="tabpanel"
      id={`${panelIdPrefix}-${id}-panel`}
      aria-labelledby={`${panelIdPrefix}-${id}-tab`}
      tabIndex={0}
      className={cn("tab-panel", className)}
    >
      {children}
    </div>
  );
}
