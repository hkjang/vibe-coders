import { createContext } from "react";
import type { RouteLoadObserver } from "@/shared/telemetry/route-load";

export const RouteLoadContext = createContext<RouteLoadObserver | undefined>(undefined);
