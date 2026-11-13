import type { RefObject } from "react";
import { Sheet } from "@/shared/components/ui/Sheet";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { QueryNotice } from "./SettingsParts";

export function RuntimeSettingUnavailable({
  console: isConsole = false,
  loading,
  error,
  valid,
  onClose,
  onRetry,
  returnFocusRef,
}: {
  console?: boolean;
  loading: boolean;
  error: unknown;
  valid: boolean;
  onClose: () => void;
  onRetry: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Sheet
      open
      title="설정 상세"
      description={
        isConsole ? "주소에 지정된 콘솔 전환 설정을 확인합니다." : "주소에 지정된 런타임 설정을 확인합니다."
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
    >
      {!valid ? (
        <EmptyState
          title="설정 주소를 확인하세요."
          description="올바른 설정 키로 다시 접근하거나 목록에서 설정을 선택하세요."
        />
      ) : error ? (
        <QueryNotice error={error} hasPreviousData={false} label="설정 상세" onRetry={onRetry} />
      ) : loading ? (
        <p role="status">설정 상세를 불러오는 중입니다.</p>
      ) : (
        <EmptyState
          title="설정을 찾을 수 없습니다."
          description={
            isConsole
              ? "콘솔 전환 목록에 없는 키입니다. 런타임 설정은 런타임 화면에서 확인하세요."
              : "런타임 목록에 없는 키입니다. ui.app 설정은 콘솔 전환 화면에서 확인하세요."
          }
        />
      )}
    </Sheet>
  );
}
