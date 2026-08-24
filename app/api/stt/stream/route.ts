import { Agent } from "undici";
import {
  createTranscriptStream,
  type Parsed,
} from "../../../../lib/voice/deepgram-protocol.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Matches the other long-lived routes in this app. Without it the platform's
 * short default applies and recognition dies a few seconds into a check-in.
 */
export const maxDuration = 300;

/**
 * Relays microphone audio to the recogniser, so the credential never leaves the
 * server.
 *
 * The browser cannot talk to Deepgram directly without a short-lived token, and
 * this account's key cannot mint one. The alternative — a long-lived key in a
 * NEXT_PUBLIC_ variable — would hand a paid transcription account to anyone who
 * opens devtools. So audio goes to us and we go to them, which is also the
 * answer a clinical system wants regardless: the audio path stays inside
 * infrastructure that can be audited, logged and covered by an agreement,
 * instead of a browser opening a socket to a third party nobody has a record of.
 *
 * **Request streaming in, SSE out**, rather than a WebSocket. A WebSocket here
 * would mean a new dependency and a deployment shape this project has not tried;
 * a streamed POST body with an event-stream response is the same duplex
 * behaviour over plumbing that already works on the Node runtime. It needs
 * `duplex: "half"` on the browser side, which is Chromium-only — the same
 * constraint the Web Speech API already imposed, so nothing is lost.
 */
const deepgramParams = (sampleRate: number) => ({
  model: process.env.DEEPGRAM_MODEL ?? "nova-3-medical",
  encoding: "linear16",
  sample_rate: String(sampleRate),
  channels: "1",
  smart_format: "true",
  interim_results: "true",
  // Long enough that a pause for breath is not a turn, short enough that the
  // agent does not sit in silence. Elderly participants pause mid-sentence.
  endpointing: "500",
  language: "en",
});

/**
 * The rate the browser actually produced, which is not always the rate we asked
 * for. `AudioContext({ sampleRate })` is a request; some browsers hand back a
 * 48 kHz context regardless. Declaring that audio as 16 kHz makes the recogniser
 * transcribe it at triple speed as nonsense, with nothing anywhere reporting an
 * error — so capture reads its real rate back and sends it, and this is where it
 * is believed. Bounded because it arrives from the client.
 */
/**
 * The same h2 problem `lib/agent/runner.ts` already pins its own agent for, on a
 * socket that never got the treatment.
 *
 * Node negotiates HTTP/2 for the upgrade, and when the recogniser *refuses* the
 * handshake — rotated key, revoked scope, exhausted quota — undici emits an
 * unhandled error on the internal h2 stream instead of on the WebSocket. Neither
 * the error nor the close listener below ever fires, and the uncaught
 * `SocketError: other side closed` takes the server process down. Reproduced
 * with a bogus token; with `allowH2: false` the same token fires the error
 * listener, closes 1006, and the process lives.
 *
 * Worth being precise about what that cost: a refused handshake is exactly the
 * state the fallback to the browser recogniser was built for, and crashing
 * instead of reporting made that fallback unreachable.
 */
const socketAgent = new Agent({ allowH2: false, connections: 32 });

/**
 * How many recognition sockets this instance will hold at once.
 *
 * The route is unauthenticated and every request opens a socket billed by
 * connected time for up to four minutes, so without a ceiling one caller can
 * spend the transcription account. This bounds the damage rather than preventing
 * it — the count is per instance, so a serverless deployment multiplies it, and
 * the real answer is authentication (recorded as 4.10). A pilot runs one call at
 * a time; this is set well above that and well below anything expensive.
 */
const MAX_CONCURRENT_SESSIONS = 8;
let liveSessions = 0;

const RATE_RANGE = { min: 8_000, max: 96_000 };
/** Matches `TARGET_SAMPLE_RATE` in capture.ts; not imported, because that module
 *  reaches for `navigator` and belongs in the browser bundle. */
const FALLBACK_SAMPLE_RATE = 16_000;

