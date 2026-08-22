/**
 * Telling a click apart from a drag.
 *
 * A drag ends with a DOM click on whatever happens to be under the pointer, so
 * every scene-graph `onClick` also fires at the end of a look-around in fly
 * mode or an orbit sweep — which is how a screen ends up littered with
 * waypoints nobody placed. R3F hands each click event the pointer's travel
 * since pointerdown in pixels, which is all it takes to separate the two.
 */

/** Pointer travel, in pixels, still forgiven as a click rather than a drag. */
export const CLICK_SLOP_PX = 4;

export function isDrag(event: { delta: number }): boolean {
  return event.delta > CLICK_SLOP_PX;
}
