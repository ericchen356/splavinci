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

export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

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
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: 12_000_000,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    // A timeslice keeps chunks flowing, so a long capture is not held entirely
    // in one buffer until stop().
    this.recorder.start(250);
  }

  /** Resolves once the final chunk has been flushed. */
  stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error('Not recording.'));

    return new Promise<RecordingResult>((resolve, reject) => {
      recorder.onerror = (event) => reject(new Error(String(event)));
      recorder.onstop = () => {
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

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
