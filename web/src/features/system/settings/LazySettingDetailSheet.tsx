import { lazy, Suspense } from "react";
import type { SettingDetailSheet as DetailSheet } from "./SettingDetailSheet";

const SettingDetailSheet = lazy(() =>
  import("./SettingDetailSheet").then((module) => ({ default: module.SettingDetailSheet })),
);

/** Load the setting editor only for an explicit selection or a setting deep link. */
export function LazySettingDetailSheet(props: Parameters<typeof DetailSheet>[0]): React.JSX.Element | null {
  if (!props.open || !props.setting) return null;
  return (
    <Suspense fallback={<p role="status">설정 상세 화면을 불러오는 중입니다.</p>}>
      <SettingDetailSheet {...props} />
    </Suspense>
  );
}
