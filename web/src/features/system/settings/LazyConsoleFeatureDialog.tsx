import { lazy, Suspense } from "react";
import type { ConsoleFeatureDialog as FeatureDialog } from "./ConsoleFeatureDialog";

const ConsoleFeatureDialog = lazy(() =>
  import("./ConsoleFeatureDialog").then((module) => ({ default: module.ConsoleFeatureDialog })),
);

/** Loaded only for an explicit edit action or a selected-setting deep link. */
export function LazyConsoleFeatureDialog(props: Parameters<typeof FeatureDialog>[0]) {
  if (!props.open) return null;
  return (
    <Suspense fallback={<p role="status">기능 전환 편집 화면을 불러오는 중입니다.</p>}>
      <ConsoleFeatureDialog {...props} />
    </Suspense>
  );
}
