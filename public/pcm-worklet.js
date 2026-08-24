/**
 * Turns the microphone into 16-bit PCM frames for the recogniser.
 *
 * An AudioWorklet rather than a ScriptProcessorNode: the deprecated node runs on
 * the main thread, so a React render or a garbage collection pause drops audio,
 * and dropped audio on a check-in call is a dropped word in a medical record.
 *
 * Resampling is left to the AudioContext, which is constructed at 16 kHz and
 * does it in native code. Hand-written resampling here would be a worse version
 * of something the platform already does correctly.
 */
class PcmWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    // Float32 [-1, 1] to signed 16-bit little-endian, which is what
    // `encoding=linear16` means.
    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
