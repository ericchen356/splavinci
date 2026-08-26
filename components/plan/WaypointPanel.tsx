'use client';

/**
 * The per-waypoint technique panel.
 *
 * Auto and Manual are a toggle, not two ends of a slider. Under a blend the
 * duration you typed was not the duration you got, and shot type snapped at
 * the midpoint of a control that looked continuous. Here the panel shows
 * exactly one resolved shot.
 *
 * Manual parameters are not rendered at all in auto mode rather than shown
 * disabled: a greyed-out control still implies the value matters, and in auto
 * mode it does not. Switching to Manual seeds them from whatever auto just
 * resolved, so control is taken over the shot on screen rather than a default.
 *
 * The amplitude slider applies in both modes, because scaling a shot is a
 * matter of degree even when you are happy to let the system pick the shot -
 * but what it scales is named per shot, and shots it does nothing for do not
 * show it. See MAGNITUDE.
 *
 * EVERY NUMBER HERE IS ALSO TYPEABLE
 * A slider answers "a bit longer" and cannot answer "4.25 seconds", which is
 * the question you actually have once a cut is timed against something. So each
 * numeric quantity is a slider paired with a field showing the same number -
 * see NumberField in AimDial.tsx for why the field commits on blur and Enter
 * rather than per keystroke.
 *
 * WHEN THE COLLIDER IS WRONG
 * The generator shrinks a shot that would clip and, failing that, holds. The
 * collider is a reconstruction of the room and not a survey of it, so that
 * verdict is sometimes about a wall that is not there - and until there was an
 * override, the only way past it was to move the waypoint, which means changing
 * the frame in order to argue with the mesh. `ignoreWalls` is that override, and
 * it is offered exactly where the bad news is delivered.
 *
 * WHICH SHOT THE CONTROLS DESCRIBE
 * `resolveShot` runs before the generator measures the shot against the walls,
 * so on its own it is a proposal, not a report: `fitShotToRoom` may shrink the
 * move, or - where even a motionless camera clips - hold instead. So the SHAPE
 * of the controls follows the GENERATED shot - which handles the dial has,
 * which quantity the slider names - because that is the shot that will actually
 * be performed. Their VALUES stay on the live resolution and on the waypoint
 * itself: a dial reporting a path generated before the current edit would not
 * respond to being dragged.
 *
 * The panel does not restate the shot and its length in prose. Both screens
 * already print them next to every waypoint - the running order on /plan, the
 * stop chips on /review - and a third copy inside the controls that set them
 * was the largest block of text on the card saying the least.
 *
 * WHERE THE FACING COMES FROM
 * The dial opens on the bearing the waypoint was CAPTURED at, not on one the
 * generator inferred - a waypoint is a frame the user framed, and the shot is
 * built to open on it. So `Auto` here means "the way I was pointing when I
 * pressed the key", and Reset goes back to that rather than to a guess.
 *
 * Screen-agnostic on purpose: the review screen reopens this same panel from
 * its technique label, and both screens hand the generated shot in rather than
 * having the panel reach into a store.
 */

import { useEffect, useState } from 'react';
import { AimDial, NumberField } from './AimDial';
import { Icon } from '@/components/Icon';
import {
  EMPHASIS_RANGE,
  SHOT_TYPES,
  type PathStyle,
  type ShotType,
  type Waypoint,
} from '@/lib/types';
import {
  resolveShot,
  type PathResult,
  type PathWarning,
  type ShotIntent,
  type WalkGrid,
} from '@/lib/path';

