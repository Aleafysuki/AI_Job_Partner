/**
 * 面试录音控制器（渲染层）。
 * ============================
 *
 * 这一层只负责「把声音变成一段段音频字节」，其他什么都不做：
 * 不落盘（交给主进程）、不转写（交给 core 的转写客户端）、不碰界面状态。
 *
 * 三个设计决定值得写下来：
 *
 * 1. **分段录制，而不是录一整个文件。**
 *    MediaRecorder 的 `start(timeslice)` 只有第一个分片带容器头，
 *    后面的分片单独拿去解码会失败 —— 而我们要把分片直接送去做转写。
 *    所以每 N 秒用一个新的 MediaRecorder 重新开始，段与段之间几乎无缝。
 *    代价是每段之间可能有几十毫秒的缝隙，对复盘转写没有影响。
 *
 * 2. **关掉浏览器的音频预处理。**
 *    `echoCancellation` / `noiseSuppression` / `autoGainControl` 是为通话设计的，
 *    它们会把人声之外的内容（包括对方从扬声器出来的声音）当成噪声削掉。
 *    面试复盘要的是「把当时说了什么记全」，不是「让对方听清」。
 *
 * 3. **不因为一路失败就整体失败。**
 *    系统内录在 macOS / Linux 上常常拿不到（缺少虚拟音频设备）。
 *    这时应该降级成「只录麦克风」并如实告诉用户，而不是整个录制起不来。
 */

export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'error';

export interface CaptureSegmentPayload {
  index: number;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  /** 相对会话开始的毫秒偏移 */
  startOffsetMs: number;
  durationMs: number;
}

export interface RecorderStartOptions {
  sources: { mic: boolean; system: boolean };
  segmentSeconds: number;
  micDeviceId?: string;
  onSegment: (payload: CaptureSegmentPayload) => void | Promise<void>;
  onError: (message: string) => void;
  onStateChange?: (state: RecorderState) => void;
  /** 实际拿到的音源（内录可能失败并降级） */
  onResolvedSources?: (actual: { mic: boolean; system: boolean; note?: string }) => void;
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

/** 扩展名必须与 mimeType 一致 —— 服务端常靠扩展名判断容器格式 */
const EXTENSION_BY_MIME: Array<{ test: RegExp; ext: string }> = [
  { test: /webm/i, ext: '.webm' },
  { test: /ogg|opus/i, ext: '.ogg' },
  { test: /mp4|m4a|aac/i, ext: '.m4a' },
  { test: /mpeg|mp3/i, ext: '.mp3' },
  { test: /wav/i, ext: '.wav' },
];

export function isCaptureSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined'
  );
}

export function pickAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* 某些实现会在参数非法时抛错，忽略继续试下一个 */
    }
  }
  return '';
}

export function extensionForMime(mime: string): string {
  const hit = EXTENSION_BY_MIME.find((e) => e.test.test(mime));
  return hit?.ext ?? '.webm';
}

/** 把 getUserMedia 的异常翻译成用户能看懂的一句话 */
export function describeCaptureError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '麦克风权限被拒绝。请在系统隐私设置里允许本应用使用麦克风，然后重试。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有检测到可用的麦克风设备。请确认录音设备已连接。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被其他程序占用（例如会议软件）。请先关闭占用它的程序，再重试。';
    case 'OverconstrainedError':
      return '指定的麦克风设备当前不可用，请换一个设备。';
    case 'AbortError':
      return '系统拒绝了音频采集请求。如果开启了内录，请确认系统允许捕获音频。';
    default:
      return e?.message ? `录音启动失败：${e.message}` : '录音启动失败：未知原因';
  }
}

export async function listMicrophones(): Promise<Array<{ deviceId: string; label: string }>> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `麦克风 ${i + 1}` }));
  } catch {
    return [];
  }
}

/** 内录在各平台的能力差异，界面要如实告知 */
export function systemAudioHint(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows 可以直接捕获系统播放的声音。';
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return 'macOS 需要先装虚拟音频设备（例如 BlackHole）才能录到对方的声音，否则内录会拿到空音轨。';
  }
  if (/Linux/i.test(ua)) return 'Linux 需要 PipeWire / PulseAudio 提供 monitor 源。';
  return '当前平台的内录支持情况未知，建议先试探一次。';
}

export class InterviewRecorder {
  private state: RecorderState = 'idle';
  private options: RecorderStartOptions | null = null;

  private micStream: MediaStream | null = null;
  private systemStream: MediaStream | null = null;
  private mixStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;

  private activeRecorder: MediaRecorder | null = null;
  private segmentTimer: ReturnType<typeof setTimeout> | null = null;
  private segmentsStarted = 0;
  private segmentStartOffsets: number[] = [];
  private sessionStartedAt = 0;
  private inflight: Promise<void> = Promise.resolve();
  private mimeType = '';

  get currentState(): RecorderState {
    return this.state;
  }

  /** 已经开始的段数（含正在录的这一段） */
  get segmentCount(): number {
    return this.segmentsStarted;
  }

  get elapsedMs(): number {
    if (this.sessionStartedAt === 0) return 0;
    return Math.round(performance.now() - this.sessionStartedAt);
  }

  private setState(next: RecorderState): void {
    this.state = next;
    this.options?.onStateChange?.(next);
  }

