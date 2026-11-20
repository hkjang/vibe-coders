import { useAuth } from "@/app/auth/AuthProvider";
import { policyLegacyHandoff } from "@/config/legacy-policy-map";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { resolveLegacyFeatureHref } from "@/shared/permissions/legacy-feature";

export function PolicyLegacyLink({ id }: { id: string }) {
  const auth = useAuth();
  const target = policyLegacyHandoff(
    auth.features.find((feature) => feature.featureId === "governance.policies")?.legacyPath,
    id,
    auth.capabilities.legacy_policy_detail === true,
    auth.credentialPrefixes,
  );
  if (!resolveLegacyFeatureHref(auth, "governance.policies", target.href)) return null;
  return (
    <div>
      <FeatureLegacyLink
        featureId="governance.policies"
        href={target.href}
        className="button button-secondary button-default"
      >
        기존 화면에서 열기
      </FeatureLegacyLink>
      {!target.samePolicy ? <p className="muted">기존 화면에서 정책을 다시 선택하세요.</p> : null}
    </div>
  );
}
