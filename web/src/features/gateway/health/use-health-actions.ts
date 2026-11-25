import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useAuth } from "@/app/auth/AuthProvider";
import { healthDisplayError } from "./health-display-error";

import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useHealthWriteAccess } from "./use-health-write-access";

const routeId = "gateway.health";
const gateway = endpoints.domains.gateway;
const routingHealthKey = ["admin", "routing", "health"];
const balancerKey = ["gateway", "routing", "balancer"];

interface RecoveryTarget {
  provider: string;
  owner: FeatureReadOwner;
  snapshotCurrent: () => boolean;
}

function assertSnapshot(target: RecoveryTarget) {
  assertFeatureRead(target.owner);
  if (!target.snapshotCurrent())
    throw new AppError("최신 조회 상태에서 복구 대상을 다시 확인하세요.", { kind: "aborted" });
}

/**
 * Recovery actions the legacy Provider Health tab offered: clearing a tripped
 * circuit breaker and releasing sticky sessions. An empty provider means "all".
 */
export function useHealthActions() {
  const { credentialPrefixes } = useAuth();
  const access = useHealthWriteAccess();
  const resetBreaker = useMutationFeedback({
    observation: "save",
    gcTime: 0,
    ownsResult: (target: RecoveryTarget) => target.owner.isCurrent(),
    mutate: (target: RecoveryTarget) => {
      assertSnapshot(target);
      const { provider } = target;
      access.assertCurrent();
      return apiClient
        .request(gateway.routing.breakerReset, { body: { provider }, routeId })
        .catch((error: unknown) => {
          throw healthDisplayError(error, credentialPrefixes);
        });
    },
    invalidates: [routingHealthKey],
    successMessage: (_result, { provider }) =>
      provider === "" ? "모든 회로 차단기를 해제했습니다." : "회로 차단기를 해제했습니다.",
    errorMessage: "회로 차단기를 해제하지 못했습니다.",
  });

  const releaseSessions = useMutationFeedback({
    observation: "revoke",
    gcTime: 0,
    ownsResult: (target: RecoveryTarget) => target.owner.isCurrent(),
    mutate: (target: RecoveryTarget) => {
      assertSnapshot(target);
      const { provider } = target;
      access.assertCurrent();
      return apiClient
        .request(gateway.routing.releaseSessions, { body: { provider }, routeId })
        .catch((error: unknown) => {
          throw healthDisplayError(error, credentialPrefixes);
        });
    },
    invalidates: [balancerKey, routingHealthKey],
    successMessage: "세션 고정을 해제했습니다.",
    errorMessage: "세션 고정을 해제하지 못했습니다.",
  });

  return { access, releaseSessions, resetBreaker } as const;
}
