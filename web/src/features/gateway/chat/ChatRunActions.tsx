import { useRef, useState } from "react";
import { MessageSquarePlus, Star, Trophy } from "lucide-react";
import { ChatRunActionDialog } from "./ChatRunActionDialog";
import { RunReadActions } from "./RunReadActions";
import { runActionLabels, type RunActionKind, type RunActionSnapshot } from "./run-action-state";
import { useCompareAccess, type CompareAccess } from "./use-compare-access";
import { Button } from "@/shared/components/ui/Button";

interface ChatRunActionsProps {
  runId: string;
  models: readonly string[];
  canWrite: boolean;
  writeDeniedReason: string;
  /** The admitted run's prompt, never the next editable comparison draft. */
  prompt: string;
}

export function ChatRunActions(props: ChatRunActionsProps): React.JSX.Element {
  const access = useCompareAccess(props.canWrite, props.writeDeniedReason);
  // Security disposal only: run/readonly/scope changes keep an open fixed draft.
  return (
    <OwnedRunActions key={`${access.epoch}:${access.owner}:${access.known}`} {...props} access={access} />
  );
}

function OwnedRunActions({ runId, models, prompt, access }: ChatRunActionsProps & { access: CompareAccess }) {
  const [snapshot, setSnapshot] = useState<RunActionSnapshot>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const open = (kind: RunActionKind, trigger: HTMLButtonElement) => {
    try {
      access.write.assertCurrent();
    } catch {
      return;
    }
    if (!runId || models.length === 0 || snapshot) return;
    returnFocusRef.current = trigger;
    setSnapshot({ kind, runId, models: [...models], prompt });
  };
  const icons = { feedback: MessageSquarePlus, promote: Trophy, golden: Star };
  return (
    <div className="gateway-run-actions">
      <div className="toolbar">
        <div className="toolbar-start">
          {(["feedback", "promote", "golden"] as const).map((kind) => {
            const Icon = icons[kind];
            return (
              <Button
                key={kind}
                size="small"
                variant="secondary"
                disabled={!access.write.allowed || !runId || models.length === 0}
                title={access.write.reason}
                onClick={(event) => open(kind, event.currentTarget)}
              >
                <Icon aria-hidden="true" /> {runActionLabels[kind].trigger}
              </Button>
            );
          })}
        </div>
      </div>
      <RunReadActions key={runId} runId={runId} access={access} />
      {snapshot ? (
        <ChatRunActionDialog
          snapshot={snapshot}
          access={access}
          close={() => setSnapshot(undefined)}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
    </div>
  );
}
