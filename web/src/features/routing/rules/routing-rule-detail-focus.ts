import { createContext, type RefObject } from "react";
export const RoutingRuleDetailFocusContext = createContext<RefObject<HTMLElement | null> | null>(null);
