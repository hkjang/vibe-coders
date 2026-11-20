import { createContext, useContext } from "react";
import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import type { usePageRowSelection } from "@/shared/data-table/use-page-row-selection";
import type { ScatterMetric } from "./scatter-model";

interface Bindings {
  points: ReadonlyArray<ScatterPoint>;
  metric: ScatterMetric;
  categoryLabel: (point: ScatterPoint) => string;
  onSelect: (points: ReadonlyArray<ScatterPoint>, trigger?: HTMLElement) => void;
  bulk: ReturnType<typeof usePageRowSelection<ScatterPoint>>;
}

export const ScatterTableBindings = createContext<Bindings | undefined>(undefined);

export function useScatterTableBindings() {
  const value = useContext(ScatterTableBindings);
  if (!value) throw new Error("요청 표의 표시 상태를 찾지 못했습니다.");
  return value;
}
