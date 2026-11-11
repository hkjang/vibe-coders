import { createContext, useContext } from "react";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import type { TeamWindow } from "./team-model";
export interface TeamScope {
  owner: FeatureReadOwner;
  team: string;
  queryTeam: string;
  window: TeamWindow;
}
export const TeamContext = createContext<TeamScope | undefined>(undefined);
export function useTeamScope() {
  const value = useContext(TeamContext);
  if (!value) throw new Error("팀 조회 범위를 먼저 확인하세요.");
  return value;
}
