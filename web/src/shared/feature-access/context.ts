import { createContext } from "react";
import type { FeatureAccess } from "./policy";

export const FeatureAccessContext = createContext<FeatureAccess | undefined>(undefined);
