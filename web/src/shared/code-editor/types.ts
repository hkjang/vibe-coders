export type CodeLanguage = "json" | "sql" | "prompt";

export interface CodeEditorHandle {
  focus: () => void;
}

export interface CodeEditorProps {
  id: string;
  label: string;
  language: CodeLanguage;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  rows?: number;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
}
