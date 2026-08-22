'use client';

/**
 * The review screen.
 *
 * Everything on it is derived from the path generator's FrameEntry table: the
 * camera pose, the mini-map dot and arrow, and the technique label all come
 * from looking up the table at the current scrub time. No path logic lives
 * here - when the user edits a shot from the technique label, this screen calls
 * back into lib/path, whose segment cache rebuilds only the legs touching that
 * waypoint and reuses the rest of the table.
 *
 * The store is read through selectors, not as a whole: PlaybackCamera writes
 * `time` from inside useFrame, so a subscription to the whole store re-renders
 * this page - and every derived object it hands to the mini-map - at frame
 * rate for state it never reads.
 *
 * WHY THE CHROME IS ALL CLASSES
 * Every style on this screen lives in app/styles/review.css. The only inline
 * styles left are the ones carrying data - a segment's position along the
 * track is a number out of the path, not a design decision - and those cannot
 * be a class because there is one of them per frame of the timeline.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
/* This screen's half of the global sheet. Imported here rather than in
   app/layout.tsx beside the other partials only because five agents are
   editing that file today; move it up there when the dust settles. Order is
   safe either way - every rule in it is scoped under .review, so it outranks
   what it overrides by specificity and not by which sheet happens to land
   last. */
import { Canvas } from '@react-three/fiber';
import { AssetStatusPanel, CameraPresetDriver, RoomScene, derivePresets } from '@/components/scene';
import { MiniMap } from '@/components/plan/MiniMap';
import { WaypointPanel, generatedShotFor } from '@/components/plan/WaypointPanel';
import { PlaybackCamera } from '@/components/review/PlaybackCamera';
import { ScrubBar, timecode } from '@/components/review/ScrubBar';
import { useRoomAssets } from '@/lib/scene';
import { getWalkGrid, sampleAtTime, segmentAtTime, type PathSegmentInfo } from '@/lib/path';
import { usePlanStore } from '@/lib/plan/planStore';
import { useReviewStore } from '@/lib/review/reviewStore';
import { isRecordingSupported } from '@/lib/review/recorder';
import type { Comment, FrameEntry, Vec3 } from '@/lib/types';

/* Stable empties: a fresh [] literal per render busts every downstream memo,
   and the mini-map redraws its whole plan layer when one changes identity. */
const NO_FRAMES: readonly FrameEntry[] = [];
const NO_SEGMENTS: readonly PathSegmentInfo[] = [];
const NO_POLYLINE: readonly Vec3[] = [];

/**
 * Elements that already answer to Space themselves.
 *
 * A text field takes a space character, and a <button> fires its own click on
 * Space with no help from anyone. Either one would otherwise get the keypress
 * AND the transport toggle out of a single press - most visibly on the play
 * button, where the transport would flip twice and so appear not to respond at
 * all. Anything else with focus (the scrub bar, the page itself) leaves Space
 * unclaimed, which is where the shortcut belongs.
 */
function ownsSpaceItself(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'OPTION'].includes(el.tagName);
}

