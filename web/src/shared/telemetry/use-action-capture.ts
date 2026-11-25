import { useLayoutEffect, useRef } from "react";
import { captureAction, type ActionSelection } from "./action-channel";

/** Each submission keeps the mounted generation that admitted its observation. */
export function useActionCapture() {
  const lifetime = useRef({ active: false, generation: 0 });
  useLayoutEffect(() => {
    const owner = lifetime.current;
    owner.active = true;
    owner.generation++;
    return () => {
      owner.active = false;
      owner.generation++;
    };
  }, []);
  return <Variables>(
    selection: ActionSelection<Variables>,
    variables: Variables,
    ownsResult?: Parameters<typeof captureAction>[2],
  ) => {
    const generation = lifetime.current.generation;
    return captureAction(
      selection,
      variables,
      () => lifetime.current.active && lifetime.current.generation === generation && ownsResult?.() !== false,
    );
  };
}
