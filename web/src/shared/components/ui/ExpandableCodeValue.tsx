import { useId, useState } from "react";
import { Button } from "./Button";

const previewLimit = 2048;

/** Receives already-redacted text. Large values enter the DOM only on explicit expansion. */
export function ExpandableCodeValue({ text, label }: { text: string; label: string }) {
  const id = useId();
  const [selection, setSelection] = useState({ text, expanded: false });
  const expanded = selection.text === text && selection.expanded;
  if (selection.text !== text) setSelection({ text, expanded: false });
  const long = text.length > previewLimit;
  // Keep a UTF-16 surrogate pair together at the preview boundary.
  const end = /[\uD800-\uDBFF]/u.test(text.charAt(previewLimit - 1)) ? previewLimit - 1 : previewLimit;
  const preview = long && !expanded;
  return (
    <div>
      <pre id={id} tabIndex={0} aria-label={label} aria-describedby={preview ? id + "-note" : undefined}>
        {preview ? text.slice(0, end) : text}
      </pre>
      {preview ? <p id={id + "-note"}>긴 값의 앞부분만 표시하고 있습니다.</p> : null}
      {long ? (
        <Button
          size="small"
          aria-controls={id}
          aria-expanded={expanded}
          aria-label={label + (expanded ? " 접기" : " 전체 펼치기")}
          onClick={() => setSelection({ text, expanded: !expanded })}
        >
          {expanded ? "접기" : "전체 펼치기"}
        </Button>
      ) : null}
    </div>
  );
}
