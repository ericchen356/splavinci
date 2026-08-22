'use client';

/**
 * The dual-view placement screen: a full 3D viewport with a mini-map in the
 * corner.
 *
 * Both views are projections of ONE waypoint list in the plan store. A click in
 * either drops into the same array and both re-render from it, so they cannot
 * disagree - there is no sync step because there is nothing to sync.
 *
 * Pathfinding is not implemented here. This screen collects intent and calls
 * into lib/path, then draws whatever comes back.
 *
 * WHICH CAPTURE IS OPEN IS NOT DECIDED HERE
 * The capture arrives in the query string and is not switchable on this screen.
 * Choosing one is a library act - you are picking which room to work on - and
 * doing it from inside the editor meant a control that silently discarded the
 * waypoints you had just placed. The list on the home page owns that choice.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import Link from 'next/link';
import {
  CAMERA_BODY_RADIUS,
  CameraPresetDriver,
  CameraRig,
  CameraTracker,
  RoomScene,
  derivePresets,
  isDrag,
  type CameraPose,
} from '@/components/scene';
import { MiniMap } from '@/components/plan/MiniMap';
import { PlanOverlay } from '@/components/plan/PlanOverlay';
import { WaypointPanel, generatedShotFor } from '@/components/plan/WaypointPanel';
import { shotPreviewPoints } from '@/components/plan/shotPreview';
import type { WaypointAim } from '@/components/plan/MiniMap';
import { useRoomAssets } from '@/lib/scene';
import {
  cellIndex,
  cellToWorld,
  findNearestCell,
  getWalkGrid,
  resolveShot,
  reachableMask,
  resolveCameraRadius,
  worldToCell,
} from '@/lib/path';
import { ensureRendersLoaded } from '@/lib/assets';
import { usePlanStore } from '@/lib/plan/planStore';
import { PATH_STYLES, type PathStyle, type Vec3 } from '@/lib/types';

/* The style ids are camelCase because they are keys; the buttons were
   rendering them raw, so one of the four read "realEstate". */
const STYLE_LABEL: Record<PathStyle, string> = {
  cozy: 'Cozy',
  realEstate: 'Real estate',
  cinematic: 'Cinematic',
  quick: 'Quick',
};

const STYLE_BLURB: Record<PathStyle, string> = {
  cozy: 'slow, lingering',
  realEstate: 'brisk and even',
  cinematic: 'slowest, biggest moves',
  quick: 'fast tour, short shots',
};

/** How long the route takes to draw itself in, once. */
const DRAW_MS = 780;

/**
 * The route, revealed from its start rather than appearing whole.
 *
 * A finished path landing in one frame says nothing about which end is the
 * beginning or which way round the room it runs - the two questions everyone
 * asks first. Tracing it answers both before anyone has to look for a marker,
 * and it is the only moment on this screen where the plan is legible as a
 * sequence rather than as a shape.
 *
 * Done by slicing the polyline here rather than animating inside the map and
 * the 3D overlay, so both views trace in step without either of them knowing
 * an animation is happening.
 */
function useDrawnPath(polyline: Vec3[]): Vec3[] {
  const [shown, setShown] = useState(polyline.length);
  const previous = useRef<Vec3[] | null>(null);

  useEffect(() => {
    // Identity, not length: regenerating after an edit usually lands on a
    // path the same length as the last one, and comparing lengths would skip
    // the draw exactly when the user most wants to see what changed.
    if (previous.current === polyline) return;
    previous.current = polyline;

    if (polyline.length < 2) {
      setShown(polyline.length);
      return;
    }
    let raf = 0;
    let start = 0;
    const step = (now: number) => {
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / DRAW_MS);
      // Eased out: the line decelerates into its final point, which reads as
      // arriving somewhere rather than as running out of road.
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.max(2, Math.round(eased * polyline.length)));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [polyline]);

  return useMemo(
    () => (shown >= polyline.length ? polyline : polyline.slice(0, shown)),
    [polyline, shown],
  );
}

