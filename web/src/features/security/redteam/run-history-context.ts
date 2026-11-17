import { createContext, useContext } from "react";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
export const RunHistoryContext = createContext<FeatureReadOwner | undefined>(undefined);
export const useRunHistoryOwner = () => useContext(RunHistoryContext);
