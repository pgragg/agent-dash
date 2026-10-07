import { useState } from "react";

import { clampWidth, DEFAULT_WIDTH } from "./viewWidth.ts";

/** The ticket view's width: the workspace column on the queue, and the drawer on the kanban. */
const WIDTH_KEY = "agent-dash:view-width";

export interface ViewWidth {
  width: number;
  setWidth: (px: number) => void;
  full: boolean;
  setFull: (full: boolean) => void;
}

export function useViewWidth(): ViewWidth {
  const [width, setW] = useState(() => clampWidth(Number(localStorage.getItem(WIDTH_KEY) ?? DEFAULT_WIDTH), Infinity));
  // Full screen is for the moment, so a reload gives the normal board back.
  const [full, setFull] = useState(false);
  return {
    width,
    setWidth: (px) => {
      setW(px);
      localStorage.setItem(WIDTH_KEY, String(px));
    },
    full,
    setFull,
  };
}

/**
 * A grip on one edge of the ticket view. `scale` is 2 for a centered column, because each edge moves half the change.
 * A double-click puts back the default width.
 */
export function ResizeHandle({ side, scale, view, max }: { side: "left" | "right"; scale: number; view: ViewWidth; max: () => number }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = view.width;
    document.body.classList.add("resizing");
    const onMove = (m: PointerEvent) => {
      const dx = (m.clientX - startX) * (side === "right" ? 1 : -1);
      view.setWidth(clampWidth(start + dx * scale, max()));
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  };
  return (
    <div
      className={`resize-grip ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to change the ticket view's width"
      title="Drag to change the width. Double-click: default width."
      onPointerDown={onPointerDown}
      onDoubleClick={() => view.setWidth(DEFAULT_WIDTH)}
    />
  );
}

export function FullScreenButton({ view }: { view: ViewWidth }) {
  return (
    <button className="btn ghost small" onClick={() => view.setFull(!view.full)} title={view.full ? "Leave full screen (F or Esc)" : "Show the ticket view across the full window (F)"}>
      {view.full ? "Exit full screen" : "Full screen"} <kbd>F</kbd>
    </button>
  );
}
