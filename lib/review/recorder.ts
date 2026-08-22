/**
 * Canvas recording via MediaRecorder + canvas.captureStream().
 *
 * Container support is genuinely split: Safari gives MP4/H.264 and Chrome and
 * Firefox give WebM, so the type is negotiated at runtime rather than assumed,
 * and the download is named after whatever was actually produced. Asking for a
 * type the browser cannot encode fails at construction, so the list is probed
 * in preference order.
 */

const CANDIDATE_TYPES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export type RecordingResult = {
  blob: Blob;
  url: string;
  mimeType: string;
  extension: 'mp4' | 'webm';
  sizeBytes: number;
};

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    pickMimeType() !== null
  );
}

/** The error event carries a DOMException in some browsers and nothing useful
 *  in others, so the message is reconstructed rather than stringified. */
function recorderError(event: ErrorEvent): Error {
  const raw: unknown = event.error;
  if (raw instanceof Error) return raw;
  return new Error(event.message || 'The recorder stopped unexpectedly.');
}

export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  /** Rejecter of the promise stop() is currently waiting on, if any. */
  private pendingFailure: ((error: Error) => void) | null = null;

  /**
   * Raised when the capture dies on its own - a lost GPU context, a discarded
   * tab, an encoder that gave up. Without it the failure lands nowhere and the
   * caller goes on believing it is still recording.
   */
  onError: ((error: Error) => void) | null = null;

  readonly mimeType: string;

  constructor(private canvas: HTMLCanvasElement, private fps = 30) {
    const type = pickMimeType();
    if (!type) throw new Error('This browser cannot record canvas video.');
    this.mimeType = type;
  }

  start(): void {
    if (this.recorder) throw new Error('Already recording.');
    this.chunks = [];
    this.stream = this.canvas.captureStream(this.fps);
    const recorder = new MediaRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: 12_000_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    // Attached here rather than in stop(): a capture can die at any point
    // during the minutes it is running, not only while it is being closed.
    recorder.onerror = (event) => {
      const error = recorderError(event);
      const pending = this.pendingFailure;
      this.pendingFailure = null;
      this.cleanup();
      if (pending) pending(error);
      else this.onError?.(error);
    };
    // A timeslice keeps chunks flowing, so a long capture is not held entirely
    // in one buffer until stop().
    recorder.start(250);
  }

  /** Resolves once the final chunk has been flushed. */
  stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error('Not recording.'));

    return new Promise<RecordingResult>((resolve, reject) => {
      this.pendingFailure = reject;
      recorder.onstop = () => {
        this.pendingFailure = null;
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.cleanup();
        if (blob.size === 0) {
          reject(new Error('Recording produced no data.'));
          return;
        }
        resolve({
          blob,
          url: URL.createObjectURL(blob),
          mimeType: this.mimeType,
          extension: this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm',
          sizeBytes: blob.size,
        });
      };
      recorder.stop();
    });
  }

  /**
   * Throw the capture away and release the stream. For a cancel, and for the
   * screen unmounting: the canvas being captured is going with it, so there is
   * nothing left to record and the tracks must not be left running.
   */
  abort(): void {
    const recorder = this.recorder;
    this.pendingFailure = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    this.chunks = [];
    this.cleanup();
  }

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
