import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export const routeId = "security.redteam";

export const redteamKeys = {
  root: ["redteam"] as const,
  targets: ["redteam", "targets"] as const,
  probePacks: ["redteam", "probe-packs"] as const,
  campaigns: ["redteam", "campaigns"] as const,
  runs: ["redteam", "runs"] as const,
  runResults: (runId: string) => ["redteam", "runs", runId, "results"] as const,
  evidence: (resultId: string) => ["redteam", "results", resultId, "evidence"] as const,
  baselines: ["redteam", "baselines"] as const,
  remediations: ["redteam", "remediations"] as const,
  dashboard: ["redteam", "dashboard"] as const,
  killSwitch: ["redteam", "kill-switch"] as const,
  schedules: ["redteam", "schedules"] as const,
} as const;

const redteam = endpoints.domains.redteam;

/**
 * Every list the Red Team screen renders. Each query stands alone so one failing
 * panel degrades to a warning instead of blanking the page.
 */
export function useRedTeamData() {
  const refetchInterval = useRefreshInterval();
  const shared = { refetchInterval, refetchIntervalInBackground: false } as const;

  const targets = useQuery({
    queryKey: redteamKeys.targets,
    queryFn: ({ signal }) => apiClient.request(redteam.targets.list, { signal, routeId }),
    ...shared,
  });
  const probePacks = useQuery({
    queryKey: redteamKeys.probePacks,
    queryFn: ({ signal }) => apiClient.request(redteam.probePacks.list, { signal, routeId }),
    ...shared,
  });
  const campaigns = useQuery({
    queryKey: redteamKeys.campaigns,
    queryFn: ({ signal }) => apiClient.request(redteam.campaigns.list, { signal, routeId }),
    ...shared,
  });
  const runs = useQuery({
    queryKey: redteamKeys.runs,
    queryFn: ({ signal }) => apiClient.request(redteam.runs.list, { signal, routeId }),
    ...shared,
  });
  const baselines = useQuery({
    queryKey: redteamKeys.baselines,
    queryFn: ({ signal }) => apiClient.request(redteam.baselines.list, { signal, routeId }),
    ...shared,
  });
  const remediations = useQuery({
    queryKey: redteamKeys.remediations,
    queryFn: ({ signal }) => apiClient.request(redteam.remediations.list, { signal, routeId }),
    ...shared,
  });
  const dashboard = useQuery({
    queryKey: redteamKeys.dashboard,
    queryFn: ({ signal }) => apiClient.request(redteam.dashboard, { signal, routeId }),
    ...shared,
  });
  const killSwitch = useQuery({
    queryKey: redteamKeys.killSwitch,
    queryFn: ({ signal }) => apiClient.request(redteam.killSwitch.read, { signal, routeId }),
    ...shared,
  });
  const schedules = useQuery({
    queryKey: redteamKeys.schedules,
    queryFn: ({ signal }) => apiClient.request(redteam.schedules.list, { signal, routeId }),
    ...shared,
  });

  return {
    baselines,
    campaigns,
    dashboard,
    killSwitch,
    probePacks,
    remediations,
    runs,
    schedules,
    targets,
  } as const;
}

export type RedTeamData = ReturnType<typeof useRedTeamData>;