export default function ReviewPage() {
  const assets = useRoomAssets();

  const waypoints = usePlanStore((s) => s.waypoints);
  const settings = usePlanStore((s) => s.settings);
  const path = usePlanStore((s) => s.path);
  const dirty = usePlanStore((s) => s.dirty);
  const generating = usePlanStore((s) => s.generating);
  const generateError = usePlanStore((s) => s.generateError);
  const comments = usePlanStore((s) => s.comments);
  const addComment = usePlanStore((s) => s.addComment);
  const removeComment = usePlanStore((s) => s.removeComment);
  const updateWaypoint = usePlanStore((s) => s.updateWaypoint);
  const generate = usePlanStore((s) => s.generate);

  const time = useReviewStore((s) => s.time);
  const playing = useReviewStore((s) => s.playing);
  const recording = useReviewStore((s) => s.recording);
  const video = useReviewStore((s) => s.video);
  const recordError = useReviewStore((s) => s.recordError);
  const canvas = useReviewStore((s) => s.canvas);
  const draft = useReviewStore((s) => s.draft);
  const editingWaypointId = useReviewStore((s) => s.editingWaypointId);

  const pause = useReviewStore((s) => s.pause);
  const toggle = useReviewStore((s) => s.toggle);
  const seek = useReviewStore((s) => s.seek);
  const setDuration = useReviewStore((s) => s.setDuration);
  const startRecording = useReviewStore((s) => s.startRecording);
  const cancelRecording = useReviewStore((s) => s.cancelRecording);
  const releaseRecorder = useReviewStore((s) => s.releaseRecorder);
  const beginDraft = useReviewStore((s) => s.beginDraft);
  const cancelDraft = useReviewStore((s) => s.cancelDraft);
  const editWaypoint = useReviewStore((s) => s.editWaypoint);

  const [draftText, setDraftText] = useState('');

  const grid = useMemo(
    () => (assets.colliderData ? getWalkGrid(assets.colliderData) : null),
    [assets.colliderData],
  );
  // Only ever seen before a path exists - PlaybackCamera owns the camera after
  // that - but "before" is most of the time on a first visit, so it is framed
  // from the collider rather than from numbers that fit the sample flat.
  const startView = useMemo(
    () => derivePresets(assets.roomBounds, assets.floor.baseY, grid)[0],
    [assets.roomBounds, assets.floor, grid],
  );
  const [startNonce, setStartNonce] = useState(0);
  useEffect(() => {
    if (assets.roomBounds) setStartNonce((n) => n + 1);
  }, [assets.roomBounds, assets.assetSetId]);

  const frames = path?.frames ?? NO_FRAMES;
  const duration = path?.duration ?? 0;
  const pose = useMemo(() => sampleAtTime(frames, time), [frames, time]);
  const segment = useMemo(
    () => segmentAtTime(path?.segments ?? NO_SEGMENTS, time),
    [path, time],
  );
  const activeShot = path?.shots.find((s) => s.waypointId === pose?.activeWaypointId) ?? null;
  // The mini-map redraws whenever this prop changes identity, so it is derived
  // from the pose rather than rebuilt as a literal on every unrelated render.
  const mapCamera = useMemo(
    () => (pose ? { position: pose.position, lookAt: pose.lookAt } : null),
    [pose],
  );

  const editing = waypoints.find((w) => w.id === editingWaypointId) ?? null;
  const editingIndex = waypoints.findIndex((w) => w.id === editingWaypointId);
  /* The shot the generator emitted for the waypoint being edited, so the panel
     reports what the camera on this very screen performs rather than what was
     proposed before the walls were consulted. Withheld while the plan is dirty:
     the regenerate an edit kicks off has not landed yet, so the shot still in
     `path` belongs to the plan from before it. */
  const editingShot = generatedShotFor(path, editingWaypointId, !dirty);

  const hasPath = frames.length > 0;
  /* The path on screen is not the plan any more: the mini-map is drawing new
     waypoints over an old route, the camera is flying the old one, and the
     technique panel is reporting a shot that has not been generated yet. */
  const stale = hasPath && dirty;
  // A rebuild already under way is not something to warn about - it is the
  // fix, in progress - and every tick of a slider would otherwise flash it.
  const showStale = stale && !generating;

  /* The running order, as stops on the timeline: which shot, in what order,
     how long, and where to land to see it. The generator emits shots in
     waypoint order and segments in time order, so the jump target comes from
     the segment and the numbering from the shot list. */
  const stops = useMemo(() => {
    if (!path) return [];
    return path.shots.map((shot, i) => ({
      id: shot.waypointId,
      number: i + 1,
      shotType: shot.shotType,
      duration: shot.duration,
      startTime:
        path.segments.find((s) => s.kind === 'shot' && s.waypointId === shot.waypointId)
          ?.startTime ?? 0,
    }));
  }, [path]);

  // The store is the clamp bound for seeking, so it has to hear about a path
  // whose duration just shrank - otherwise the playhead sits past the end.
  useEffect(() => {
    setDuration(duration);
  }, [duration, setDuration]);

  // The plan store's generate settles its own failures into `generateError`,
  // so there is nothing to catch here and nothing to wait for.
  const runGenerate = useCallback(() => {
    void generate(assets.colliderData);
  }, [assets.colliderData, generate]);

  /* ---------------- the transport shortcut ---------------- */

  /**
   * Space plays and pauses, the way it does in every other player.
   *
   * Bound on the window rather than on the viewport, because the thing the
   * user is looking at when they reach for it is the render, which is a canvas
   * and takes no focus of its own - a handler on any one element would work
   * only after clicking that element first.
   *
   * Not bound at all while the transport is unusable, so the key falls through
   * to the browser instead of being swallowed by a screen that would do
   * nothing with it.
   */
  useEffect(() => {
    if (!hasPath || recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return;
      // A modifier makes it someone else's shortcut - Cmd-Space is Spotlight,
      // Shift-Space is page-up - and a held key would flip the transport on
      // every repeat the keyboard sends.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.repeat || event.defaultPrevented) return;
      if (ownsSpaceItself(event.target)) return;

      // Space scrolls the nearest scroller, which on this screen is the
      // sidebar the user is not looking at.
      event.preventDefault();
      toggle();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasPath, recording, toggle]);

  /* ---------------- recording ---------------- */

  // Probed in an effect, not during render: MediaRecorder does not exist on
  // the server, so a render-time probe renders "unsupported" into the HTML and
  // then disagrees with the client on hydration. Null until probed, so the
  // pre-hydration markup claims neither support nor the lack of it.
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => setSupported(isRecordingSupported()), []);

  // Capture is real time and destructive to redo, so it is confirmed first.
  const [armed, setArmed] = useState(false);

  const canRecord =
    supported === true && hasPath && !stale && !generating && !recording && canvas !== null;
  const recordBlockedReason = !hasPath
    ? 'Generate a path first.'
    : stale
      ? 'Regenerate the path first — this would export the old one.'
      : !canvas
        ? 'Waiting for the viewport.'
        : undefined;

  const beginRecording = useCallback(() => {
    if (!canvas || !hasPath || stale) return;
    setArmed(false);
    startRecording(canvas, path?.fps ?? 30);
  }, [canvas, hasPath, stale, path, startRecording]);

  // The recorder lives in the store, but the canvas it captures does not
  // outlive this screen: dropping it here stops the stream tracks and clears
  // the transport instead of stranding a running capture behind a nav click.
  useEffect(() => () => releaseRecorder(), [releaseRecorder]);

  /* ---------------- comments ---------------- */

  const onMapClick = useCallback(
    (x: number, z: number) => {
      if (playing) return; // comments are a paused-only interaction
      // Anchored where the user clicked (that is what a map pin means), with
      // the camera's current view direction kept for context on jump-back.
      beginDraft({
        timeSeconds: time,
        position: [x, assets.floorYAtOr(x, z), z] as Vec3,
        lookAt: pose?.lookAt ?? ([x, 0, z] as Vec3),
      });
      setDraftText('');
    },
    [playing, time, assets, pose, beginDraft],
  );

  const saveComment = useCallback(() => {
    if (!draft || draftText.trim() === '') return;
    addComment({ ...draft, text: draftText.trim() });
    cancelDraft();
    setDraftText('');
  }, [draft, draftText, addComment, cancelDraft]);

  // Inert during a capture: the store refuses to move the playhead while one
  // is running, so a jump cannot land halfway through the export.
  const jumpTo = useCallback((seconds: number) => {
    pause();
    seek(seconds);
  }, [pause, seek]);

  const jumpToComment = useCallback(
    (comment: Comment) => jumpTo(comment.timeSeconds),
    [jumpTo],
  );

  /* ---------------- editing a shot from the label ---------------- */

  const applyEdit = useCallback(
    (patch: Parameters<typeof updateWaypoint>[1]) => {
      if (!editing) return;
      updateWaypoint(editing.id, patch);
      // Marking the waypoint pinned scopes the rebuild to the legs touching it;
      // the rest of the frame table is served from cache.
      runGenerate();
    },
    [editing, updateWaypoint, runGenerate],
  );

  return (
    <div className="review">
      {/* ---------------- player ---------------- */}
      <div className="review__player">
        <div className="review__stage">
          <Canvas
            camera={{ position: startView.position, fov: 60, near: 0.05, far: 2000 }}
            // antialias off on Spark's advice: MSAA does nothing for Gaussian
            // splats and costs fill rate - and this is the canvas being
            // captured in real time, so it is the one that can least spare it.
            gl={{ antialias: false, preserveDrawingBuffer: true }}
          >
            <PlaybackCamera frames={frames} />
            {!hasPath && <CameraPresetDriver preset={startView} nonce={startNonce} />}
            <RoomScene />
          </Canvas>

          {!hasPath && (
            <div className="review__empty">
              {assets.settled ? (
                <>
                  <div>No path generated yet.</div>
                  <Link href="/plan" className="btn btn--primary">
                    Go to the plan screen →
                  </Link>
                </>
              ) : (
                <div>Loading room… {Math.round(assets.progress * 100)}%</div>
              )}
            </div>
          )}

          {/* A 60 MB splat download is otherwise a black canvas with no
              explanation, exactly as on /scene and /plan. Last, so its Retry
              button stays clickable over the full-bleed notice above. */}
          <div className="review__assets">
            <AssetStatusPanel assets={assets} />
          </div>

          {recording && (
            <div className="review__rec" role="status">
              <span className="review__rec-dot" aria-hidden="true" />
              Recording — {timecode(time)} / {timecode(duration)}
            </div>
          )}
        </div>

        {/* ---------------- transport ---------------- */}
        <div className="review__transport">
          {generating && (
            <div className="review__note" role="status">
              <div className="review__note-body">Regenerating the flythrough…</div>
            </div>
          )}

          {showStale && (
            <div className="review__note" data-tone="warn">
              <div className="review__note-body">
                <strong>This flythrough is out of date.</strong> The plan changed after it was
                generated, so the camera and the route on the map are still the old path.
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={runGenerate}
                disabled={!assets.colliderData}
                title={assets.colliderData ? undefined : 'Waiting for the collider to load.'}
              >
                Regenerate
              </button>
            </div>
          )}

          <div className="review__timeline">
            <ScrubBar
              time={time}
              duration={duration}
              segments={path?.segments}
              comments={comments}
              onSeek={seek}
              onCommentClick={jumpToComment}
              disabled={recording}
            />

            {/* The running order, under the track it indexes. Each stop is a
                place to land, so each one is a button rather than a caption. */}
            {stops.length > 0 && (
              <div className="review__strip">
                {stops.map((stop) => (
                  <button
                    key={stop.id}
                    type="button"
                    className="review__chip"
                    aria-current={stop.id === pose?.activeWaypointId}
                    disabled={recording}
                    title={`Jump to shot ${stop.number}: ${stop.shotType}`}
                    onClick={() => jumpTo(stop.startTime)}
                  >
                    <span className="review__chip-n">{stop.number}</span>
                    {stop.shotType}
                    <span className="review__chip-meta">{stop.duration.toFixed(1)}s</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="review__controls">
            {/* The glyph is decoration; the word is the accessible name, and it
                changes with the state so the name always says what the button
                will do next. */}
            <button
              type="button"
              className="btn review__play"
              onClick={toggle}
              disabled={!hasPath || recording}
              aria-keyshortcuts="Space"
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
            >
              <span className="review__glyph" aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
              {playing ? 'Pause' : 'Play'}
            </button>

            <button
              type="button"
              className="btn"
              onClick={() => jumpTo(0)}
              disabled={!hasPath || recording}
              aria-label="Back to the start"
              title="Back to the start"
            >
              <span aria-hidden="true">↺</span>
            </button>

            <span className="review__time">
              <span className="review__time-now">{timecode(time)}</span>
              <span className="review__time-total">/ {timecode(duration)}</span>
            </span>

            {/* the live technique label */}
            {activeShot && (
              <button
                type="button"
                className="review__chip"
                aria-pressed={editingWaypointId === activeShot.waypointId}
                onClick={() => editWaypoint(
                  editingWaypointId === activeShot.waypointId ? null : activeShot.waypointId,
                )}
                disabled={recording}
                title="Edit this shot"
              >
                Now: <strong>{activeShot.shotType}</strong>
                <span className="review__chip-meta">
                  {segment?.kind === 'travel' ? 'approaching' : 'shot'}
                </span>
              </button>
            )}

            <span className="spacer" />

            {supported === false ? (
              <span className="review__msg">Recording unsupported in this browser</span>
            ) : recording ? (
              <button
                type="button"
                className="btn btn--danger"
                onClick={cancelRecording}
                title="Stop the capture and discard what has been recorded."
              >
                Cancel recording
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => setArmed(true)}
                disabled={!canRecord || armed}
                title={recordBlockedReason}
              >
                Record
              </button>
            )}

            {video ? (
              <a
                className="btn btn--primary"
                href={video.url}
                download={`flythrough.${video.extension}`}
              >
                Download .{video.extension} ({(video.sizeBytes / 1e6).toFixed(1)} MB)
              </a>
            ) : (
              <button type="button" className="btn" disabled>Download video</button>
            )}
          </div>

          {/* Where the keys are stated. A shortcut nobody can see is a
              shortcut only the person who wrote it uses. */}
          <div className="review__hints">
            {recording ? (
              <span className="review__msg">
                Transport is locked while recording — pausing or scrubbing would land in the
                export. Cancel to discard the capture.
              </span>
            ) : (
              <>
                <span className="review__hint">
                  <kbd className="review__key">Space</kbd> play / pause
                </span>
                <span className="review__hint">
                  <kbd className="review__key">←</kbd>
                  <kbd className="review__key">→</kbd> scrub 1s
                </span>
                <span className="review__hint">
                  <kbd className="review__key">Home</kbd> back to the start
                </span>
              </>
            )}
          </div>

          {/* Real time is the whole cost of this feature, so it is stated
              before the capture starts rather than discovered during it. */}
          {armed && canRecord && (
            <div className="review__note">
              <div className="review__note-body">
                Recording runs in real time: the capture takes the full{' '}
                <strong>{timecode(duration)}</strong> of the flythrough, replayed from the start,
                and ends by itself when the flythrough does. Keep this tab in front — a
                background tab stops rendering and stalls the capture.
              </div>
              <button type="button" className="btn btn--primary" onClick={beginRecording}>
                Start recording
              </button>
              <button type="button" className="btn" onClick={() => setArmed(false)}>
                Cancel
              </button>
            </div>
          )}

          {recordError && <div className="review__msg" data-tone="danger">{recordError}</div>}
          {generateError && <div className="review__msg" data-tone="danger">{generateError}</div>}
        </div>
      </div>

      {/* ---------------- sidebar ---------------- */}
      <aside className="review__side">
        <div className="review__map">
          <MiniMap
            grid={grid}
            waypoints={waypoints}
            selectedId={editingWaypointId}
            polyline={path?.polyline ?? NO_POLYLINE}
            camera={mapCamera}
            comments={comments}
            onPick={onMapClick}
            onWaypointPick={(id) => editWaypoint(id)}
            onCommentPick={(id) => {
              const c = comments.find((x) => x.id === id);
              if (c) jumpToComment(c);
            }}
            height={240}
          />
        </div>

        {showStale && (
          <div className="review__note" data-tone="warn">
            <div className="review__note-body">
              Markers show the edited plan; the route is the path that was generated before
              those edits.
            </div>
          </div>
        )}

        {/* comment composer */}
        {draft && (
          <div className="review__comment review__composer">
            <div className="review__msg">
              Comment at {timecode(draft.timeSeconds)} · ({draft.position[0].toFixed(1)},{' '}
              {draft.position[2].toFixed(1)})
            </div>
            <textarea
              autoFocus
              rows={3}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
                if (e.key === 'Escape') { cancelDraft(); setDraftText(''); }
              }}
              placeholder="What should change here?"
              aria-label="Comment text"
            />
            <div className="review__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={saveComment}
                disabled={!draftText.trim()}
              >
                Save
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => { cancelDraft(); setDraftText(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* The reopened technique panel. Hidden during a capture: every control
            on it either moves the playhead or regenerates the path underneath
            the recorder. */}
        {editing && !recording && (
          <WaypointPanel
            waypoint={editing}
            index={editingIndex}
            total={waypoints.length}
            grid={grid}
            style={settings.style}
            generated={editingShot.intent}
            clipped={editingShot.clipped}
            onChange={applyEdit}
            onClose={() => editWaypoint(null)}
            footer={
              <button
                type="button"
                className="btn btn--block"
                onClick={() => {
                  const seg = path?.segments.find(
                    (s) => s.kind === 'shot' && s.waypointId === editing.id,
                  );
                  if (seg) jumpTo(seg.startTime);
                }}
              >
                Jump to this shot
              </button>
            }
          />
        )}

        {/* comment list */}
        <div className="review__section">
          <div className="review__section-head">
            Comments <span className="review__count">{comments.length}</span>
          </div>

          {comments.length === 0 ? (
            <div className="review__msg">Pause, then click the mini-map to leave one.</div>
          ) : (
            <div className="review__comments">
              {comments
                .slice()
                .sort((a, b) => a.timeSeconds - b.timeSeconds)
                .map((c) => (
                  <div key={c.id} className="review__comment">
                    <div className="review__comment-head">
                      <button
                        type="button"
                        className="review__chip"
                        onClick={() => jumpToComment(c)}
                        disabled={recording}
                        title="Jump to this comment"
                      >
                        <span className="num">{timecode(c.timeSeconds)}</span>
                      </button>
                      <span className="spacer" />
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={() => removeComment(c.id)}
                        aria-label={`Delete the comment at ${timecode(c.timeSeconds)}`}
                        title="Delete this comment"
                      >
                        <span aria-hidden="true">✕</span>
                      </button>
                    </div>
                    <div className="review__comment-text">{c.text}</div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
