import { useRef, useState } from "react";
import type { RoutingRule } from "@/shared/api/domains/routing";
import type { RoutingToggleAccess } from "./routing-toggle-access";
import type { RoutingToggleData } from "./routing-toggle-data";
import { sameRoutingRule, toggleIdentityReason } from "./routing-toggle-state";

interface ToggleSelection {
  rule: RoutingRule;
  intendedEnabled: boolean;
  trigger: HTMLButtonElement;
  sequence: number;
}

/** Only the toggle draft resets on security ownership changes; other CRUD is separate. */
export function useRoutingToggleSelection(access: RoutingToggleAccess, data: RoutingToggleData) {
  const sequence = useRef(0);
  const [state, setState] = useState<{ securityKey: string; target?: ToggleSelection }>({
    securityKey: access.securityKey,
  });
  if (state.securityKey !== access.securityKey) setState({ securityKey: access.securityKey });
  const target = state.securityKey === access.securityKey ? state.target : undefined;
  function open(rule: RoutingRule, trigger: HTMLButtonElement) {
    try {
      access.write.assertCurrent();
      const current = data.assertConfirmed().find((candidate) => candidate.id === rule.id);
      if (!current || !sameRoutingRule(current, rule) || toggleIdentityReason(rule.id)) return;
      setState({
        securityKey: access.securityKey,
        target: {
          rule: { ...current },
          intendedEnabled: !current.enabled,
          trigger,
          sequence: ++sequence.current,
        },
      });
    } catch {
      /* no new draft without current owner, permissions and confirmed list */
    }
  }
  function close(opening: number) {
    setState((previous) =>
      previous.target?.sequence === opening ? { securityKey: previous.securityKey } : previous,
    );
  }
  return { target, open, close };
}
