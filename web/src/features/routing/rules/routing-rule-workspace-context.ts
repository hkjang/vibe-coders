import { createContext } from "react";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";

export const RoutingRuleWorkspaceContext = createContext<FeatureReadOwner | undefined>(undefined);
