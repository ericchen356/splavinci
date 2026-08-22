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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Canvas } from '@react-three/fiber';
import { AssetStatusPanel, CameraPresetDriver, RoomScene, derivePresets } from '@/components/scene';
import { MiniMap } from '@/components/plan/MiniMap';
import { WaypointPanel } from '@/components/plan/WaypointPanel';
import { PlaybackCamera } from '@/components/review/PlaybackCamera';
import { ScrubBar } from '@/components/review/ScrubBar';
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

function timecode(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
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

  const hasPath = frames.length > 0;
  /* The path on screen is not the plan any more: the mini-map is drawing new
     waypoints over an old route, the camera is flying the old one, and the
     technique panel is reporting a shot that has not been generated yet. */
  const stale = hasPath && dirty;
  // A rebuild already under way is not something to warn about - it is the
  // fix, in progress - and every tick of a slider would otherwise flash it.
  const showStale = stale && !generating;

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
  const jumpToComment = useCallback((comment: Comment) => {
    pause();
    seek(comment.timeSeconds);
  }, [pause, seek]);

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
    <div style={{ display: 'flex', height: '100%' }}>
      {/* ---------------- player ---------------- */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
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
            <div style={centreNotice}>
              {assets.settled ? (
                <>
                  <div style={{ marginBottom: 8 }}>No path generated yet.</div>
                  <Link href="/plan">Go to the plan screen →</Link>
                </>
              ) : (
                <div>Loading room… {Math.round(assets.progress * 100)}%</div>
              )}
            </div>
          )}

          {/* A 60 MB splat download is otherwise a black canvas with no
              explanation, exactly as on /scene and /plan. Last, so its Retry
              button stays clickable over the full-bleed notice above. */}
          <div style={{ position: 'absolute', top: 12, left: 12, maxWidth: 300, zIndex: 1 }}>
            <AssetStatusPanel assets={assets} />
          </div>

          {recording && (
            <div style={{ ...badge, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              ● Recording — {timecode(time)} / {timecode(duration)}
            </div>
          )}
        </div>

        {/* ---------------- transport ---------------- */}
        <div style={{ borderTop: '1px solid var(--line)', background: 'var(--panel)', padding: 12 }}>
          {generating && (
            <div style={{ ...banner, color: 'var(--accent)', borderColor: 'var(--accent-dim)' }}>
              Regenerating the flythrough…
            </div>
          )}

          {showStale && (
            <div style={{ ...banner, color: 'var(--warn)', borderColor: 'var(--warn)' }}>
              <div style={{ flex: 1, lineHeight: 1.45 }}>
                <strong>This flythrough is out of date.</strong> The plan changed after it was
                generated, so the camera and the route on the map are still the old path.
              </div>
              <button
                className="primary"
                onClick={runGenerate}
                disabled={!assets.colliderData}
                title={assets.colliderData ? undefined : 'Waiting for the collider to load.'}
              >
                Regenerate
              </button>
            </div>
          )}

          <ScrubBar
            time={time}
            duration={duration}
            segments={path?.segments}
            comments={comments}
            onSeek={seek}
            onCommentClick={jumpToComment}
            disabled={recording}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <button onClick={toggle} disabled={!hasPath || recording} style={{ minWidth: 76 }}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button onClick={() => { pause(); seek(0); }} disabled={!hasPath || recording}>↺</button>

            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: 'var(--muted)' }}>
              {timecode(time)} / {timecode(duration)}
            </span>

            {/* the live technique label */}
            {activeShot && (
              <button
                onClick={() => editWaypoint(
                  editingWaypointId === activeShot.waypointId ? null : activeShot.waypointId,
                )}
                disabled={recording}
                title="Edit this shot"
                style={{
                  borderColor: 'var(--accent)',
                  background: editingWaypointId === activeShot.waypointId
                    ? 'var(--accent-dim)' : 'var(--panel-2)',
                }}
              >
                Now: <strong>{activeShot.shotType}</strong>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {' '}({segment?.kind === 'travel' ? 'approaching' : 'shot'})
                </span>
              </button>
            )}

            <div style={{ flex: 1 }} />

            {supported === false ? (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                Recording unsupported in this browser
              </span>
            ) : recording ? (
              <button
                onClick={cancelRecording}
                style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                title="Stop the capture and discard what has been recorded."
              >
                Cancel recording
              </button>
            ) : (
              <button
                onClick={() => setArmed(true)}
                disabled={!canRecord || armed}
                title={recordBlockedReason}
              >
                Record
              </button>
            )}

            {video ? (
              <a
                href={video.url}
                download={`flythrough.${video.extension}`}
                style={{
                  padding: '6px 12px', borderRadius: 'var(--radius)',
                  border: '1px solid var(--accent)', background: 'var(--accent-dim)',
                  color: 'var(--text)', textDecoration: 'none', fontSize: 14,
                }}
              >
                Download .{video.extension} ({(video.sizeBytes / 1e6).toFixed(1)} MB)
              </a>
            ) : (
              <button disabled>Download video</button>
            )}
          </div>

          {/* Real time is the whole cost of this feature, so it is stated
              before the capture starts rather than discovered during it. */}
          {armed && canRecord && (
            <div style={armedPanel}>
              <div style={{ flex: 1, lineHeight: 1.5 }}>
                Recording runs in real time: the capture takes the full{' '}
                <strong>{timecode(duration)}</strong> of the flythrough, replayed from the start,
                and ends by itself when the flythrough does. Keep this tab in front — a
                background tab stops rendering and stalls the capture.
              </div>
              <button className="primary" onClick={beginRecording}>Start recording</button>
              <button onClick={() => setArmed(false)}>Cancel</button>
            </div>
          )}

          {recording && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
              Transport is locked while recording — pausing or scrubbing would land in the
              export. Cancel to discard the capture.
            </div>
          )}

          {recordError && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--danger)' }}>{recordError}</div>
          )}
          {generateError && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--danger)' }}>{generateError}</div>
          )}
        </div>
      </div>

      {/* ---------------- sidebar ---------------- */}
      <aside
        style={{
          width: 340, flex: '0 0 340px', borderLeft: '1px solid var(--line)',
          overflowY: 'auto', padding: 14,
        }}
      >
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
          title="Top-down"
          hint={
            recording
              ? 'capture in progress'
              : playing
                ? 'pause to leave a comment'
                : 'click to leave a comment'
          }
        />

        {showStale && (
          <div style={{ ...card, marginTop: 12, borderColor: 'var(--warn)', color: 'var(--warn)', fontSize: 11 }}>
            Markers show the edited plan; the blue route is the path that was generated before
            those edits.
          </div>
        )}

        {/* comment composer */}
        {draft && (
          <div style={{ ...card, marginTop: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
              Comment at {timecode(draft.timeSeconds)} ·
              ({draft.position[0].toFixed(1)}, {draft.position[2].toFixed(1)})
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
              style={{ resize: 'vertical', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="primary" onClick={saveComment} disabled={!draftText.trim()}>
                Save
              </button>
              <button onClick={() => { cancelDraft(); setDraftText(''); }}>Cancel</button>
            </div>
          </div>
        )}

        {/* The reopened technique panel. Hidden during a capture: every control
            on it either moves the playhead or regenerates the path underneath
            the recorder. */}
        {editing && !recording && (
          <div style={{ marginTop: 12 }}>
            <WaypointPanel
              waypoint={editing}
              index={editingIndex}
              total={waypoints.length}
              grid={grid}
              style={settings.style}
              onChange={applyEdit}
              onClose={() => editWaypoint(null)}
              footer={
                <button
                  style={{ width: '100%', marginBottom: 8 }}
                  onClick={() => {
                    const seg = path?.segments.find(
                      (s) => s.kind === 'shot' && s.waypointId === editing.id,
                    );
                    if (seg) { pause(); seek(seg.startTime); }
                  }}
                >
                  Jump to this shot
                </button>
              }
            />
          </div>
        )}

        {/* comment list */}
        <div style={{ marginTop: 14 }}>
          <div style={sectionLabel}>Comments ({comments.length})</div>
          {comments.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Pause, then click the mini-map to leave one.
            </div>
          )}
          {comments
            .slice()
            .sort((a, b) => a.timeSeconds - b.timeSeconds)
            .map((c) => (
              <div key={c.id} style={{ ...card, marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <button
                    onClick={() => jumpToComment(c)}
                    disabled={recording}
                    style={{ padding: '1px 6px', fontSize: 11 }}
                  >
                    {timecode(c.timeSeconds)}
                  </button>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => removeComment(c.id)}
                    style={{ padding: '1px 6px', fontSize: 11, color: 'var(--danger)' }}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>{c.text}</div>
              </div>
            ))}
        </div>
      </aside>
    </div>
  );
}

const card: React.CSSProperties = {
  background: 'var(--panel)', border: '1px solid var(--line)',
  borderRadius: 'var(--radius)', padding: 10,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--muted)', marginBottom: 6,
};

/* Right, not left: the asset panel owns the top-left corner on every screen. */
const badge: React.CSSProperties = {
  position: 'absolute', top: 12, right: 12, zIndex: 1, background: 'var(--panel)',
  border: '1px solid var(--line)', borderRadius: 'var(--radius)',
  padding: '6px 10px', fontSize: 12,
};

const centreNotice: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', textAlign: 'center',
  color: 'var(--muted)', fontSize: 13, pointerEvents: 'auto',
};

const banner: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
  padding: '8px 10px', fontSize: 12,
  background: 'var(--panel-2)', border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
};

const armedPanel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, marginTop: 10,
  padding: '8px 10px', fontSize: 12, color: 'var(--text)',
  background: 'var(--panel-2)', border: '1px solid var(--accent)',
  borderRadius: 'var(--radius)',
};
