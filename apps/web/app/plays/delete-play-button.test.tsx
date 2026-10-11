import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DeletePlayButton } from "./delete-play-button";

describe("DeletePlayButton", () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));
    vi.stubGlobal("window", { confirm: vi.fn(() => true), location: { reload: vi.fn() } });
  });

  it("confirms and deletes the selected play", async () => {
    let rendered!: ReactTestRenderer;
    await act(async () => { rendered = create(<DeletePlayButton playId="play-1" title="Hamlet" />); });
    await act(async () => { await rendered.root.findByType("button").props.onClick(); });

    expect(window.confirm).toHaveBeenCalledWith("Delete “Hamlet”? This cannot be undone.");
    expect(fetch).toHaveBeenCalledWith("/api/plays/play-1", { method: "DELETE" });
    expect(window.location.reload).toHaveBeenCalled();
  });

  it("does nothing when deletion is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    let rendered!: ReactTestRenderer;
    await act(async () => { rendered = create(<DeletePlayButton playId="play-1" title="Hamlet" />); });
    await act(async () => { await rendered.root.findByType("button").props.onClick(); });
    expect(fetch).not.toHaveBeenCalled();
  });
});
