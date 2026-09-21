/**
 * The left pane: a CodeMirror 6 editor bound to the project's script, with live diagnostics from
 * the in-browser TS Language Service worker (`../ts-worker/client.ts`) -- `docs/typescript-
 * rewrite.md`'s "Editor" stack row and the original ask this whole phase exists for ("Inside the
 * web server we have on the left side CodeMirror editor and on the right side the rendered
 * result").
 *
 * The CodeMirror `EditorView` is created exactly once (an empty dependency array below) and
 * mutated imperatively thereafter -- recreating it on every `value` prop change would discard the
 * user's cursor/selection/undo history on every keystroke, since `onChange` below is itself what
 * drives `value` back up through the parent. External content replacement (the conflict banner's
 * "Reload", or the initial script load) goes through the second effect, which only dispatches a
 * document-replacing transaction when `value` genuinely differs from the live document.
 */

import { useEffect, useRef, type JSX } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";

import type { TsWorkerClient } from "../ts-worker/client.js";
import type { DiagnosticSeverity } from "../ts-worker/protocol.js";

function toCmSeverity(severity: DiagnosticSeverity): CmDiagnostic["severity"] {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  tsClient: TsWorkerClient;
}

export function Editor({ value, onChange, tsClient }: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        javascript({ typescript: true }),
        lintGutter(),
        linter(
          async (view) => {
            const diagnostics = await tsClient.checkScript(view.state.doc.toString());
            const length = view.state.doc.length;
            const results: CmDiagnostic[] = [];
            for (const d of diagnostics) {
              const from = Math.min(d.start, length);
              const to = Math.min(d.start + d.length, length);
              results.push({
                from,
                to: to > from ? to : from,
                severity: toCmSeverity(d.severity),
                message: d.message,
              });
            }
            return results;
          },
          { delay: 300 },
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally empty: see this file's top comment for why the view is built once.
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={containerRef} className="editor-container" />;
}
