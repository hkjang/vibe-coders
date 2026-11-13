import { lazy, Suspense } from "react";
import type { SettingsRecoveryDialog as Recovery } from "./SettingsRecoveryDialog";

const SettingsRecoveryDialog = lazy(() =>
  import("./SettingsRecoveryDialog").then((module) => ({ default: module.SettingsRecoveryDialog })),
);

/** Recovery code is requested only after an explicit revert/rollback action. */
export function LazySettingsRecovery(props: Parameters<typeof Recovery>[0]) {
  if (!props.request) return null;
  return (
    <Suspense fallback={<p role="status">복구 확인 화면을 불러오는 중입니다.</p>}>
      <SettingsRecoveryDialog {...props} />
    </Suspense>
  );
}
