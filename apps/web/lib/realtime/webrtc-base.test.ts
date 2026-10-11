import { describe, expect, it, vi } from "vitest";

import { WebRtcBase } from "./webrtc-base";

describe("WebRtcBase", () => {
  it("negotiates a receive-only audio track for output-only realtime sessions", async () => {
    const channel = {
      readyState: "open" as const,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const peer = {
      connectionState: "new",
      onconnectionstatechange: null,
      ontrack: null,
      createDataChannel: vi.fn(() => channel),
      addTrack: vi.fn(),
      addTransceiver: vi.fn(),
      createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const base = new WebRtcBase({
      createPeerConnection: () => peer,
      fetch: vi.fn(async () => new Response("answer-sdp")),
      onProviderEvent: () => undefined,
      onDisconnected: () => undefined,
      onMediaFailure: () => undefined,
    });

    await base.connect({ clientSecret: "ek_test", expiresAt: "2099-01-01T00:00:00.000Z",
      model: "gpt-realtime-2.1", rehearsalSessionId: "session_1" });

    expect(peer.addTransceiver).toHaveBeenCalledWith("audio", { direction: "recvonly" });
    expect(peer.addTrack).not.toHaveBeenCalled();
  });
});
