import { createContext } from "react";

/** Only mounted, automatic status reads participate; on-demand inspections are separate. */
export const SystemRefreshContext = createContext<Set<() => void> | undefined>(undefined);
