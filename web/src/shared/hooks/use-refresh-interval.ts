import { usePreferences } from "@/shared/stores/preferences";

/** The operator's auto-refresh preference as a react-query `refetchInterval`. */
export function useRefreshInterval(): number | false {
  const seconds = usePreferences((state) => state.refreshInterval);
  return seconds ? seconds * 1_000 : false;
}
