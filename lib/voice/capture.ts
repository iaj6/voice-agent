/**
 * The microphone, with echo cancellation actually asked for and checked.
 *
 * The browser recogniser did its own capture and would not accept a constrained
 * stream, which is why this project has a text-level echo filter: the agent's
 * own speech came back through the microphone and had to be recognised as an
 * echo *after* being transcribed. Comparing strings to work out whether the
 * agent heard itself is a workaround for not having acoustic echo cancellation.
 *
 * Owning capture means asking for AEC properly. It also means checking: a
 * constraint is a request, and `getSettings()` is the only way to learn whether
 * the browser honoured it. A pipeline that assumes it got echo cancellation and
 * did not is one where the agent talks over itself and nobody knows why.
 */

export interface CaptureSettings {
  /** What was actually applied, not what was asked for. */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  sampleRate: number;
  channelCount: number;
}

export interface Capture {
  /** 16-bit little-endian PCM at 16 kHz, mono. */
  readonly frames: ReadableStream<Uint8Array>;
  readonly settings: CaptureSettings;
  stop(): void;
}

export const TARGET_SAMPLE_RATE = 16_000;

export async function startCapture(): Promise<Capture> {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });

  const track = media.getAudioTracks()[0];
  const applied = track?.getSettings() ?? {};

  // Everything past this point can fail with the microphone already granted and
  // live — an undeployed worklet, an offline reload, a CSP that blocks it. The
  // caller sees a thrown error and reports it, but nothing would stop the
  // tracks: the browser's recording indicator stays lit for the life of the
  // page, on a call where the participant has been told the microphone is off.
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode;
  let worklet: AudioWorkletNode;
  try {
    // Constructed at the recogniser's rate so the browser resamples in native
    // code. Some browsers ignore the hint, which is why the real rate is read
    // back and reported rather than assumed.
    context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    await context.audioWorklet.addModule("/pcm-worklet.js");
    source = context.createMediaStreamSource(media);
    worklet = new AudioWorkletNode(context, "pcm-worklet");
  } catch (err) {
    for (const t of media.getTracks()) t.stop();
    void context?.close().catch(() => {});
    throw err;
  }

  let push: ((chunk: Uint8Array) => void) | null = null;
  let closeStream: (() => void) | null = null;

  const frames = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => {
        try {
          controller.enqueue(chunk);
        } catch {
          /* consumer went away */
        }
      };
      closeStream = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
    cancel() {
      stop();
    },
  });

  worklet.port.onmessage = (event) => {
    push?.(new Uint8Array(event.data as ArrayBuffer));
  };
  source.connect(worklet);
  // Deliberately not connected to the destination. Routing the microphone to the
  // speakers is how a call becomes a feedback loop.

  const audio = context;
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    worklet.port.onmessage = null;
    try {
      source.disconnect();
      worklet.disconnect();
    } catch {
      /* already torn down */
    }
    for (const t of media.getTracks()) t.stop();
    void audio.close();
    closeStream?.();
  }

  return {
    frames,
    settings: {
      echoCancellation: applied.echoCancellation === true,
      noiseSuppression: applied.noiseSuppression === true,
      autoGainControl: applied.autoGainControl === true,
      sampleRate: audio.sampleRate,
      channelCount: applied.channelCount ?? 1,
    },
    stop,
  };
}
