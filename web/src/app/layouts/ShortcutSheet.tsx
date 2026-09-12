import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { Button } from "@/shared/components/ui/Button";

interface ShortcutSheetProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/**
 * What the keyboard can do here. A palette nobody knows about is a palette nobody uses,
 * so the shortcuts are written down in one place the `?` key opens.
 */
const shortcuts: ReadonlyArray<{ keys: readonly string[]; what: string }> = [
  { keys: ["Ctrl", "K"], what: "명령 팔레트 열기 (Mac은 ⌘K)" },
  { keys: ["?"], what: "이 단축키 도움말 열기" },
  { keys: ["↑", "↓"], what: "팔레트 항목 이동" },
  { keys: ["Enter"], what: "선택한 항목 실행" },
  { keys: ["Esc"], what: "팔레트·대화상자 닫기" },
];

const paletteTips: readonly string[] = [
  "요청 ID·추적 ID·세션 ID를 붙여넣으면 해당 요청을 바로 찾아갑니다.",
  "테마, 정보 밀도, 자동 갱신 주기 전환과 지금 새로고침을 팔레트에서 실행할 수 있습니다.",
  "검색창을 비우면 최근에 연 화면이 먼저 보입니다.",
];

export function ShortcutSheet({ onOpenChange, open }: ShortcutSheetProps): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="command-dialog" aria-describedby="shortcut-description">
          <div className="command-heading">
            <div>
              <Dialog.Title>단축키</Dialog.Title>
              <Dialog.Description id="shortcut-description">
                키보드만으로 콘솔을 움직이는 방법입니다.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label="단축키 도움말 닫기">
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <table className="shortcut-table">
            <caption className="sr-only">콘솔 단축키 목록</caption>
            <thead>
              <tr>
                <th scope="col">키</th>
                <th scope="col">동작</th>
              </tr>
            </thead>
            <tbody>
              {shortcuts.map((shortcut) => (
                <tr key={shortcut.what}>
                  <td>
                    {shortcut.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </td>
                  <td>{shortcut.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="shortcut-tips">
            {paletteTips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