export default function PlanPage() {
  const [showSplat, setShowSplat] = useState(true);
  const assets = useRoomAssets();
  const resetPlan = usePlanStore((s) => s.resetPlan);
  const {
    waypoints, selectedId, settings, path, generating, generateError, dirty,
    addWaypoint, moveWaypoint, updateWaypoint, removeWaypoint, reorderWaypoint,
    clearWaypoints, select, setStyle, generate,
  } = usePlanStore();

  const [presetNonce, setPresetNonce] = useState(0);
  const [pose, setPose] = useState<CameraPose | null>(null);

  /* Read straight off the location rather than through useSearchParams, which
     would force this statically-rendered route under a Suspense boundary for a
     value only the browser ever has. */
  const switchAssetSet = assets.switchAssetSet;
  const openCaptureId = assets.assetSetId;
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('capture');
    if (!wanted || wanted === openCaptureId) return;
    let live = true;
    /* Await the registry before resolving the id. Arriving here by clicking a
       row on the library page works without this, because that page has
       already registered what it listed - but a hard reload or a pasted link
       lands with only the built-in captures known, and a generated id would
       silently fall back to the default room with nothing on screen saying
       why. The call is memoised, so paying for it here costs one request. */
    void ensureRendersLoaded().then(() => {
      if (!live) return;
      /* The plan is about the room it was drawn in. Waypoints are world
         coordinates, so carrying them into a different capture puts them at
         those same coordinates in a building with different walls - which is
         not the plan the user made, and is usually inside something. The nav
         asks before discarding a plan; this is the backstop for arriving here
         by a route that did not go through it. */
      resetPlan();
      switchAssetSet(wanted);
    });
    return () => {
      live = false;
    };
    // Only on arrival: re-running this on every id change would fight the
    // store the moment anything else set a capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grid = useMemo(
    () => (assets.colliderData ? getWalkGrid(assets.colliderData) : null),
    [assets.colliderData],
  );
  const selected = waypoints.find((w) => w.id === selectedId) ?? null;
  const selectedIndex = waypoints.findIndex((w) => w.id === selectedId);

  // Framed from the capture's own walkable space: values tuned to the sample
  // flat bury the camera in the terrain of a 30 x 37 m outdoor capture, and the
  // collider's raw extents are mostly empty margin around the real content.
  const presets = useMemo(
    () => derivePresets(assets.roomBounds, assets.floor.baseY, grid),
    [assets.roomBounds, assets.floor, grid],
  );
  /* Eye level, always. The other framings were a row of buttons that moved a
     camera the user can already fly, and every one of them looked at the room
     from somewhere the finished video never goes. */
  const preset = presets.find((p) => p.id === 'interior') ?? presets[0];

  // The <Canvas> camera prop is read once, at mount, while the collider is
  // still loading - so re-frame when it lands or the capture changes.
  useEffect(() => {
    if (assets.roomBounds) setPresetNonce((n) => n + 1);
  }, [assets.roomBounds, assets.assetSetId]);

  // A 3 m/s walk suits a flat; crossing a 37 m capture at it does not.
  const flySpeed = useMemo(() => {
    const b = assets.roomBounds;
    if (!b) return 3.2;
    return Math.max(3.2, Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.15);
  }, [assets.roomBounds]);

  /* The camera's effective clearance, and the space it can actually reach at
     that clearance. Both the map and waypoint placement need it: a waypoint
     dropped in a pocket the camera cannot enter is not a plan, it is an error
     message waiting to happen. */
  const camera = useMemo(() => {
    if (!grid) return null;
    const resolved = resolveCameraRadius(grid, CAMERA_BODY_RADIUS);
    return { ...resolved, reach: reachableMask(grid, resolved.radius) };
  }, [grid]);

  /* Pull a point into reachable space rather than refusing the click.
     Refusing gives the user nothing to act on - the gap that cut the pocket off
     is often a few centimetres and invisible at map scale - whereas landing on
     the nearest spot the camera can occupy is almost always what was meant. */
  const snapToReachable = useCallback(
    (x: number, z: number): { x: number; z: number; moved: boolean } => {
      if (!grid || !camera) return { x, z, moved: false };
      const { col, row } = worldToCell(grid, x, z);
      if (camera.reach.mask[cellIndex(grid, col, row)]) return { x, z, moved: false };
      const near = findNearestCell(grid, col, row, (c, r) =>
        camera.reach.mask[cellIndex(grid, c, r)] === 1);
      if (!near) return { x, z, moved: false };
      const w = cellToWorld(grid, near.col, near.row);
      return { x: w.x, z: w.z, moved: true };
    },
    [grid, camera],
  );

  /* Both entry points funnel into the same action. The only difference is where
     y comes from: a 3D click already has a surface, a mini-map click does not. */
  const dropAt3D = useCallback(
    (point: Vec3, event: ThreeEvent<MouseEvent>) => {
      // Looking around would otherwise drop a waypoint wherever the drag
      // happened to end.
      if (isDrag(event)) return;
      const snapped = snapToReachable(point[0], point[2]);
      addWaypoint([snapped.x, assets.floorYAtOr(snapped.x, snapped.z), snapped.z]);
    },
    [addWaypoint, assets, snapToReachable],
  );

  const dropAtMap = useCallback(
    (x: number, z: number) => {
      const snapped = snapToReachable(x, z);
      addWaypoint([snapped.x, assets.floorYAtOr(snapped.x, snapped.z), snapped.z]);
    },
    [addWaypoint, assets, snapToReachable],
  );

  /* Dragging a marker keeps its id, and with it its mode, duration, emphasis
     and place in the running order - all of which delete-and-replace threw
     away. moveWaypoint pins it, so the generator rebuilds the two legs either
     side and serves the rest of the table from cache. */
  const dragOnMap = useCallback(
    (id: string, x: number, z: number) => {
      moveWaypoint(id, [x, assets.floorYAtOr(x, z), z]);
    },
    [moveWaypoint, assets],
  );

  const onGenerate = useCallback(() => {
    void generate(assets.colliderData);
  }, [generate, assets.colliderData]);

  /* Every waypoint's resolved aim, so the map can show where each shot points
     and how far it swings - the thing a bearing in a number field cannot say. */
  const aims = useMemo<WaypointAim[]>(() => {
    if (!grid) return [];
    return waypoints.map((w) => {
      const intent = resolveShot(w, grid, settings.style);
      const swings = intent.shotType === 'pan' || intent.shotType === 'orbit';
      return { id: w.id, from: intent.aim.from, sweep: swings ? intent.aim.sweep : 0 };
    });
  }, [waypoints, grid, settings.style]);

  const shotPreview = useMemo(
    () => (selectedIndex >= 0 ? shotPreviewPoints(waypoints, selectedIndex, grid, settings.style) : []),
    [waypoints, selectedIndex, grid, settings.style],
  );

  const polyline = useMemo(() => path?.polyline ?? [], [path]);
  const drawnPolyline = useDrawnPath(polyline);

  /* info is diagnostic: it explains a decision the generator made on the
     user's behalf and asks nothing of them. Rendered in the same bordered box
     as a real failure, it made every successful run look like a near miss. */
  const notices = path?.warnings.filter((w) => w.severity !== 'info') ?? [];

  /* What the generator emitted for the selected waypoint, so the panel reports
     the shot that was validated against the walls rather than the one proposed
     before they were consulted. Nothing while `dirty`: this screen does not
     regenerate on edit, so after one the last path is about a different plan. */
  const selectedShot = generatedShotFor(path, selectedId, !dirty);

  return (
    <div className="plan">
      {/* ---------------- 3D viewport ---------------- */}
      <div className="plan__stage">
        <Canvas camera={{ position: preset.position, fov: 55, near: 0.05, far: 2000 }}>
          <CameraRig moveSpeed={flySpeed} />
          <CameraPresetDriver preset={preset} nonce={presetNonce} />
          <CameraTracker onChange={setPose} />
          <RoomScene onFloorClick={dropAt3D} showSplat={showSplat}>
            <PlanOverlay
              waypoints={waypoints}
              selectedId={selectedId}
              polyline={drawnPolyline}
              shotPreview={shotPreview}
              aims={aims}
              onSelect={select}
            />
          </RoomScene>
        </Canvas>

        {/* The map, and directly beneath it the two things you can turn off in
            the render. They belong here rather than in the sidebar because
            both are answers to "what am I looking at", which is a question
            about this corner of the screen. */}
        <div className="plan__corner">
          <MiniMap
            grid={grid}
            cameraRadius={camera?.radius}
            waypoints={waypoints}
            selectedId={selectedId}
            aims={aims}
            polyline={drawnPolyline}
            shotPreview={shotPreview}
            camera={pose}
            onPick={dropAtMap}
            onWaypointPick={select}
            onWaypointDrag={dragOnMap}
            height={230}
          />
          <div className="plan__layers plan__over">
            <LayerToggle label="Splat cloud" checked={showSplat} onChange={setShowSplat} />
            <LayerToggle
              label="Collider wireframe"
              checked={assets.showCollider}
              onChange={assets.setShowCollider}
            />
          </div>
        </div>

        {/* The running order, against the render rather than in the sidebar:
            it is a reading of what is in front of you, and in the panel it
            competed for height with the controls that change it. */}
        {waypoints.length > 0 && (
          <div className="plan__order plan__over">
            <div className="plan__order-head">Waypoints</div>
            {waypoints.map((w, i) => {
              const shot = path?.shots.find((s) => s.waypointId === w.id);
              return (
                <button
                  key={w.id}
                  type="button"
                  className="plan__order-item"
                  aria-current={w.id === selectedId}
                  onClick={() => select(w.id)}
                >
                  <span className="plan__order-n">{i + 1}</span>
                  <span>{shot ? shot.shotType : 'not generated'}</span>
                  {shot && (
                    <span className="plan__order-meta">{shot.duration.toFixed(1)}s</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {!assets.settled && (
          <div className="plan__badge">
            Loading room… {Math.round(assets.progress * 100)}%
          </div>
        )}
        {assets.settled && !assets.colliderData && (
          <div className="plan__badge" data-tone="danger">
            No collider loaded — placement and pathfinding are unavailable.
          </div>
        )}
      </div>

      {/* ---------------- sidebar ---------------- */}
      <aside className="plan__side">
        <StyleMenu value={settings.style} onSelect={setStyle} />

        <div className="plan__group">
          <div className="plan__actions">
            <button
              type="button"
              className="primary"
              disabled={generating || waypoints.length < 1 || !assets.colliderData}
              onClick={onGenerate}
            >
              {generating ? 'Generating…' : 'Generate path'}
            </button>
            <button type="button" onClick={clearWaypoints} disabled={waypoints.length === 0}>
              Clear
            </button>
          </div>

          {path && (
            <>
              <div className="plan__stats">
                <span className="plan__stat-big">{path.duration.toFixed(1)}s</span>
                <span className="plan__stat-sub">{path.frames.length} frames</span>
              </div>
              <div className="plan__stat-diag">
                {path.stats.recomputedSegments} rebuilt · {path.stats.reusedSegments} reused ·{' '}
                {path.stats.generateMs} ms
              </div>
              {dirty && (
                <div className="plan__stale">Edited since this path was generated.</div>
              )}
              <Link
                href="/review"
                className="button primary plan__review"
                data-stale={dirty}
              >
                Open in review →
              </Link>
            </>
          )}
        </div>

        {(generateError || notices.length > 0) && (
          <div className="plan__notices">
            {generateError && (
              <div className="plan__note" data-severity="error">
                Generating failed: {generateError}
              </div>
            )}
            {notices.map((w, i) => (
              <div key={`${w.code}${i}`} className="plan__note" data-severity={w.severity}>
                {w.message}
              </div>
            ))}
          </div>
        )}

        {selected ? (
          <WaypointPanel
            waypoint={selected}
            index={selectedIndex}
            total={waypoints.length}
            grid={grid}
            style={settings.style}
            generated={selectedShot.intent}
            clipped={selectedShot.clipped}
            onChange={(patch) => updateWaypoint(selected.id, patch)}
            onRemove={() => removeWaypoint(selected.id)}
            onReorder={(d) => reorderWaypoint(selected.id, d)}
            onClose={() => select(null)}
          />
        ) : (
          <p className="plan__empty">
            Click the render or the map to drop a waypoint. Select one to set its
            shot.
          </p>
        )}
      </aside>
    </div>
  );
}

/* Roughly the height of the open menu. Only ever used to choose a direction,
   so an estimate is enough - being a few pixels out flips the menu upward one
   scroll position early, which nobody can see. */
const MENU_HEIGHT = 210;
/* Matches --s1, the gap the rest of the screen uses between a control and the
   thing that belongs to it. Lives here because the offset is applied to a
   measured rect in JS, not in the sheet. */
const MENU_GAP = 4;

/**
 * The four path styles behind one button.
 *
 * They were a permanent 2x2 grid, which spent a quarter of the sidebar
 * restating three choices nobody had made, and hid the one-line description of
 * each in a `title` attribute - a tooltip that never appears on touch, never
 * appears for a keyboard user, and appears a second too late for everyone
 * else. Those blurbs are the only thing on the screen that says how the styles
 * differ, so in the menu they are ordinary text next to the name.
 *
 * WHY THE MENU IS position: fixed
 * The sidebar scrolls (`overflow-y: auto`), and an absolutely-positioned menu
 * inside a scrolling box is clipped at its edge - which is exactly where a
 * four-row menu hanging off a control near the top of the panel would land.
 * Fixed takes it out of that box entirely; nothing above it here establishes a
 * containing block, and it also puts the menu over the 3D canvas without
 * depending on where the sidebar sits in the stacking order. The cost is
 * having to measure the trigger, which is what `place` does, and to keep
 * measuring while anything scrolls or resizes underneath it.
 */
function StyleMenu({
  value,
  onSelect,
}: {
  value: PathStyle;
  onSelect: (style: PathStyle) => void;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /* Which row takes focus once the menu exists. Set before the open, read
     after it, so it cannot be state - it would render one frame too late. */
  const pending = useRef(0);

  const labelId = useId();
  const buttonId = useId();
  const current = Math.max(0, PATH_STYLES.indexOf(value));

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    // Open upward when the window's bottom edge would cut the menu off and
    // there is more room the other way.
    const flip = below < MENU_HEIGHT && rect.top > below;
    setBox({
      left: rect.left,
      width: rect.width,
      top: flip ? undefined : rect.bottom + MENU_GAP,
      bottom: flip ? window.innerHeight - rect.top + MENU_GAP : undefined,
    });
  }, []);

  const openAt = useCallback(
    (index: number) => {
      pending.current = index;
      place();
      setOpen(true);
    },
    [place],
  );

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[pending.current]?.focus();

    const onPointerDown = (e: PointerEvent) => {
      // The menu is a child of the wrapper in the DOM even though it paints
      // somewhere else, so one containment test covers trigger and menu both.
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture, because the sidebar scrolls rather than the window: a scroll
    // event on an inner box does not bubble to window on the bubble phase.
    const onReflow = () => place();

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, place]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = PATH_STYLES.length;
    const at = itemRefs.current.findIndex((el) => el === document.activeElement);
    const move = (to: number) => {
      e.preventDefault();
      itemRefs.current[(to + n) % n]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      /* Deliberately not prevented. Every row is tabIndex -1, so once focus is
         back on the trigger the browser's own Tab lands on whatever follows
         the control - the menu never traps and never swallows the keystroke. */
      close(true);
    } else if (e.key === 'ArrowDown') {
      move(at + 1);
    } else if (e.key === 'ArrowUp') {
      move(at - 1);
    } else if (e.key === 'Home') {
      move(0);
    } else if (e.key === 'End') {
      move(n - 1);
    }
    // Enter and Space are left to the row's own button, which fires a click.
  };

  return (
    <div className="plan__group" ref={wrapRef}>
      <div className="plan__label" id={labelId}>
        Style
      </div>
      <button
        ref={triggerRef}
        id={buttonId}
        type="button"
        className="plan__style-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        /* Both, so the name is "Style, Cinematic, slowest biggest moves":
           the group label alone drops the current value, the content alone
           drops what the value is a value of. */
        aria-labelledby={`${labelId} ${buttonId}`}
        onClick={() => (open ? close(false) : openAt(current))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openAt(current);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openAt(PATH_STYLES.length - 1);
          }
        }}
      >
        <span>{STYLE_LABEL[value]}</span>
        <span className="plan__style-hint">{STYLE_BLURB[value]}</span>
        <svg className="plan__style-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M3 4.5 6 8l3-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && box && (
        <div
          className="plan__style-menu"
          role="menu"
          aria-labelledby={labelId}
          style={{ left: box.left, width: box.width, top: box.top, bottom: box.bottom }}
          onKeyDown={onMenuKey}
        >
          {PATH_STYLES.map((s, i) => (
            <button
              key={s}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={s === value}
              tabIndex={-1}
              className="plan__style-item"
              onClick={() => {
                onSelect(s);
                close(true);
              }}
            >
              <span>{STYLE_LABEL[s]}</span>
              <span className="plan__style-blurb">{STYLE_BLURB[s]}</span>
              {/* Always rendered, only ever faded: showing it on the checked
                  row alone would move the labels of the other three. */}
              <span className="plan__style-tick" aria-hidden="true">
                ✓
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LayerToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="plan__layer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
