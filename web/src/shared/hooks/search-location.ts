import { createContext } from "react";

/** Event-time location for query updates while a router render is pending. */
export const SearchLocationContext = createContext<(() => { pathname: string; search: string }) | null>(null);
