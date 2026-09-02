import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";

import { isHealthRange, type HealthRange } from "@/features/health/health-utils";

export function useHealthRange(
  defaultRange: HealthRange = "24h",
): readonly [HealthRange, (range: HealthRange) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("range");
  const range = isHealthRange(requested) ? requested : defaultRange;
  useEffect(() => {
    if (requested === null || isHealthRange(requested)) return;
    const normalized = new URLSearchParams(searchParams);
    normalized.set("range", defaultRange);
    setSearchParams(normalized, { replace: true });
  }, [defaultRange, requested, searchParams, setSearchParams]);
  const setRange = useCallback(
    (nextRange: HealthRange): void => {
      const next = new URLSearchParams(searchParams);
      next.set("range", nextRange);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  return [range, setRange] as const;
}
