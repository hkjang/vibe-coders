import { useEffect, useRef, useState, type ComponentType, type RefObject } from "react";
import { Dialog } from "./Dialog";

/** Mount after an explicit gesture; cancellation retires late code downloads. */
export function DeferredDialog<Props extends object>({
  load,
  dialogProps,
  title,
  onClose,
  returnFocusRef,
}: {
  load: () => Promise<ComponentType<Props>>;
  dialogProps: Props;
  title: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [Editor, setEditor] = useState<ComponentType<Props>>();
  const [failed, setFailed] = useState(false);
  const replacing = useRef(false);
  useEffect(() => {
    let current = true;
    void load()
      .then((component) => {
        if (current) {
          replacing.current = true;
          setEditor(() => component);
        }
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [load]);
  if (Editor) return <Editor {...dialogProps} />;
  return (
    <Dialog
      open
      title={title}
      description="편집 화면을 준비합니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onCloseAutoFocus={(event) => {
        if (replacing.current) event.preventDefault();
      }}
    >
      <p role="status">
        {failed
          ? "편집 화면을 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요."
          : "편집 화면을 불러오는 중입니다."}
      </p>
    </Dialog>
  );
}
