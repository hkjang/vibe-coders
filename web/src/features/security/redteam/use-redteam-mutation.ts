import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { writeDeniedReason } from "./redteam-ui";

/** Persistent changes only: inspection and exports keep their existing read permissions. */
export function useRedTeamMutation<Variables, Result>(
  canWrite: boolean,
  options: Parameters<typeof useMutationFeedback<Variables, Result>>[0],
) {
  const access = useFeatureMutationAccess(["security.redteam"], canWrite, writeDeniedReason);
  return useMutationFeedback({
    ...options,
    gcTime: 0,
    ownsResult: (variables) => {
      try {
        access.assertCurrent();
        return options.ownsResult?.(variables) ?? true;
      } catch {
        return false;
      }
    },
    mutate: async (variables: Variables) => {
      access.assertCurrent();
      try {
        const result = await options.mutate(variables);
        access.assertCurrent();
        return result;
      } catch (error) {
        access.assertCurrent();
        throw error;
      }
    },
  });
}