export type WaypointPanelProps = {
  waypoint: Waypoint;
  index: number;
  total: number;
  /** The walk grid the auto end reads the walls from. Null before it loads. */
  grid: WalkGrid | null;
  style: PathStyle;
  /**
   * The shot the generator actually emitted for this waypoint, post wall
   * validation. Null when no current path covers it, which falls the resolved
   * line back to a live preview - the best answer available at that point.
   */
  generated?: ShotIntent | null;
  /** The `shot-clipped` warning naming this waypoint, if the walls changed it. */
  clipped?: PathWarning | null;
  onChange: (patch: Partial<Omit<Waypoint, 'id'>>) => void;
  onRemove?: () => void;
  onReorder?: (delta: number) => void;
  onClose?: () => void;
  /** Extra controls (the review screen adds a "jump to this shot" button). */
  footer?: React.ReactNode;
};

/** Seconds. Matches the slider either side of the typed field, so the two
 *  controls for one number cannot disagree about what is reachable. */
const DURATION_RANGE = { min: 0.5, max: 15, step: 0.1 } as const;

/**
 * What emphasis scales, per shot - because it is not one quantity.
 *
 * The slider drives a single number, but that number lands on an orbit's
 * radius, a rise's height and a dolly's length, and the one label they shared
 * ("Move size") could only describe them by listing them. Naming the quantity
 * per shot is the whole point of the table; keeping it a table rather than a
 * run of conditionals in the JSX is what keeps the seven answers in one place.
 *
 * Pan and hold hide it rather than grey it out, for the reason the manual
 * controls are hidden in auto mode: a disabled control still implies its value
 * matters. A pan's amplitude is its arc, which the dial above already owns, and
 * a hold has no amplitude at all - measured inert at every setting.
 */
const MAGNITUDE: Record<ShotType, { showMagnitude: boolean; label: string }> = {
  orbit: { showMagnitude: true, label: 'Radius' },
  'push-in': { showMagnitude: true, label: 'Distance' },
  'pull-back': { showMagnitude: true, label: 'Distance' },
  rise: { showMagnitude: true, label: 'Height' },
  'dolly-through': { showMagnitude: true, label: 'Length' },
  pan: { showMagnitude: false, label: '' },
  hold: { showMagnitude: false, label: '' },
};

