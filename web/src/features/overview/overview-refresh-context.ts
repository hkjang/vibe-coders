import { createContext } from "react";

/** Only currently mounted widgets participate in an explicit dashboard refresh. */
export const OverviewRefreshContext = createContext<Set<() => void> | undefined>(undefined);
