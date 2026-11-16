import { useContext, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { RoutingRuleDetailFocusContext } from "./routing-rule-detail-focus";
import { RoutingRuleDetail } from "./RoutingRuleDetail";
import { RoutingRuleWorkspaceContext } from "./routing-rule-workspace-context";
export function RoutingRuleDetailRoute() {
  const [params, setParams] = useSearchParams();
  const values = params.getAll("rule_id");
  const fallback = useRef<HTMLElement | null>(null);
  const focusRef = useContext(RoutingRuleDetailFocusContext) ?? fallback;
  const id = values[0];
  const returnFocusRef = useMemo(
    () => ({
      get current() {
        if (focusRef.current?.isConnected) return focusRef.current;
        // A refreshed list may replace the original link while history reopens
        // this panel. Resolve the current visible link by its exact identity.
        return (
          Array.from(document.querySelectorAll<HTMLElement>("[data-routing-rule-detail-id]")).find(
            (element) => element.dataset.routingRuleDetailId === id,
          ) ?? null
        );
      },
    }),
    [focusRef, id],
  );
  const workspace = useContext(RoutingRuleWorkspaceContext);
  const standalone = useFeatureReadOwner("routing.rules", "routing-rule-detail", [], "routing:read");
  const owner = workspace ?? standalone;
  if (!values.length) return null;
  return (
    <RoutingRuleDetail
      key={JSON.stringify([owner.id, values])}
      owner={owner}
      values={values}
      returnFocusRef={returnFocusRef}
      onClose={() =>
        setParams((current) => {
          const next = new URLSearchParams(current);
          next.delete("rule_id");
          return next;
        })
      }
    />
  );
}