function requestedRate(url: string): number {
  const raw = Number(new URL(url).searchParams.get("rate"));
  if (!Number.isFinite(raw) || raw < RATE_RANGE.min || raw > RATE_RANGE.max) {
    return FALLBACK_SAMPLE_RATE;
  }
  return Math.round(raw);
}

/**
 * Bounds on how long one relay may live.
 *
 * Deepgram bills by connected time, and a client that sends two bytes of
 * nonsense and stops used to hold a socket open until the far end lost patience
 * — found by POSTing `{}` at it and watching the request hang.
 *
 * Kept under `maxDuration` on purpose. A call with barge-in on holds a single
 * session for its whole length, so on a platform that kills the function at 300s
 * the session has to end before that: closing ourselves lets the client see a
 * clean end and open a fresh session, where being killed mid-stream just looks
 * to the participant like the microphone died.
 */
const MAX_SESSION_MS = 4 * 60 * 1000;
/**
 * After the audio ends we owe the recogniser a moment to flush a final. If it
 * has not closed by then it is not going to.
 */
const FLUSH_GRACE_MS = 5_000;

export async function POST(request: Request) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    return Response.json(
      { error: "DEEPGRAM_API_KEY is not set; speech recognition is unavailable." },
      { status: 503 },
    );
  }
  if (!request.body) {
    return Response.json({ error: "Expected a streamed audio body." }, { status: 400 });
  }
  if (liveSessions >= MAX_CONCURRENT_SESSIONS) {
    return Response.json(
      { error: "Too many recognition sessions are open. Try again in a moment." },
      { status: 429 },
    );
  }
  const upstream = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${new URLSearchParams(deepgramParams(requestedRate(request.url)))}`,
    {
      headers: { Authorization: `Token ${key}` },
      dispatcher: socketAgent,
    } as unknown as string[],
  );
  // Counted only once the socket exists, so a constructor that throws cannot
  // leak a slot. Nothing awaits between the check above and here, so there is no
  // window for a second request to slip through.
  liveSessions += 1;

  const encoder = new TextEncoder();
  const transcripts = createTranscriptStream();

  // Held out here rather than inside start(), because cancel() has to be able to
  // reach them. When the participant closes the tab, cancel() fires and the
  // recogniser keeps talking for a moment afterwards; a listener that then
  // enqueued onto the dead controller threw out of an event handler, which is an
  // unhandled exception in the server process rather than a caught error.
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let cap: ReturnType<typeof setTimeout> | undefined;

  const send = (event: unknown) => {
    if (closed || !sink) return;
    try {
      sink.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      // The client went away between the guard and the write. Nothing more can
      // be delivered, so stop trying.
      closed = true;
    }
  };

  /**
   * Hands over whatever the participant had said but the endpointer never
   * closed. Idempotent — the accumulator empties itself — so a path that needs
   * the final to precede something else can call it early and finish() will
   * still cover every path that does not.
   */
  const drain = () => {
    const stranded = transcripts.onClose();
    if (stranded) send({ type: "final", heard: stranded });
  };

  /**
   * Reports a failure, after handing over anything the participant had already
   * said.
   *
   * The order is the whole point and it has now been got wrong at two separate
   * sites. The client clears a reported error as soon as a transcript arrives,
   * so an error sent before the flush is erased by it — an exhausted quota
   * mid-utterance then looks like a clean session end, with no banner and the
   * first-attempt fallback quietly disabled. Every error goes through here so
   * there is no third site to get it wrong.
   */
  const sendError = (message: string) => {
    drain();
    send({ type: "error", message });
  };

  const closeUpstream = () => {
    try {
      upstream.close();
    } catch {
      /* already gone */
    }
  };

  /**
   * Ends the stream, and drains the accumulator on the way out.
   *
   * The draining belongs here rather than at the call sites. There are four ways
   * out — the session cap, the upstream close, the flush-grace timer and an
   * upstream error — and three separate reviews each found a different one of
   * them closing before it flushed, losing whatever the participant had said so
   * far. Three fixes in three places invited a fourth omission; doing it once,
   * where the closing happens, means a new exit path cannot forget.
   *
   * Order matters: `send` is a no-op once `closed` is set, so the flush has to
   * happen before the flag.
   */
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    liveSessions -= 1;
  };

  const finish = () => {
    // Unconditional, and before the guard. send()'s catch sets `closed` on its
    // own when the client vanishes mid-write, so a slot released only past this
    // point was never released at all — and eight of those 429 the route for the
    // life of the instance. Both are idempotent.
    clearTimeout(cap);
    release();
    if (closed) return;
    drain();
    closed = true;
    try {
      sink?.close();
    } catch {
      /* already closed by the client going away */
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      sink = controller;

      cap = setTimeout(() => {
        // Rotating a session we chose to bound, not a failure — the client opens
        // a fresh one. Reported as an error it surfaced to the operator as a red
        // recognition-failure banner in the middle of a call where recognition
        // was working fine. finish() flushes whatever was mid-sentence.
        send({ type: "closed", reason: "session-cap" });
        closeUpstream();
        finish();
      }, MAX_SESSION_MS);
      cap.unref?.();

      upstream.addEventListener("message", (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }

        // Operational frames, not transcripts. The transcript parser ignores
        // anything without text, so these vanished — and a session that ends
        // clean but transcribes nothing reads to the client as success, retries
        // four times, then drops to the recogniser this sprint replaced, with
        // nothing anywhere saying why.
        const kind = (raw as { type?: string } | null)?.type;
        if (kind === "Error" || kind === "Warning") {
          const detail = (raw as { description?: string; message?: string }).description
            ?? (raw as { message?: string }).message
            ?? kind;
          // A warning is not a verdict on whether the relay works. Routing it
          // through the same channel as an error made a single advisory frame
          // downgrade the whole check-in to the browser recogniser — losing
          // per-word confidence and echo cancellation over a notice. The client
          // ignores `notice`; it is here so a log has it.
          const note = `The transcription service reported: ${detail}`;
          if (kind === "Error") sendError(note);
          else send({ type: "notice", message: note });
          return;
        }

        let parsed: Parsed;
        try {
          parsed = transcripts.onMessage(raw);
        } catch {
          return;
        }
        if (parsed.kind !== "ignore" && parsed.heard) {
          send({ type: parsed.kind, heard: parsed.heard });
        }
      });

      upstream.addEventListener("close", () => {
        // Anything the endpointer never got to finish is flushed by finish(). A
        // call that drops mid sentence would otherwise lose the last thing said.
        send({ type: "closed" });
        finish();
      });

      upstream.addEventListener("error", () => {
        sendError("The transcription service disconnected.");
        finish();
      });

      // Wait for the socket before forwarding, or the first frames are dropped
      // silently — which sounds exactly like the microphone not working.
      await new Promise<void>((resolve) => {
        if (upstream.readyState === WebSocket.OPEN) return resolve();
        upstream.addEventListener("open", () => resolve(), { once: true });
        upstream.addEventListener("error", () => resolve(), { once: true });
      });

      const reader = request.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (closed) break;
          if (value?.byteLength && upstream.readyState === WebSocket.OPEN) {
            upstream.send(value);
          }
        }
      } catch {
        /* the client hung up; fall through and close cleanly */
      }

      if (!closed && upstream.readyState === WebSocket.OPEN) {
        // Asks the recogniser to flush rather than dropping the connection, so a
        // trailing utterance still gets a final.
        upstream.send(JSON.stringify({ type: "CloseStream" }));
        setTimeout(() => {
          // This timer exists precisely for a recogniser that never sends the
          // final — measured, three settled segments and no final at all — so
          // the flush inside finish() is the whole point of it.
          closeUpstream();
          finish();
        }, FLUSH_GRACE_MS).unref?.();
      } else {
        // Reached when the read loop stopped because the stream was already
        // closed — including from send()'s catch, where neither cancel() nor
        // finish() ran. The socket has to be closed on every way out or it stays
        // connected and billed until the cap timer notices.
        closeUpstream();
        finish();
      }
    },

    cancel() {
      // The participant hung up. Mark the stream dead before tearing the socket
      // down, so the close and error events that follow do not try to write.
      closed = true;
      clearTimeout(cap);
      release();
      closeUpstream();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
