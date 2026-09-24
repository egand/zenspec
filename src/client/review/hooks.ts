import { useEffect, useRef } from "preact/hooks";

/** Scrolls the element into view when it becomes active (e.g. its highlight was clicked). */
export function useScrollWhenActive<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [active]);
  return ref;
}
