import type { WorkQuery } from "@/shared/api/domains/insights-common";

import type { DayRange, UsageFilters } from "./usage-filters";

export interface UsageTabProps {
  filters: UsageFilters;
  /** The query every read of the screen shares, built from the filters. */
  query: WorkQuery;
  range: DayRange;
  /** Groups with fewer distinct users than this are withheld by the server. */
  minGroupSize: number;
}