  async start(options: RecorderStartOptions): Promise<void> {
    if (this.state === 'recording' || this.state === 'starting') return;
    if (!isCaptureSupported()) {
      this.options = options;
      this.setState('error');
      throw new Error('当前环境不支持录音（缺少 MediaRecorder 或 getUserMedia）');
    }

    this.options = options;
    this.setState('starting');
    this.mimeType = pickAudioMimeType();
    const notes: string[] = [];

    try {
      if (options.sources.mic) {
        this.micStream = await this.openMic(options.micDeviceId);
      }
      if (options.sources.system) {
        try {
          this.systemStream = await this.openSystemAudio();
        } catch (err) {
          // 内录失败不该让整场录制起不来 —— 降级成只录麦克风，并把原因带回去
          notes.push(`内录未开启（${describeCaptureError(err)}）`);
          this.systemStream = null;
        }
      }
      if (!this.micStream && !this.systemStream) {
        throw new Error('没有任何可用的音频源：麦克风没开，内录也没成功');
      }

      this.mixStream = await this.combine();
      if (!this.mixStream.getAudioTracks().length) {
        throw new Error('音频流里没有可用的音轨');
      }

      options.onResolvedSources?.({
        mic: Boolean(this.micStream),
        system: Boolean(this.systemStream),
        note: notes.length > 0 ? notes.join('；') : undefined,
      });

      this.sessionStartedAt = performance.now();
      this.segmentsStarted = 0;
      this.segmentStartOffsets = [];
      this.setState('recording');
      this.startSegment();
    } catch (err) {
      await this.teardown();
      this.setState('error');
      throw new Error(describeCaptureError(err));
    }
  }

  private async openMic(deviceId?: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        // 见文件头注释：这三项关掉是为了保真，不是为了通话质量
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    });
  }

  /**
   * 系统内录。
   *
   * 这里调 `getDisplayMedia({video:true,audio:true})` —— 在桌面端，
   * 主进程已经用 `setDisplayMediaRequestHandler` 把屏幕源与 loopback 音频自动接好，
   * 所以**不会弹系统选择框**。这也是「面试时不弹任何提示」的一半工作量在这一层的原因。
   *
   * 我们只要音轨。video 轨保留但不用（直接 stop 有让整条 capture 结束的风险）。
   */
  private async openSystemAudio(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('系统没有提供可捕获的音频轨（该平台可能不支持内录）');
    }
    return stream;
  }

  /** 把多路音频合成一路交给 MediaRecorder；只有一路时直接用，省掉一次重编码 */
  private async combine(): Promise<MediaStream> {
    const streams = [this.micStream, this.systemStream].filter(Boolean) as MediaStream[];
    if (streams.length === 1) return streams[0];

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.audioContext = ctx;
    const destination = ctx.createMediaStreamDestination();
    for (const stream of streams) {
      const source = ctx.createMediaStreamSource(stream);
      source.connect(destination);
    }
    return destination.stream;
  }

  private startSegment(): void {
    if (!this.mixStream || this.state !== 'recording') return;
    const index = this.segmentsStarted;
    this.segmentsStarted += 1;
    this.segmentStartOffsets[index] = this.elapsedMs;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.mixStream, {
        ...(this.mimeType ? { mimeType: this.mimeType } : {}),
        audioBitsPerSecond: 48_000,
      });
    } catch {
      // 有些实现不接受 audioBitsPerSecond，退一步用默认参数
      recorder = new MediaRecorder(this.mixStream);
    }
    this.activeRecorder = recorder;

    const chunks: Blob[] = [];
    const startedAt = performance.now();

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const detail = (event as unknown as { error?: { message?: string } }).error;
      this.options?.onError(`录音出错：${detail?.message ?? '未知原因'}`);
    };
    recorder.onstop = () => {
      // 段与段之间用 promise 链串起来，保证落盘顺序与段号一致
      this.inflight = this.inflight.then(() => this.flushSegment(index, chunks, startedAt));
    };

    recorder.start();
    const seconds = Math.max(5, this.options?.segmentSeconds ?? 20);
    this.segmentTimer = setTimeout(() => this.rotateSegment(), seconds * 1000);
  }

  private rotateSegment(): void {
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
    const recorder = this.activeRecorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    this.activeRecorder = null;
    // onstop 里会继续开下一段
    setTimeout(() => {
      if (this.state === 'recording' && !this.activeRecorder) this.startSegment();
    }, 0);
  }

  private async flushSegment(index: number, chunks: Blob[], startedAt: number): Promise<void> {
    if (chunks.length === 0) return; // 空段直接丢弃，避免给转写服务发 0 字节文件
    const type = chunks[0].type || this.mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch {
      return;
    }
    if (bytes.byteLength === 0) return;

    const payload: CaptureSegmentPayload = {
      index,
      fileName: `seg-${String(index + 1).padStart(4, '0')}${extensionForMime(type)}`,
      mimeType: type.split(';')[0] || 'audio/webm',
      bytes,
      startOffsetMs: this.segmentStartOffsets[index] ?? 0,
      durationMs: Math.round(performance.now() - startedAt),
    };
    try {
      await this.options?.onSegment(payload);
    } catch (err) {
      this.options?.onError(`保存录音分片失败：${(err as Error).message}`);
    }
  }

  pause(): void {
    if (this.state !== 'recording') return;
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
    const recorder = this.activeRecorder;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    this.activeRecorder = null;
    this.setState('paused');
    void this.inflight;
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.setState('recording');
    this.startSegment();
  }

  /** 停止并等待最后一段真正落盘 */
  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.setState('stopping');
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
    const recorder = this.activeRecorder;
    this.activeRecorder = null;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        recorder.addEventListener('stop', done, { once: true });
        // 兜底：某些环境下 stop 事件可能不触发
        setTimeout(done, 2000);
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    }
    await this.inflight;
    await this.teardown();
    this.setState('stopped');
  }

  private async teardown(): Promise<void> {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.mixStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.systemStream = null;
    this.mixStream = null;
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        /* 已经关掉就忽略 */
      }
      this.audioContext = null;
    }
    this.sessionStartedAt = 0;
  }
}
