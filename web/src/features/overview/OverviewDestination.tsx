import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { useNavigationItems } from "@/app/layouts/use-navigation-items";
import { useAuth } from "@/app/auth/AuthProvider";
import { featurePath } from "@/config/migration-registry";
import { LegacyLink } from "@/shared/components/ui/LegacyLink";
import type { HealthRange } from "@/features/health/health-utils";

/** Resolve links through the same permissions, rollout and fallback policy as the sidebar. */
export function OverviewDestination({
  featureId,
  label,
  range,
  tab,
}: {
  featureId: string;
  label: string;
  range?: HealthRange;
  tab?: "audit" | "safety";
}) {
  const auth = useAuth();
  const item = useNavigationItems().find(({ feature }) => feature.featureId === featureId);
  if (!item) return null;
  if (
    item.feature.requiredPermission &&
    auth.user &&
    !auth.user.scopes.includes(item.feature.requiredPermission)
  )
    return null;
  const content = (
    <>
      {label}
      <ArrowUpRight aria-hidden="true" />
    </>
  );
  if (item.effective.status === "legacy")
    return (
      <LegacyLink className="overview-destination" href={item.feature.legacyPath}>
        {content}
        <span>기존 화면</span>
      </LegacyLink>
    );
  const base = featurePath(item.feature);
  const to =
    featureId === "routing.rules"
      ? `${base}/health?window=${range ?? "24h"}&threshold=70`
      : tab
        ? `${base}?tab=${tab}`
        : base;
  return (
    <Link className="overview-destination" to={to}>
      {content}
    </Link>
  );
}