export function WaypointPanel({
  waypoint, index, total, grid, style, generated, clipped,
  onChange, onRemove, onReorder, onClose, footer,
}: WaypointPanelProps) {
  // The waypoint as it stands right now. Every control edits this.
  const preview = resolveShot(waypoint, grid, style);
  const shown = generated ?? preview;
  const wallFit = generated?.wallFit ?? 'clear';

  /* THE WALL OVERRIDE HAS TO OUTLIVE THE NEWS THAT PROMPTED IT.
   *
   * `generated` is withheld the moment the plan is edited - correct, because a
   * shot from before the edit is not a report about the plan as it stands. But
   * toggling this very control IS an edit, so a control shown only while a
   * clip is currently reported would disappear on its own first click, leaving
   * no way to change one's mind short of regenerating. So once a waypoint's
   * shot has been reported as clipping, the escape hatch stays on screen for
   * it. Keyed by id because the panel instance is reused across selections. */
  const [offeredFor, setOfferedFor] = useState<string | null>(null);
  useEffect(() => {
    if (wallFit !== 'clear') setOfferedFor(waypoint.id);
  }, [wallFit, waypoint.id]);
  const showWallOverride = waypoint.ignoreWalls || offeredFor === waypoint.id;
  // What was asked for before the walls had their say: a manual waypoint names
  // its own shot, auto's ask is the type it inferred. Both survive the fit, so
  // this stays readable off the generated intent itself.
  const askedFor: ShotType | null = generated
    ? generated.source === 'manual' ? waypoint.shotType : generated.autoShotType
    : null;
  const replaced = generated != null && askedFor != null && generated.shotType !== askedFor;
  const manual = waypoint.mode === 'manual';
  // Only these swing; the rest just need a direction, so the dial drops its
  // second handle rather than offering an arc that would do nothing.
  const sweeps = shown.shotType === 'pan' || shown.shotType === 'orbit';
  const magnitude = MAGNITUDE[shown.shotType];

  return (
    <section className="insp" aria-label={`Waypoint ${index + 1} of ${total}`}>
      <header className="insp__head">
        <span className="insp__step">{index + 1}</span>
        <h3 className="insp__title">Waypoint</h3>
        <span className="insp__count">of {total}</span>
        <div className="insp__head-actions">
          {onReorder && (
            <>
              <button
                type="button"
                className="icon-btn"
                title="Move earlier"
                aria-label="Move this waypoint earlier"
                disabled={index === 0}
                onClick={() => onReorder(-1)}
              >
                <Icon name="up" />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Move later"
                aria-label="Move this waypoint later"
                disabled={index === total - 1}
                onClick={() => onReorder(1)}
              >
                <Icon name="down" />
              </button>
            </>
          )}
          {/* Delete is the header control, because closing a panel that is only
              open because something is selected is not an action worth a button
              - clicking anywhere else already does it. Where the host screen
              has no delete to offer (review reopens this panel read-mostly),
              the close affordance stays rather than leaving a dead corner. */}
          {onRemove ? (
            <button
              type="button"
              className="icon-btn insp__delete"
              title="Delete this waypoint"
              aria-label={`Delete waypoint ${index + 1}`}
              onClick={() => {
                onRemove();
                onClose?.();
              }}
            >
              <Icon name="trash" />
            </button>
          ) : (
            onClose && (
              <button
                type="button"
                className="icon-btn"
                title="Close"
                aria-label="Close this panel"
                onClick={onClose}
              >
                <Icon name="close" />
              </button>
            )
          )}
        </div>
      </header>

      {/* ---- who decides ---- */}
      <div className="insp__field">
        <div className="insp__label">
          {/* The reason auto gave, as a tooltip. It used to head the panel as a
              line of prose repeating the shot and its length, which the running
              order already prints beside every waypoint on both screens. */}
          <span className="insp__label-name" title={shown.reason}>Shot</span>
        </div>
        <div className="insp__choices" role="group" aria-label="Who picks this shot">
          <button
            type="button"
            className="insp__choice"
            aria-pressed={!manual}
            onClick={() => onChange({ mode: 'auto' })}
          >
            Auto
          </button>
          <button
            type="button"
            className="insp__choice"
            aria-pressed={manual}
            // Seed the manual values from what auto just chose, so switching
            // starts from the shot on screen instead of a stale default.
            onClick={() =>
              onChange({
                mode: 'manual',
                shotType: preview.shotType,
                duration: Number(preview.duration.toFixed(1)),
              })
            }
          >
            Manual
          </button>
        </div>
      </div>

      {/* ---- manual parameters, shown only when they apply ---- */}
      {manual && (
        <>
          <div className="insp__field">
            <div className="insp__label">
              <span className="insp__label-name">Type</span>
              <span className="insp__label-note">auto suggests {preview.autoShotType}</span>
            </div>
            <div className="insp__choices" role="group" aria-label="Shot type">
              {SHOT_TYPES.map((shot: ShotType) => (
                <button
                  key={shot}
                  type="button"
                  className="insp__choice"
                  aria-pressed={waypoint.shotType === shot}
                  onClick={() => onChange({ shotType: shot })}
                >
                  {shot}
                </button>
              ))}
            </div>
          </div>

          <div className="insp__field">
            <NumberField
              label="Duration"
              value={waypoint.duration}
              min={DURATION_RANGE.min}
              max={DURATION_RANGE.max}
              step={DURATION_RANGE.step}
              decimals={2}
              unit="s"
              onCommit={(duration) => onChange({ duration })}
            />
            <input
              className="range"
              type="range"
              aria-label="Duration"
              min={DURATION_RANGE.min}
              max={DURATION_RANGE.max}
              step={DURATION_RANGE.step}
              value={waypoint.duration}
              onChange={(e) => onChange({ duration: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      {/* ---- the escape hatch, where the collider changed the shot ----
             No explanation, and no status line: the row only exists on a
             waypoint whose shot clips, so its presence IS the news. What it
             cannot say for itself is which way round it currently is, and the
             note carries that. */}
      {showWallOverride && (
        <div className="insp__field">
          <div className="insp__label">
            <span
              className="insp__label-name"
              title={clipped?.message ?? 'This shot passes through the collision mesh.'}
            >
              Walls
            </span>
            <span className="insp__label-note">
              {replaced ? `clips — ${shown.shotType} instead` : 'clips'}
            </span>
          </div>
          <div className="insp__choices" role="group" aria-label="Where this shot clips">
            <button
              type="button"
              className="insp__choice"
              aria-pressed={!waypoint.ignoreWalls}
              onClick={() => onChange({ ignoreWalls: false })}
            >
              Fit
            </button>
            <button
              type="button"
              className="insp__choice"
              aria-pressed={waypoint.ignoreWalls}
              onClick={() => onChange({ ignoreWalls: true })}
            >
              Ignore
            </button>
          </div>
        </div>
      )}

      {/* ---- where the shot points ---- */}
      <div className="insp__field">
        <div className="insp__label">
          <span className="insp__label-name">{sweeps ? 'Sweep' : 'Facing'}</span>
          <span className="insp__label-note">
            {preview.aimExplicit ? 'set by you' : 'as captured'}
          </span>
        </div>
        <AimDial
          aim={preview.aim}
          sweeps={sweeps}
          explicit={preview.aimExplicit}
          onChange={(aim) => onChange({ aim })}
          onReset={() => onChange({ aim: null })}
        />
      </div>

      {/* ---- amplitude, named for what this shot actually scales ---- */}
      {magnitude.showMagnitude && (
        <div className="insp__field">
          {/* Typed and shown as a percentage, because that is what it is: a
              multiplier on the style's own amplitude, not a distance in metres
              the panel could not honestly quote. */}
          <NumberField
            label={magnitude.label}
            note={Math.abs(waypoint.emphasis - 1) < 0.01 ? 'style default' : undefined}
            title={`${magnitude.label} of this ${shown.shotType}, as a share of the style's own.`}
            value={waypoint.emphasis * 100}
            min={EMPHASIS_RANGE.min * 100}
            max={EMPHASIS_RANGE.max * 100}
            step={EMPHASIS_RANGE.step * 100}
            decimals={1}
            unit="%"
            onCommit={(percent) => onChange({ emphasis: percent / 100 })}
          />
          <input
            className="range"
            type="range"
            aria-label={magnitude.label}
            min={EMPHASIS_RANGE.min}
            max={EMPHASIS_RANGE.max}
            step={EMPHASIS_RANGE.step}
            value={waypoint.emphasis}
            onChange={(e) => onChange({ emphasis: Number(e.target.value) })}
          />
        </div>
      )}

      {footer && <div className="insp__footer">{footer}</div>}
    </section>
  );
}

/**
 * The generator's own account of one waypoint's shot, ready for the two props
 * above. Both screens feed the panel through this, so neither has to know how
 * a clipped shot is reported.
 *
 * `current` is false once the plan has been edited since generating: the shot
 * in `path` then describes a plan that no longer exists, and reporting it as
 * what the camera will do would be the same lie in the other direction.
 */
export function generatedShotFor(
  path: PathResult | null,
  waypointId: string | null,
  current: boolean,
): { intent: ShotIntent | null; clipped: PathWarning | null } {
  if (!path || !waypointId || !current) return { intent: null, clipped: null };
  const intent = path.shots.find((s) => s.waypointId === waypointId) ?? null;
  if (!intent) return { intent: null, clipped: null };
  const clipped =
    path.warnings.find(
      (w) => w.code === 'shot-clipped' && w.waypointIds.includes(waypointId),
    ) ?? null;
  return { intent, clipped };
}
