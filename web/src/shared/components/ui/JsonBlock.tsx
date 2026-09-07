import { CopyButton } from "@/shared/components/ui/CopyButton";

interface JsonBlockProps {
  label: string;
  maxHeight?: number;
  value: unknown;
}

/** Read-only JSON viewer for opaque payloads (never for prompt or credential text). */
export function JsonBlock({ label, maxHeight = 320, value }: JsonBlockProps): React.JSX.Element {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return (
    <div className="json-block">
      <div className="json-block-toolbar">
        <span>{label}</span>
        <CopyButton value={text} />
      </div>
      <pre style={{ maxHeight }} tabIndex={0} aria-label={label}>
        {text}
      </pre>
    </div>
  );
}
