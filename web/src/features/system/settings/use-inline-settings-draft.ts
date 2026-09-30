import { useLayoutEffect, useRef, useState } from "react";

import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { UnsavedDiscardReason } from "@/shared/unsaved/coordinator";

/** Values, including input-only secrets, live only in this editor's memory. */
export function useInlineSettingsDraft<Config, Draft>({
  config,
  fromConfig,
  held = false,
  onDiscard,
}: {
  config: Config;
  fromConfig: (config: Config) => Draft;
  held?: boolean;
  onDiscard?: (reason: UnsavedDiscardReason) => void;
}) {
  const [baseline, setBaseline] = useState(config);
  const [draft, setDraft] = useState(() => fromConfig(config));
  const [pristine, setPristine] = useState(() => fromConfig(config));
  const [supersededConfig, setSupersededConfig] = useState<Config>();
  const latestConfig = useRef(config);
  useLayoutEffect(() => {
    latestConfig.current = config;
  }, [config]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(pristine);
  const serverChanged = config !== supersededConfig && JSON.stringify(config) !== JSON.stringify(baseline);
  const rebase = (next: Config): void => {
    setBaseline(next);
    setDraft(fromConfig(next));
    setPristine(fromConfig(next));
    // Query observer notifications can follow the accepted response's state
    // update. Never rebase that response back onto the previous cached object.
    setSupersededConfig(next === latestConfig.current ? undefined : latestConfig.current);
  };
  const guard = useDraftGuard({
    dirty,
    keepMounted: true,
    onDiscard: (reason) => {
      rebase(config);
      onDiscard?.(reason);
    },
  });
  if (serverChanged && !dirty && !held && !guard.pending) {
    setBaseline(config);
    setDraft(fromConfig(config));
    setPristine(fromConfig(config));
  }
  const update = <Key extends keyof Draft>(key: Key, value: Draft[Key]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const acceptDraft = (next: Draft): void => {
    // A committed write without a readable new version is clean, but its caller
    // must keep saving locked until a fresh authoritative snapshot is available.
    setDraft(next);
    setPristine(next);
  };
  return { baseline, draft, dirty, serverChanged, rebase, acceptDraft, update, guard };
}
