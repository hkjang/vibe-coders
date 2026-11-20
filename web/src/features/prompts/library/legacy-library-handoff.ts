import { legacyRoutes, isLegacyAdminHref } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { libraryID } from "./library-model";
import { searchQueryFrom } from "./search-filters";

export interface LibraryLegacyHandoff {
  href?: `/admin${string}`;
  selectedAsset: boolean;
  omitted: boolean;
}

/** A runtime override owns its own query contract; only canonical routes receive state. */
export function libraryLegacyHandoff(
  base: string | undefined,
  tab: string,
  params: URLSearchParams,
  prefixes: readonly string[],
  supported: boolean,
): LibraryLegacyHandoff {
  const empty = { selectedAsset: false, omitted: false };
  if (!["search", "assets", "debt"].includes(tab) || !isLegacyAdminHref(base)) return empty;
  if (containsPotentialSecret(base, prefixes)) return empty;
  if (base !== legacyRoutes.prompts) return { ...empty, href: base, omitted: true };
  const path =
    tab === "assets"
      ? legacyRoutes.promptAssets
      : tab === "debt"
        ? legacyRoutes.promptDebt
        : legacyRoutes.prompts;
  if (!supported) return { ...empty, href: path, omitted: true };
  const query = new URLSearchParams();
  let omitted = false;
  const put = (key: string, value: string | undefined) => {
    if (!value) return;
    if (
      containsPotentialSecret(value, prefixes) ||
      Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      omitted = true;
      return;
    }
    query.set(key, value);
  };
  if (tab === "search") {
    for (const [key, value] of Object.entries(searchQueryFrom(params))) {
      if (key === "since" && !Number.isFinite(Date.parse(String(value)))) {
        omitted = true;
        continue;
      }
      put(key, String(value));
    }
    const window = params.get("fp_window") ?? "";
    query.set("fp_window", ["24h", "7d", "30d", "90d"].includes(window) ? window : "7d");
  } else if (tab === "assets") {
    for (const key of ["q", "status", "category", "tag"]) put(key, params.get("asset_" + key)?.trim());
    const id = params.get("asset")?.trim();
    if (id && params.getAll("asset").length === 1 && libraryID(id, prefixes)) put("asset", id);
    else if (id || params.getAll("asset").length > 1) omitted = true;
  } else {
    const window = params.get("debt_window") ?? "";
    query.set("window", ["7d", "30d", "90d"].includes(window) ? window : "30d");
  }
  const href = `${path}${query.size ? "?" + query : ""}`;
  if (href.length > 8192 || !isLegacyAdminHref(href)) return { ...empty, href: path, omitted: true };
  return { href, selectedAsset: query.has("asset"), omitted };
}
