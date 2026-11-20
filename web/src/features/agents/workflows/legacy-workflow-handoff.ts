import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { validWorkflowDetailId } from "./workflow-page-model";

export function workflowLegacyHandoff(
  base: string | undefined,
  id: string | undefined,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameWorkflow: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameWorkflow: false };
  const fallback = { href: base, sameWorkflow: false };
  if (
    base !== legacyRoutes.workflows ||
    !supported ||
    id === undefined ||
    !validWorkflowDetailId(id, prefixes)
  )
    return fallback;
  const href = `${base}?${new URLSearchParams({ workflow_id: id })}`;
  return href.length <= 16384 && isLegacyAdminHref(href) ? { href, sameWorkflow: true } : fallback;
}
