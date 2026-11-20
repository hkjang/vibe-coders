import { createContext } from "react";
import type { ReadQueue } from "@/shared/api/read-queue";

export const OverviewReadQueueContext = createContext<ReadQueue | undefined>(undefined);
