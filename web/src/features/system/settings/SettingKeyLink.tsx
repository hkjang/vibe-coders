import { Link, useSearchParams } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";

export function SettingKeyLink({ settingKey }: { settingKey: string }) {
  const [params] = useSearchParams();
  const { credentialPrefixes } = useAuth();
  const next = new URLSearchParams(params);
  next.set("tab", "runtime");
  next.set("setting", settingKey);
  const safe = sanitizeAppRouteSearch("/system/settings", next.toString(), credentialPrefixes);
  return (
    <Link
      className="mono"
      to={`/system/settings${safe.search}`}
      data-setting-link
      onClick={(event) => event.stopPropagation()}
    >
      {settingKey}
    </Link>
  );
}
