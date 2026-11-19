import type { ComponentPropsWithoutRef } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { canOpenLegacyFeature } from "@/shared/permissions/legacy-feature";
import { LegacyLink } from "./LegacyLink";

/** An explicit destination avoids borrowing an unrelated current route's policy. */
export function FeatureLegacyLink({
  featureId,
  ...props
}: ComponentPropsWithoutRef<"a"> & { featureId: string }): React.JSX.Element | null {
  const auth = useAuth();
  if (!props.href || !canOpenLegacyFeature(auth, featureId)) return null;
  return <LegacyLink {...props} />;
}
