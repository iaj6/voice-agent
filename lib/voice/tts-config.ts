/**
 * Pinned speech synthesis configuration.
 *
 * The voice is part of the instrument. Two subjects on different devices must
 * hear the same thing, and the voice must not change mid-trial — that is the
 * whole reason for moving off the browser's built-in synthesis, where the voice
 * varies by operating system and browser version.
 *
 * Treat every constant in this file as under change control. Changing the voice
 * or model mid-study changes the instrument and needs the same documentation as
 * any other protocol amendment.
 */

/** River — middle-aged, American, conversational, labelled "calm". */
export const VOICE_ID = "SAz9YHcvj6GT2YYXdXww";
export const VOICE_NAME = "River";

/**
 * Flash v2.5. Measured at ~240ms median time-to-first-byte with a 38ms spread,
 * against ~744ms and a 384ms spread for the fastest OpenAI alternative. For a
 * voice agent, consistency of pacing matters as much as the median — uneven
 * gaps read as a broken line.
 */
export const MODEL_ID = "eleven_flash_v2_5";

/** Raw PCM avoids the frame buffering an MP3 encoder adds ahead of first byte. */
export const OUTPUT_FORMAT = "mp3_22050_32";

export const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  /** Slightly under natural pace. The listener may be fatigued or medicated. */
  speed: 0.94,
} as const;

/** Give up on the network and fall back to local synthesis after this. */
export const SYNTHESIS_TIMEOUT_MS = 3_000;
