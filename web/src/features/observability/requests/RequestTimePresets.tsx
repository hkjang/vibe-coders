import { Button } from "@/shared/components/ui/Button";
import { requestTimePresets, type RequestTimePreset } from "./request-time-presets";

export function RequestTimePresets({
  notice,
  onSelect,
}: {
  notice?: string;
  onSelect: (preset: RequestTimePreset) => void;
}): React.JSX.Element {
  return (
    <div className="request-time-presets">
      <div role="group" aria-label="기간 빠른 입력" className="request-time-preset-actions">
        <span>기간 빠른 입력</span>
        {requestTimePresets.map((preset) => (
          <Button key={preset.hours} size="small" onClick={() => onSelect(preset)}>
            {preset.label}
          </Button>
        ))}
      </div>
      <p id="request-time-preset-help">
        선택한 순간의 브라우저 시각을 기준으로 입력합니다. 끝의 Z는 UTC 시각이며, 조회를 눌러 적용하세요.
      </p>
      <div role="status" className="request-time-preset-notice">
        {notice}
      </div>
    </div>
  );
}
