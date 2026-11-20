import { legacyRemediationTarget } from "@/config/legacy-route-map";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";

export function RemediationLegacyLink({ link }: { link?: string }): React.JSX.Element | null {
  const target = legacyRemediationTarget(link);
  return target ? (
    <FeatureLegacyLink
      featureId={target.featureId}
      href={target.href}
      className="button button-secondary button-small"
    >
      기존 화면에서 처리
    </FeatureLegacyLink>
  ) : null;
}
