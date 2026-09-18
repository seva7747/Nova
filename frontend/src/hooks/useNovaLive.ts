import { useCallback, useRef, useState } from "react";
import { API_BASE } from "../lib/api";
import { authHeaders } from "../lib/auth";

type LiveCallbacks = {
  /** Fires on every recognized chunk of what the USER is saying, as GPT-Live hears it. */
  onUserTranscript?: (delta: string) => void;
  /** GPT-Live has handed this turn to Nova's real backend (Claude + tools) — nothing to show yet, just "thinking". */
  onDelegating?: () => void;
  /** Fires on every chunk of what NOVA is saying, as she says it. */
  onNovaTranscript?: (delta: string) => void;
  /** The session ended (either side hung up). `usage` is whatever billing summary GPT-Live reported, if any. */
  onClosed?: (usage?: unknown) => void;
  onError?: (message: string) => void;
};

export type LiveConnection = { close: () => void };

/**
 * Thin WebRTC transport for GPT-Live-1: opens a peer connection (mic out,
 * speaker in), does the SDP exchange through our backend (which holds the
 * OpenAI key), and turns the data-channel event stream into a few simple
 * callbacks. All the actual conversation logic (Claude, Composio, deciding
 * what to say) happens server-side in liveDelegate.ts — this hook never sees
 * any of that, it just carries audio and tells the UI what's happening.
 *
 * Docs: https://developers.openai.com/api/docs/guides/voice-webrtc
 */
export function useNovaLive() {
  const [level, setLevel] = useState(0);
  const meterRafRef = useRef(0);

  const connect = useCallback(
    async (
      opts: {
        timezone?: string;
        voice?: string;
        /** Set only for a session opened automatically to deliver a reminder (see useNovaConversation.ts) — Nova speaks this the instant the session connects, unprompted, instead of waiting for the user to talk first. */
        announce?: string;
      } & LiveCallbacks
    ): Promise<LiveConnection> => {
      const pc = new RTCPeerConnection();
      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;

      let micStream: MediaStream | undefined;
      let dataChannel: RTCDataChannel | undefined;
      let audioCtx: AudioContext | undefined;
      let closed = false;
      let closedNotified = false;

      const cleanup = () => {
        cancelAnimationFrame(meterRafRef.current);
        setLevel(0);
        micStream?.getTracks().forEach((t) => t.stop());
        audioCtx?.close().catch(() => {});
        dataChannel?.close();
        pc.close();
        remoteAudio.srcObject = null;
      };

      const notifyClosed = (usage?: unknown) => {
        if (closedNotified) return;
        closedNotified = true;
        opts.onClosed?.(usage);
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (dataChannel?.readyState === "open") {
          dataChannel.send(JSON.stringify({ type: "session.close" }));
        }
        // The server confirms with session.closed → notifyClosed(usage) below;
        // if that never arrives (dropped connection, etc.) don't leave media
        // hanging open, or the caller's state machine stuck waiting forever.
        window.setTimeout(() => {
          cleanup();
          notifyClosed();
        }, 4000);
      };

      pc.addEventListener("track", (event) => {
        remoteAudio.srcObject = new MediaStream([event.track]);
        remoteAudio.play().catch(() => {});
      });

      // If the peer connection itself drops (network blip, OpenAI-side hangup
      // that never reached the data channel, etc.) don't leave the caller
      // waiting on a session.closed event that's never coming.
      pc.addEventListener("connectionstatechange", () => {
        if (!closed && (pc.connectionState === "failed" || pc.connectionState === "disconnected")) {
          closed = true;
          cleanup();
          notifyClosed();
        }
      });

      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error("Nova needs microphone access for live voice mode.");
      }
      for (const track of micStream.getAudioTracks()) pc.addTrack(track, micStream);

      // A simple RMS meter on the mic, purely so the orb can react visually
      // while the user is talking.
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(micStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const meterData = new Uint8Array(analyser.frequencyBinCount);
      const tickMeter = () => {
        analyser.getByteTimeDomainData(meterData);
        let sumSquares = 0;
        for (let i = 0; i < meterData.length; i++) {
          const v = (meterData[i] - 128) / 128;
          sumSquares += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sumSquares / meterData.length) * 6));
        meterRafRef.current = requestAnimationFrame(tickMeter);
      };
      meterRafRef.current = requestAnimationFrame(tickMeter);

      dataChannel = pc.createDataChannel("oai-events");
      dataChannel.addEventListener("message", ({ data }) => {
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }

        switch (event.type) {
          case "session.input_transcript.delta":
            opts.onUserTranscript?.(event.delta ?? "");
            break;
          case "session.delegation.created":
            opts.onDelegating?.();
            break;
          case "session.output_transcript.delta":
            opts.onNovaTranscript?.(event.delta ?? "");
            break;
          case "session.closed":
            closed = true;
            cleanup();
            notifyClosed(event.usage);
            break;
          case "error":
            opts.onError?.(event.error?.message ?? "Live session error.");
            break;
          default:
            break;
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (pc.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", onState);
            resolve(); // proceed with whatever candidates we have rather than hang forever
          }, 4000);
          function onState() {
            if (pc.iceGatheringState !== "complete") return;
            window.clearTimeout(timeout);
            pc.removeEventListener("icegatheringstatechange", onState);
            resolve();
          }
          pc.addEventListener("icegatheringstatechange", onState);
        });
      }

      const sdp = pc.localDescription?.sdp;
      if (!sdp) {
        cleanup();
        throw new Error("Couldn't build a WebRTC offer.");
      }

      let resp: Response;
      try {
        resp = await fetch(`${API_BASE}/api/live/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ sdp, timezone: opts.timezone, voice: opts.voice, announce: opts.announce }),
        });
      } catch {
        cleanup();
        throw new Error("Nova's backend isn't reachable — is it running on port 8787?");
      }

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        cleanup();
        throw new Error(body?.error ?? "Live session creation failed.");
      }

      const { sdp: answerSdp } = await resp.json();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      return { close };
    },
    []
  );

  return { connect, level };
}
