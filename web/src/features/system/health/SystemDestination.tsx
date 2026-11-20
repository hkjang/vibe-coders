import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { useNavigationItems } from "@/app/layouts/use-navigation-items";
import { featurePath } from "@/config/migration-registry";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { appRouteForCardLink } from "./ops-status";

export function SystemDestination({ link, children }: { link?: string | null; children: ReactNode }) {
  const auth = useAuth();
  const route = appRouteForCardLink(link);
  const item = useNavigationItems().find(({ feature }) => feature.appPath === route);
  if (
    !item ||
    (item.feature.requiredPermission &&
      auth.user &&
      !auth.user.scopes.includes(item.feature.requiredPermission))
  )
    return <>{children}</>;
  if (item.effective.status === "legacy")
    return (
      <FeatureLegacyLink
        featureId={item.feature.featureId}
        className="ops-card-link"
        href={item.feature.legacyPath}
      >
        {children}
        <span>기존 화면 열기</span>
      </FeatureLegacyLink>
    );
  return (
    <Link className="ops-card-link" to={featurePath(item.feature)}>
      {children}
    </Link>
  );
}
