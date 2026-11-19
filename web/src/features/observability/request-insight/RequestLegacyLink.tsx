import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { useRequestLegacyHandoff, type RequestLegacyFeature } from "./use-request-legacy-handoff";

export function RequestLegacyLink({
  requestId,
  featureId = "observability.requests",
}: {
  requestId: string;
  featureId?: RequestLegacyFeature;
}): React.JSX.Element {
  const destination = useRequestLegacyHandoff(requestId, featureId);
  return (
    <FeatureLegacyLink featureId={featureId} href={destination.href}>
      {destination.sameRequest ? "기존 화면에서 같은 요청 열기" : "기존 화면에서 요청 열기"}
    </FeatureLegacyLink>
  );
}
