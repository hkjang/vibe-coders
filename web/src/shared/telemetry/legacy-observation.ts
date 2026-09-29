import { createContext, useContext } from "react";

export const LegacyObservationContext = createContext<(() => void) | undefined>(undefined);

export function useObserveLegacyOpen(): (() => void) | undefined {
  return useContext(LegacyObservationContext);
}
