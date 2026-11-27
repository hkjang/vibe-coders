import { workActionIds, workMetricIds } from "@/shared/api/domains/insights-common";

import { safeCategoryId, safeText, usageTabs, validCustomRange } from "./usage-filters";

// An insight carries `link`: the view that shows its evidence. Only keys this
// screen owns are followed, each validated like a URL value, so a link can never
// carry anything else into the address bar.

const lists = ["sessions", "requests"];
const statuses = ["classified", "review", "unclassified", "failed"];

/** The query string an insight links to, or undefined when `link` names nothing usable. */
export function insightSearch(link: Readonly<Record<string, string>>): string | undefined {
  const params = new URLSearchParams();
  const put = (key: string, value: string): void => {
    if (value) params.set(key, value);
  };
  const tab = link.tab ?? "";
  if ((usageTabs as readonly string[]).includes(tab) && tab !== "summary") put("tab", tab);
  put("parent", safeCategoryId(link.parent ?? null));
  put("category", safeCategoryId(link.category ?? null));
  put("team", safeText(link.team ?? null));
  put("model", safeText(link.model ?? null, 160));
  put("client", safeText(link.client ?? null));
  if ((workActionIds as readonly string[]).includes(link.action ?? "")) put("action", link.action ?? "");
  if ((workMetricIds as readonly string[]).includes(link.metric ?? "") && link.metric !== "sessions") {
    put("metric", link.metric ?? "");
  }
  if (lists.includes(link.list ?? "") && link.list !== "sessions") put("list", link.list ?? "");
  if (statuses.includes(link.status ?? "")) put("status", link.status ?? "");
  if (validCustomRange(link.from ?? "", link.to ?? "")) {
    put("from", link.from ?? "");
    put("to", link.to ?? "");
  }
  const text = params.toString();
  // A link that only repeats the summary tab leads nowhere new.
  if (!text && tab !== "summary") return undefined;
  return text ? `?${text}` : "";
}
