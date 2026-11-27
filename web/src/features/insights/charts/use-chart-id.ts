import { useId } from "react";

/** An id that is safe inside `url(#…)` references and CSS selectors. */
export function useChartId(): string {
  return `wi${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;
}
