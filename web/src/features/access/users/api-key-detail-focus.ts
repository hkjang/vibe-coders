import { createContext, type RefObject } from "react";

export const ApiKeyDetailFocusContext = createContext<RefObject<HTMLElement | null> | null>(null);
