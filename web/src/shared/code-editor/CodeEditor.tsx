import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type RefAttributes,
} from "react";
import { Code2 } from "lucide-react";
import { Button } from "@/shared/components/ui/Button";
import { Textarea } from "@/shared/components/ui/Textarea";
import { editorMessages as messages } from "./messages";
import type { CodeEditorHandle, CodeEditorProps } from "./types";
import "./code-editor.css";

export interface AdvancedEditorProps extends CodeEditorProps {
  onFailure: () => void;
}
type AdvancedEditor = ComponentType<AdvancedEditorProps & RefAttributes<CodeEditorHandle>>;

/** Optional local editor assets are requested only by the explicit open button. */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const { id, label, language, value, onChange, onBlur, disabled, readOnly, rows = 6, ...control } = props;
  const [Engine, setEngine] = useState<AdvancedEditor>();
  const [advanced, setAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const basic = useRef<HTMLTextAreaElement>(null);
  const engine = useRef<CodeEditorHandle>(null);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const returnToBasic = useRef(false);
  const wasAdvanced = useRef(false);
  const composing = useRef(false);
  const activateAfterComposition = useRef(false);
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  // Bound syntax work without truncating or rejecting the caller's draft.
  const large = value.length > 1_000_000;
  const useAdvanced = advanced && !large && Engine;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
    };
  }, []);
  useImperativeHandle(ref, () => ({ focus: () => (engine.current ?? basic.current)?.focus() }), []);
  useLayoutEffect(() => {
    if (!useAdvanced && (returnToBasic.current || wasAdvanced.current)) {
      returnToBasic.current = false;
      basic.current?.focus();
    }
    wasAdvanced.current = Boolean(useAdvanced);
  }, [useAdvanced]);

  const open = async () => {
    if (loading || disabled || large) return;
    const ticket = ++attempt.current;
    setLoading(true);
    setFailed(false);
    try {
      const module = await import("./MonacoEditor");
      if (!mounted.current || attempt.current !== ticket) return;
      setEngine(() => module.MonacoEditor);
      if (
        current.current.disabled ||
        current.current.value.length > 1_000_000 ||
        basic.current?.closest("fieldset[disabled]")
      )
        return;
      if (composing.current) activateAfterComposition.current = true;
      else setAdvanced(true);
    } catch {
      if (mounted.current && attempt.current === ticket) setFailed(true);
    } finally {
      if (mounted.current && attempt.current === ticket) setLoading(false);
    }
  };
  const fallback = () => {
    returnToBasic.current = true;
    setAdvanced(false);
    setFailed(true);
  };
  return (
    <div className="code-editor" data-code-language={language}>
      <div className="code-editor-mode">
        <span>{messages.languages[language]}</span>
        <Button
          size="small"
          variant="secondary"
          disabled={disabled || loading || (!useAdvanced && large)}
          aria-label={`${label} ${useAdvanced ? messages.basic : messages.open}`}
          onClick={() => {
            if (useAdvanced) {
              returnToBasic.current = true;
              setAdvanced(false);
            } else void open();
          }}
        >
          <Code2 aria-hidden="true" /> {useAdvanced ? messages.basic : messages.open}
        </Button>
      </div>
      {useAdvanced ? (
        <Engine
          {...props}
          key={`${id}:${language}`}
          ref={engine}
          onFailure={fallback}
          onChange={(next) => {
            if (next.length > 1_000_000) {
              returnToBasic.current = true;
              setAdvanced(false);
            }
            onChange(next);
          }}
        />
      ) : (
        <Textarea
          {...control}
          ref={basic}
          id={id}
          aria-label={label}
          className="code-editor-basic"
          rows={rows}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          spellCheck={false}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            if (
              activateAfterComposition.current &&
              !current.current.disabled &&
              current.current.value.length <= 1_000_000 &&
              !basic.current?.closest("fieldset[disabled]")
            ) {
              activateAfterComposition.current = false;
              setAdvanced(true);
            }
          }}
        />
      )}
      {loading ? (
        <p role="status" className="field-description">
          {messages.loading}
        </p>
      ) : null}
      {failed ? (
        <p role="status" className="field-description">
          {messages.failed}
        </p>
      ) : null}
      {large ? <p className="field-description">{messages.large}</p> : null}
    </div>
  );
});
