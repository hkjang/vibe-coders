// Load the bundled Korean messages before the editor modules evaluate.
import "monaco-editor/nls/lang/ko.js";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/languages/definitions/sql/register.js";
import { jsonDefaults } from "monaco-editor/languages/features/json/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";

globalThis.MonacoEnvironment = {
  getWorker: (_moduleId, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};
// User-provided $schema values must never cause network requests.
jsonDefaults.setDiagnosticsOptions({ validate: true, enableSchemaRequest: false, allowComments: false });

export function applyEditorTheme(): void {
  const dark = document.documentElement.dataset.theme === "dark";
  const style = getComputedStyle(document.documentElement);
  // CSS minification shortens #ffffff to #fff; Monaco's token color map only
  // accepts full hexadecimal channels, including in editor background colors.
  const color = (name: string) =>
    style
      .getPropertyValue(name)
      .trim()
      .replace(
        /^#([\da-f]{3,4})$/iu,
        (_, hex: string) => `#${[...hex].map((channel) => channel + channel).join("")}`,
      );
  monaco.editor.defineTheme("vibe-console", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": color("--color-card"),
      "editor.foreground": color("--color-foreground"),
      "editorLineNumber.foreground": color("--color-muted"),
      "editor.selectionBackground": color("--color-primary-soft"),
    },
  });
  monaco.editor.setTheme("vibe-console");
}

export { monaco };
