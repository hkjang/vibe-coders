import { useContext } from "react";
import { Link, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { RoutingRuleDetailFocusContext } from "./routing-rule-detail-focus";
import { validRoutingRuleDetailId } from "./routing-rule-detail-model";
import { ruleText } from "./routing-rule-edit-state";
export function RoutingRuleDetailLink({ row }: { row: RoutingRule }) {
  const auth = useAuth(),
    location = useLocation();
  const focusRef = useContext(RoutingRuleDetailFocusContext);
  if (
    !versionAtLeast(auth.backendVersion, "v0.86.103") ||
    !auth.user?.scopes.includes("routing:read") ||
    !validRoutingRuleDetailId(row.id, auth.credentialPrefixes)
  )
    return null;
  const params = new URLSearchParams(location.search);
  params.set("rule_id", row.id);
  return (
    <Link
      className="button button-ghost button-small"
      data-routing-rule-detail-id={row.id}
      to={{ pathname: location.pathname, search: params.toString() }}
      aria-label={`${ruleText(row.match_pattern, auth.credentialPrefixes, "*")} → ${ruleText(row.target_model, auth.credentialPrefixes)} 규칙 상세`}
      onClick={(event) => {
        if (focusRef) focusRef.current = event.currentTarget;
      }}
    >
      상세
    </Link>
  );
}
