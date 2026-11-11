import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useTeamScope } from "./team-context";
import { safeTeamError } from "./team-model";
import {
  readTeamDashboard,
  readTeamReports,
  readTeamSavings,
  readTeamOnboarding,
  readTeamRisk,
  readTeamSkills,
  readTeamCandidates,
  readTeamPortal,
  type TeamRead,
} from "./team-api";

export const teamQueryKeys = { all: ["team"] as const, reports: ["team", "reports"] as const };
function useTeamQuery<Result>(name: string, read: (value: TeamRead) => Promise<Result>) {
  const scope = useTeamScope();
  const { credentialPrefixes } = useAuth();
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: featureOwnedKey(["team", name, scope.team, scope.window], scope.owner),
    queryFn: async ({ signal }) => {
      try {
        assertFeatureRead(scope.owner, signal);
        const result = await read({ ...scope, prefixes: credentialPrefixes, signal });
        assertFeatureRead(scope.owner, signal);
        return result;
      } catch (error) {
        throw safeTeamError(error, credentialPrefixes);
      }
    },
    retry: false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
}
export const useTeamDashboardQuery = () => useTeamQuery("dashboard", readTeamDashboard);
export const useTeamReportsQuery = () => useTeamQuery("reports", readTeamReports);
export const useTeamSavingsQuery = () => useTeamQuery("savings", readTeamSavings);
export const useTeamOnboardingQuery = () => useTeamQuery("onboarding", readTeamOnboarding);
export const useTeamRiskQuery = () => useTeamQuery("risk", readTeamRisk);
export const useTeamSkillsQuery = () => useTeamQuery("skills", readTeamSkills);
export const useTeamCandidatesQuery = () => useTeamQuery("candidates", readTeamCandidates);
export const useTeamPortalQuery = () => useTeamQuery("portal", readTeamPortal);
