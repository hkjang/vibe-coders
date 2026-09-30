import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { streamChatTest } from "./chat-stream";
import type { ChatAccess } from "./use-chat-access";
import type { ChatTestRunBody } from "@/shared/api/domains/gateway";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  pending?: boolean;
  failed?: boolean;
  stopped?: boolean;
}
type Messages = ReadonlyArray<{ role: string; content: string }>;
type Flight = { controller: AbortController; answerId: string };
let sequence = 0;
const turnId = () => `chat-turn-${++sequence}`;

/** Owns only a single pane's local stream; it cannot undo a server-side call. */
export function useChatRun(access: ChatAccess, requestBody: (messages: Messages) => ChatTestRunBody) {
  const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const [headers, setHeaders] = useState<Readonly<Record<string, string>>>({});
  const [usage, setUsage] = useState<{ prompt?: number; completion?: number; total?: number }>({});
  const flight = useRef<Flight | undefined>(undefined);
  const mounted = useRef(false);
  const latest = useRef({ requestBody, turns });
  useLayoutEffect(() => {
    latest.current = { requestBody, turns };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = flight.current;
      flight.current = undefined;
      active?.controller.abort();
    };
  }, []);
  // Return admission synchronously so rejected/duplicate follow-ups keep input.
  const send = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (trimmed === "" || flight.current) return false;
      let body: ChatTestRunBody;
      try {
        access.write.assertCurrent();
        const history = latest.current.turns
          .filter((turn) => !turn.failed && turn.content !== "")
          .map((turn) => ({ role: turn.role, content: turn.content }));
        body = latest.current.requestBody([...history, { role: "user", content: trimmed }]);
        access.write.assertCurrent();
      } catch (cause) {
        if (mounted.current && access.isCurrent())
          setError({ message: safeAppErrorMessage(cause, "모델 호출을 시작할 수 없습니다.") });
        return false;
      }
      const active: Flight = { controller: new AbortController(), answerId: turnId() };
      flight.current = active;
      const owned = () => mounted.current && access.isCurrent() && flight.current === active;
      const patch = (update: (turn: ChatTurn) => ChatTurn) => {
        if (owned())
          setTurns((previous) => previous.map((turn) => (turn.id === active.answerId ? update(turn) : turn)));
      };
      setError(undefined);
      setHeaders({});
      setUsage({});
      setStreaming(true);
      setTurns((previous) => [
        ...previous,
        { id: turnId(), role: "user", content: trimmed },
        { id: active.answerId, role: "assistant", content: "", pending: true },
      ]);
      void (async () => {
        try {
          const outcome = await streamChatTest(
            body,
            {
              onContent: (delta) => patch((turn) => ({ ...turn, content: turn.content + delta })),
              onReasoning: (delta) =>
                patch((turn) => ({ ...turn, reasoning: (turn.reasoning ?? "") + delta })),
              onUsage: (value) => {
                if (owned())
                  setUsage({
                    prompt: value.promptTokens,
                    completion: value.completionTokens,
                    total: value.totalTokens,
                  });
              },
              onHeaders: (value) => {
                if (owned()) setHeaders(value);
              },
            },
            active.controller.signal,
          );
          patch((turn) => ({ ...turn, content: outcome.content || turn.content, pending: false }));
        } catch (cause) {
          if (!owned()) return;
          patch((turn) => ({ ...turn, pending: false, failed: true }));
          if (!(isAppError(cause) && cause.kind === "aborted"))
            setError({
              message: safeAppErrorMessage(cause, "모델 호출에 실패했습니다."),
              requestId: isAppError(cause) ? cause.requestId : undefined,
            });
        } finally {
          if (owned()) {
            flight.current = undefined;
            setStreaming(false);
          }
        }
      })();
      return true;
    },
    [access],
  );
  const stop = useCallback(() => {
    const active = flight.current;
    if (!active || !mounted.current || !access.isCurrent()) return;
    flight.current = undefined;
    active.controller.abort();
    setStreaming(false);
    setTurns((previous) =>
      previous.map((turn) =>
        turn.id === active.answerId ? { ...turn, pending: false, failed: true, stopped: true } : turn,
      ),
    );
  }, [access]);
  const clear = () => {
    if (flight.current || !access.isCurrent()) return;
    setTurns([]);
    setUsage({});
    setHeaders({});
    setError(undefined);
  };
  return { turns, streaming, error, headers, usage, send, stop, clear };
}
