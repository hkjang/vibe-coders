import type { ComponentPropsWithoutRef } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { resolveLegacyFeatureHref } from "@/shared/permissions/legacy-feature";
import { LegacyLink } from "./LegacyLink";

/** An explicit destination avoids borrowing an unrelated current route's policy. */
export function FeatureLegacyLink({
  featureId,
  ...props
}: ComponentPropsWithoutRef<"a"> & { featureId: string }): React.JSX.Element | null {
  const auth = useAuth();
  const href = resolveLegacyFeatureHref(auth, featureId, props.href);
  return href ? <LegacyLink {...props} href={href} /> : null;
}
