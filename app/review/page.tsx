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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Canvas } from '@react-three/fiber';
import { CameraPresetDriver, RoomScene, derivePresets } from '@/components/scene';
import { MiniMap } from '@/components/plan/MiniMap';
import { WaypointPanel } from '@/components/plan/WaypointPanel';
import { PlaybackCamera } from '@/components/review/PlaybackCamera';
import { ScrubBar } from '@/components/review/ScrubBar';
import { useRoomAssets } from '@/lib/scene';
import { getWalkGrid, sampleAtTime, segmentAtTime } from '@/lib/path';
import { usePlanStore } from '@/lib/plan/planStore';
import { useReviewStore } from '@/lib/review/reviewStore';
import { CanvasRecorder, isRecordingSupported } from '@/lib/review/recorder';
import type { Comment, Vec3 } from '@/lib/types';

function timecode(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

export default function ReviewPage() {
  const assets = useRoomAssets();
  const { waypoints, settings, path, comments, addComment, removeComment, updateWaypoint, generate } =
    usePlanStore();
  const {
    time, playing, recording, video, recordError, canvas, draft, editingWaypointId,
    play, pause, toggle, seek, beginDraft, cancelDraft, editWaypoint,
    setRecording, setVideo, setRecordError,
  } = useReviewStore();

  const [draftText, setDraftText] = useState('');
  const recorderRef = useRef<CanvasRecorder | null>(null);

  const grid = useMemo(
    () => (assets.colliderData ? getWalkGrid(assets.colliderData) : null),
    [assets.colliderData],
  );
  // Only ever seen before a path exists - PlaybackCamera owns the camera after
  // that - but "before" is most of the time on a first visit, so it is framed
  // from the collider rather than from numbers that fit the sample flat.
  const startView = useMemo(
    () => derivePresets(assets.roomBounds, assets.floor.baseY)[0],
    [assets.roomBounds, assets.floor],
  );
  const [startNonce, setStartNonce] = useState(0);
  useEffect(() => {
    if (assets.roomBounds) setStartNonce((n) => n + 1);
  }, [assets.roomBounds, assets.assetSetId]);

  const frames = path?.frames ?? [];
  const duration = path?.duration ?? 0;
  const pose = useMemo(() => sampleAtTime(frames, time), [frames, time]);
  const segment = useMemo(() => segmentAtTime(path?.segments ?? [], time), [path, time]);
  const activeShot = path?.shots.find((s) => s.waypointId === pose?.activeWaypointId) ?? null;

  const editing = waypoints.find((w) => w.id === editingWaypointId) ?? null;
  const editingIndex = waypoints.findIndex((w) => w.id === editingWaypointId);

  /* ---------------- recording ---------------- */

  const supported = useMemo(() => isRecordingSupported(), []);

  const startRecording = useCallback(() => {
    if (!canvas || duration <= 0) return;
    try {
      const recorder = new CanvasRecorder(canvas, path?.fps ?? 30);
      recorderRef.current = recorder;
      setRecordError(null);
      setVideo(null);
      seek(0);
      recorder.start();
      setRecording(true);
      play();
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : String(err));
    }
  }, [canvas, duration, path, play, seek, setRecordError, setRecording, setVideo]);

  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording(false);
    try {
      setVideo(await recorder.stop());
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : String(err));
    }
  }, [setRecordError, setRecording, setVideo]);

  // Playback stops itself at the end; that is the cue to close the capture.
  useEffect(() => {
    if (recording && !playing) void finishRecording();
  }, [recording, playing, finishRecording]);

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
      generate(assets.colliderData);
    },
    [editing, updateWaypoint, generate, assets.colliderData],
  );

  const hasPath = frames.length > 0;

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* ---------------- player ---------------- */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <Canvas
            camera={{ position: startView.position, fov: 60, near: 0.05, far: 2000 }}
            gl={{ preserveDrawingBuffer: true }}
          >
            <PlaybackCamera frames={frames} duration={duration} />
            {!hasPath && <CameraPresetDriver preset={startView} nonce={startNonce} />}
            <RoomScene />
          </Canvas>

          {!hasPath && (
            <div style={centreNotice}>
              <div style={{ marginBottom: 8 }}>No path generated yet.</div>
              <Link href="/plan">Go to the plan screen →</Link>
            </div>
          )}

          {recording && (
            <div style={{ ...badge, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              ● Recording — {timecode(time)} / {timecode(duration)}
            </div>
          )}
        </div>

        {/* ---------------- transport ---------------- */}
        <div style={{ borderTop: '1px solid var(--line)', background: 'var(--panel)', padding: 12 }}>
          <ScrubBar
            time={time}
            duration={duration}
            segments={path?.segments}
            comments={comments}
            onSeek={seek}
            onCommentClick={jumpToComment}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <button onClick={toggle} disabled={!hasPath} style={{ minWidth: 76 }}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button onClick={() => { pause(); seek(0); }} disabled={!hasPath}>↺</button>

            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: 'var(--muted)' }}>
              {timecode(time)} / {timecode(duration)}
            </span>

            {/* the live technique label */}
            {activeShot && (
              <button
                onClick={() => editWaypoint(
                  editingWaypointId === activeShot.waypointId ? null : activeShot.waypointId,
                )}
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

            {supported ? (
              <button onClick={startRecording} disabled={!hasPath || recording || !canvas}>
                {recording ? 'Recording…' : 'Record'}
              </button>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                Recording unsupported in this browser
              </span>
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

          {recordError && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--danger)' }}>{recordError}</div>
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
          polyline={path?.polyline ?? []}
          camera={pose ? { position: pose.position, lookAt: pose.lookAt } : null}
          comments={comments}
          onPick={onMapClick}
          onWaypointPick={(id) => editWaypoint(id)}
          onCommentPick={(id) => {
            const c = comments.find((x) => x.id === id);
            if (c) jumpToComment(c);
          }}
          height={240}
          title="Top-down"
          hint={playing ? 'pause to leave a comment' : 'click to leave a comment'}
        />

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

        {/* the reopened technique panel */}
        {editing && (
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

const badge: React.CSSProperties = {
  position: 'absolute', top: 12, left: 12, background: 'var(--panel)',
  border: '1px solid var(--line)', borderRadius: 'var(--radius)',
  padding: '6px 10px', fontSize: 12,
};

const centreNotice: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', textAlign: 'center',
  color: 'var(--muted)', fontSize: 13, pointerEvents: 'auto',
};
