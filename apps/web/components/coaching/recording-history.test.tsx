import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordingHistory } from "./recording-history";

describe("RecordingHistory", () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 }))));

  it("links saved takes to coaching and offers permanent removal", () => {
    const markup = renderToStaticMarkup(<RecordingHistory playId="play_1" initialItems={[{
      id: "take_1", createdAt: "2026-09-26T12:00:00.000Z", durationMs: 65_000, state: "completed",
      sceneTitle: "The room", roleName: "Morgan", durationVerified: true,
    }]} />);

    expect(markup).toContain("The room");
    expect(markup).toContain("Morgan · 1:05");
    expect(markup).toContain('/plays/play_1/takes/take_1');
    expect(markup).not.toContain("<audio");
    expect(markup).toContain(">Remove</button>");
  });

  it("displays the complete persisted duration for recordings longer than thirty seconds", () => {
    const markup = renderToStaticMarkup(<RecordingHistory playId="play_1" initialItems={[{
      id: "take_1", createdAt: "2026-09-27T18:15:18.000Z", durationMs: 360_000, state: "completed",
      sceneTitle: "Scene One", roleName: "Jason",
    }]} />);

    expect(markup).toContain("Jason · 6:00");
    expect(markup).not.toContain("Jason · 0:30");
  });

  it("replaces a stale persisted duration with the duration read from the recording", async () => {
    let rendered!: ReactTestRenderer;
    await act(async () => {
      rendered = create(<RecordingHistory playId="play_1" initialItems={[{
        id: "take_1", createdAt: "2026-09-27T18:15:18.000Z", durationMs: 30_000, state: "completed",
        sceneTitle: "Scene One", roleName: "Jason", verifyDuration: true,
      }]} />);
    });

    expect(rendered.root.findByType("p").children.join("")).toContain("Jason · 0:30");
    await act(async () => rendered.root.findByType("audio").props.onLoadedMetadata({
      currentTarget: { duration: 363 },
    }));
    expect(rendered.root.findByType("p").children.join("")).toContain("Jason · 6:03");
    expect(fetch).toHaveBeenCalledWith("/api/plays/play_1/takes/take_1/duration", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ durationMs: 363_000 }),
    });
  });

  it("loads recording metadata sequentially so every saved take is checked", async () => {
    let rendered!: ReactTestRenderer;
    await act(async () => {
      rendered = create(<RecordingHistory playId="play_1" initialItems={[
        { id: "take_1", createdAt: "2026-09-27T18:15:18.000Z", durationMs: 30_000, state: "completed",
          sceneTitle: "Scene One", roleName: "Jason", verifyDuration: true },
        { id: "take_2", createdAt: "2026-09-26T18:15:18.000Z", durationMs: 30_000, state: "completed",
          sceneTitle: "Scene One", roleName: "Jason", verifyDuration: true },
      ]} />);
    });

    expect(rendered.root.findByType("audio").props.src).toContain("take_1/audio");
    await act(async () => rendered.root.findByType("audio").props.onLoadedMetadata({
      currentTarget: { duration: 364 },
    }));
    expect(rendered.root.findByType("audio").props.src).toContain("take_2/audio");
    await act(async () => rendered.root.findByType("audio").props.onLoadedMetadata({
      currentTarget: { duration: 380 },
    }));

    expect(rendered.root.findAllByType("audio")).toHaveLength(0);
    expect(rendered.root.findAllByType("p").map(({ children }) => children.join("")))
      .toEqual(expect.arrayContaining([expect.stringContaining("6:04"), expect.stringContaining("6:20")]));
  });
});
