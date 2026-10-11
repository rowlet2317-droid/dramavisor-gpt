import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecorderControls, recorderControlState } from "./recorder-controls";

describe("RecorderControls", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["checking", "starting", "stopping", "uploading"] as const)(
    "disables every conflicting action while %s",
    (phase) => {
      expect(recorderControlState(phase)).toEqual({ startDisabled: true, stopDisabled: true,
        cancelDisabled: true });
    },
  );

  it("renders an explicit Start recording gesture and audio-retention choices", () => {
    const markup = renderToStaticMarkup(<RecorderControls playId="play-1" sceneId="scene-1"
      playModelVersion={2} roles={[{ id: "role-1", name: "Alex" }]} />);

    expect(markup).toContain("Start recording");
    expect(markup).toContain("Keep this recording for progress comparison");
    expect(markup).toContain("Delete this recording after analysis");
    expect(markup).not.toContain("video");
  });

  it("cancels a pending recorder when the component unmounts during the microphone check", async () => {
    const started = Promise.withResolvers<void>();
    const recorder = fakeRecorder(() => started.promise);
    let rendered!: ReactTestRenderer;
    await act(async () => {
      rendered = create(<RecorderControls playId="play-1" sceneId="scene-1" playModelVersion={2}
        roles={[{ id: "role-1", name: "Alex" }]} createRecorder={() => recorder} />);
    });
    await act(async () => {
      rendered.root.findAllByType("button")[0]!.props.onClick();
      await Promise.resolve();
    });

    await act(async () => rendered.unmount());
    started.resolve();
    await act(async () => started.promise);

    expect(recorder.cancel).toHaveBeenCalledOnce();
  });

  it("cancels an active recording when the component unmounts", async () => {
    const recorder = fakeRecorder(async () => undefined);
    let rendered!: ReactTestRenderer;
    await act(async () => {
      rendered = create(<RecorderControls playId="play-1" sceneId="scene-1" playModelVersion={2}
        roles={[{ id: "role-1", name: "Alex" }]} createRecorder={() => recorder} />);
    });
    await act(async () => {
      rendered.root.findAllByType("button")[0]!.props.onClick();
      await Promise.resolve();
    });

    await act(async () => rendered.unmount());

    expect(recorder.start).toHaveBeenCalledOnce();
    expect(recorder.cancel).toHaveBeenCalledOnce();
  });
});

function fakeRecorder(start: () => Promise<void>) {
  return { start: vi.fn(start), stop: vi.fn(async () => ({ blob: new Blob(), durationMs: 1,
    mimeType: "audio/webm" })), cancel: vi.fn() };
}
