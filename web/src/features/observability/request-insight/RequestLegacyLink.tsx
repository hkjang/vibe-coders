import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { useId } from "react";
import type { RequestLegacyListContext } from "@/config/legacy-request-handoff";
import { useRequestLegacyHandoff, type RequestLegacyFeature } from "./use-request-legacy-handoff";

export function RequestLegacyLink({
  requestId,
  featureId = "observability.requests",
  list,
}: {
  requestId: string;
  featureId?: RequestLegacyFeature;
  list?: RequestLegacyListContext;
}): React.JSX.Element {
  const destination = useRequestLegacyHandoff(requestId, featureId, list);
  const noticeId = useId();
  return (
    <div>
      <FeatureLegacyLink
        featureId={featureId}
        href={destination.href}
        aria-describedby={destination.notice ? noticeId : undefined}
      >
        {destination.sameRequest ? "기존 화면에서 같은 요청 열기" : "기존 화면에서 요청 열기"}
      </FeatureLegacyLink>
      {destination.notice ? (
        <p className="obs-meta" id={noticeId}>
          {destination.notice}
        </p>
      ) : null}
    </div>
  );
}
