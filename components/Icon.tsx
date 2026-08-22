/**
 * The icon set.
 *
 * Inline SVG, one stroke weight, one grid, no dependency. It replaces the run
 * of typographic stand-ins the UI had been using — ✕, ↑, ↓, ▶, ❚❚, ↺, ●, ◐ —
 * which rendered at a different size, weight and baseline in every font on
 * every platform, and which a screen reader reads out as the character rather
 * than as the action.
 *
 * Icons here are always decorative: `aria-hidden`, no focusable node. Anything
 * icon-only that can be clicked carries its own `aria-label`, so the name of
 * the control never depends on the glyph.
 */

export type IconName =
  | 'play'
  | 'pause'
  | 'restart'
  | 'record'
  | 'download'
  | 'close'
  | 'up'
  | 'down'
  | 'trash'
  | 'chevron-right'
  | 'arrow-right'
  | 'alert'
  | 'error'
  | 'info'
  | 'check'
  | 'dot'
  | 'loading';

export type IconProps = {
  name: IconName;
  /** Edge length in px. 16 suits a 26px icon button and a 30px text button. */
  size?: number;
};

/* Every path is drawn on a 16x16 grid so the optical weight matches across the
   set, and scaled by the viewBox rather than redrawn per size. */
const PATHS: Record<IconName, React.ReactNode> = {
  play: <path d="M5 3.4 12.6 8 5 12.6Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </>
  ),
  restart: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.6v2.6h-2.6" />
    </>
  ),
  record: <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />,
  download: (
    <>
      <path d="M8 2.6v7.2" />
      <path d="M5.2 7.2 8 10l2.8-2.8" />
      <path d="M3 12.2v1.2h10v-1.2" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  up: (
    <>
      <path d="M8 12.6V3.8" />
      <path d="m4.4 7.4 3.6-3.6 3.6 3.6" />
    </>
  ),
  down: (
    <>
      <path d="M8 3.4v8.8" />
      <path d="m4.4 8.6 3.6 3.6 3.6-3.6" />
    </>
  ),
  trash: (
    <>
      <path d="M3 4.4h10" />
      <path d="M6.2 4.4V3h3.6v1.4" />
      <path d="M4.4 4.4 5 13h6l.6-8.6" />
    </>
  ),
  'chevron-right': <path d="m6.2 3.6 4.4 4.4-4.4 4.4" />,
  'arrow-right': (
    <>
      <path d="M3 8h10" />
      <path d="m9.2 4.2 3.8 3.8-3.8 3.8" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.4 14.6 13.6H1.4Z" />
      <path d="M8 6.6v2.8" />
      <path d="M8 11.4h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8v3.6" />
      <path d="M8 11h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.4v3.8" />
      <path d="M8 5h.01" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.8" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />,
  loading: (
    <>
      <circle cx="8" cy="8" r="5.4" opacity="0.3" />
      <path d="M8 2.6a5.4 5.4 0 0 1 5.4 5.4" />
    </>
  ),
};

export function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
