import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/shared/components/ui/Button";
import type { AdvancedEditorProps } from "./CodeEditor";
import { editorMessages as messages } from "./messages";
import { applyEditorTheme, monaco } from "./monaco-runtime";
import type { CodeEditorHandle } from "./types";

// Monaco 0.57's runtime supports these history options; its standalone public
// declaration omits them. Keep both histories local to the disposable widget.
const privateFindOptions: monaco.editor.IEditorFindOptions & { history: "never"; replaceHistory: "never" } = {
  history: "never",
  replaceHistory: "never",
};

/** Each opening owns and disposes one model; neither content nor search history is persisted. */
export const MonacoEditor = forwardRef<CodeEditorHandle, AdvancedEditorProps>(
  function MonacoEditor(props, ref) {
    const host = useRef<HTMLDivElement>(null);
    const current = useRef(props);
    const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
    const syncing = useRef(false);
    const [wrapping, setWrapping] = useState(true);
    const [formatting, setFormatting] = useState(false);
    const [formatError, setFormatError] = useState(false);
    const [errors, setErrors] = useState(0);
    useLayoutEffect(() => {
      current.current = props;
    });
    useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), []);
    const blocked = useCallback(
      () =>
        Boolean(
          current.current.disabled || current.current.readOnly || host.current?.closest("fieldset[disabled]"),
        ),
      [],
    );

    useLayoutEffect(() => {
      const element = host.current;
      if (!element) return;
      let instance: monaco.editor.IStandaloneCodeEditor | undefined;
      let model: monaco.editor.ITextModel | undefined;
      const disposables: monaco.IDisposable[] = [];
      const observer = new MutationObserver(() => {
        instance?.updateOptions({ readOnly: blocked(), domReadOnly: blocked() });
        applyEditorTheme();
      });
      try {
        applyEditorTheme();
        model = monaco.editor.createModel(
          current.current.value,
          current.current.language === "prompt" ? "plaintext" : current.current.language,
        );
        // Empty models otherwise inherit the host OS default (including CRLF).
        model.setEOL(
          current.current.value.includes("\r\n")
            ? monaco.editor.EndOfLineSequence.CRLF
            : monaco.editor.EndOfLineSequence.LF,
        );
        instance = monaco.editor.create(element, {
          model,
          automaticLayout: true,
          ariaLabel: current.current.label,
          ariaRequired: current.current["aria-required"],
          accessibilitySupport: "on",
          editContext: false,
          tabFocusMode: true,
          readOnly: blocked(),
          domReadOnly: blocked(),
          fontSize: 14,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
          minimap: { enabled: false },
          wordWrap: "on",
          // Prompt/SQL whitespace and pasted JSON change only by an explicit edit.
          autoIndent: "none",
          autoClosingBrackets: "never",
          autoClosingQuotes: "never",
          autoClosingComments: "never",
          autoSurround: "never",
          formatOnPaste: false,
          formatOnType: false,
          trimAutoWhitespace: false,
          scrollBeyondLastLine: false,
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: false,
          renderLineHighlight: "none",
          links: false,
          contextmenu: false,
          find: privateFindOptions,
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          hover: { enabled: "off" },
          occurrencesHighlight: "off",
          selectionHighlight: false,
          maxTokenizationLineLength: 20_000,
          tabSize: 2,
          insertSpaces: true,
          theme: "vibe-console",
        });
        editor.current = instance;
        const input = element.querySelector("textarea");
        if (input) {
          input.id = current.current.id;
          const describedBy = current.current["aria-describedby"];
          if (describedBy) input.setAttribute("aria-describedby", describedBy);
        }
        disposables.push(
          instance.onDidChangeModelContent(() => {
            if (syncing.current || !model) return;
            if (blocked()) {
              syncing.current = true;
              model.setValue(current.current.value);
              syncing.current = false;
              return;
            }
            current.current.onChange(model.getValue());
          }),
        );
        disposables.push(instance.onDidBlurEditorText(() => current.current.onBlur?.()));
        disposables.push(
          monaco.editor.onDidChangeMarkers((resources) => {
            if (
              model &&
              !model.isDisposed() &&
              resources.some((uri) => uri.toString() === model?.uri.toString())
            ) {
              setErrors(
                monaco.editor
                  .getModelMarkers({ resource: model.uri })
                  .filter((marker) => marker.severity === monaco.MarkerSeverity.Error).length,
              );
            }
          }),
        );
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLFieldSetElement)
            observer.observe(parent, { attributes: true, attributeFilter: ["disabled"] });
        }
        instance.focus();
      } catch {
        current.current.onFailure();
      }
      return () => {
        observer.disconnect();
        disposables.forEach((disposable) => disposable.dispose());
        editor.current = undefined;
        instance?.dispose();
        model?.dispose();
      };
    }, [blocked]);

    useLayoutEffect(() => {
      const instance = editor.current;
      if (!instance) return;
      instance.updateOptions({
        readOnly: blocked(),
        domReadOnly: blocked(),
        ariaLabel: props.label,
        ariaRequired: props["aria-required"],
      });
      const model = instance.getModel();
      if (model && model.getValue() !== props.value) {
        syncing.current = true;
        model.setValue(props.value);
        model.setEOL(
          props.value.includes("\r\n")
            ? monaco.editor.EndOfLineSequence.CRLF
            : monaco.editor.EndOfLineSequence.LF,
        );
        syncing.current = false;
      }
      const input = host.current?.querySelector("textarea");
      if (input) {
        input.setAttribute("aria-invalid", String(props["aria-invalid"] === true));
        if (props["aria-describedby"]) input.setAttribute("aria-describedby", props["aria-describedby"]);
        else input.removeAttribute("aria-describedby");
      }
    }, [props, blocked]);

    const action = (id: string) => {
      const instance = editor.current;
      if (!instance) return;
      instance.focus();
      instance.trigger("vibe-toolbar", id, null);
    };
    const format = async () => {
      const instance = editor.current;
      if (!instance || blocked() || formatting) return;
      setFormatting(true);
      setFormatError(false);
      try {
        await instance.getAction("editor.action.formatDocument")?.run();
      } catch {
        if (editor.current === instance) setFormatError(true);
      } finally {
        if (editor.current === instance) setFormatting(false);
      }
    };
    return (
      <div>
        <div className="code-editor-tools" role="group" aria-label={`${props.label} 편집 도구`}>
          <Button size="small" variant="secondary" onClick={() => action("actions.find")}>
            {messages.find}
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={props.disabled || props.readOnly}
            onClick={() => {
              if (!blocked()) action("undo");
            }}
          >
            {messages.undo}
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={props.disabled || props.readOnly}
            onClick={() => {
              if (!blocked()) action("redo");
            }}
          >
            {messages.redo}
          </Button>
          {props.language === "json" ? (
            <Button
              size="small"
              variant="secondary"
              disabled={props.disabled || props.readOnly || formatting}
              onClick={() => void format()}
            >
              {messages.format}
            </Button>
          ) : null}
          <Button
            size="small"
            variant="secondary"
            aria-pressed={wrapping}
            onClick={() => {
              setWrapping(!wrapping);
              editor.current?.updateOptions({ wordWrap: wrapping ? "off" : "on" });
            }}
          >
            {messages.wrap}
          </Button>
        </div>
        <div ref={host} className="code-editor-surface" data-code-editor-surface />
        <p className="field-description">{messages.help}</p>
        {errors > 0 ? (
          <p role="status" className="field-error">
            JSON 문법 오류 {errors}개
          </p>
        ) : null}
        {formatError ? (
          <p role="status" className="field-error">
            {messages.formatFailed}
          </p>
        ) : null}
      </div>
    );
  },
);
