export const DEFAULT_WIDTH = 860;
export const MIN_WIDTH = 480;

/** Keep the ticket view readable and on the screen. A stored value that is not a number gives the default. */
export function clampWidth(px: number, max: number): number {
  if (!Number.isFinite(px)) return DEFAULT_WIDTH;
  return Math.round(Math.max(MIN_WIDTH, Math.min(px, Math.max(MIN_WIDTH, max))));
}
