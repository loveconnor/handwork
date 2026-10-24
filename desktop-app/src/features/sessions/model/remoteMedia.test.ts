import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_MEDIA_PREFIXES,
  isRemoteMediaUrl,
  sniffRemoteMedia,
} from "./remoteMedia";

describe("isRemoteMediaUrl", () => {
  it("allows GitHub and Linear attachment hosts", () => {
    expect(
      isRemoteMediaUrl(
        "https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
    ).toBe(true);
    expect(
      isRemoteMediaUrl("https://github.com/acme/web/assets/12/aaaaaaaa-bbbb"),
    ).toBe(true);
    expect(
      isRemoteMediaUrl("https://user-images.githubusercontent.com/1/shot.png"),
    ).toBe(true);
    expect(
      isRemoteMediaUrl("https://uploads.linear.app/org/uuid/file.png"),
    ).toBe(true);
  });

  it("rejects pages, other hosts, and traversal", () => {
    expect(isRemoteMediaUrl("https://github.com/acme/web/issues/1")).toBe(
      false,
    );
    expect(
      isRemoteMediaUrl("https://github.com/user-attachments/../login"),
    ).toBe(false);
    expect(
      isRemoteMediaUrl("http://github.com/user-attachments/assets/x"),
    ).toBe(false);
    expect(isRemoteMediaUrl("https://evil.example/shot.png")).toBe(false);
    expect(
      isRemoteMediaUrl("https://github.com.evil.com/user-attachments/assets/x"),
    ).toBe(false);
  });
});

describe("REMOTE_MEDIA_PREFIXES", () => {
  it("stays on HTTPS attachment hosts", () => {
    expect(
      REMOTE_MEDIA_PREFIXES.every((prefix) => prefix.startsWith("https://")),
    ).toBe(true);
    expect(
      REMOTE_MEDIA_PREFIXES.some((prefix) =>
        prefix.startsWith("https://github.com/user-attachments/"),
      ),
    ).toBe(true);
  });
});

describe("sniffRemoteMedia", () => {
  it("keeps images and recognizes mp4 and webm", () => {
    expect(
      sniffRemoteMedia(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toEqual({ kind: "image", mime: "image/png" });
    expect(
      sniffRemoteMedia(
        new Uint8Array([
          0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
        ]),
      ),
    ).toEqual({ kind: "video", mime: "video/mp4" });
    expect(
      sniffRemoteMedia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])),
    ).toEqual({ kind: "video", mime: "video/webm" });
  });

  it("does not treat avif, pdf or html as video", () => {
    expect(
      sniffRemoteMedia(
        new Uint8Array([
          0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
        ]),
      ),
    ).toEqual({ kind: "image", mime: "image/avif" });
    expect(
      sniffRemoteMedia(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
      ),
    ).toBeNull();
    expect(
      sniffRemoteMedia(new TextEncoder().encode("<html><script>x()</script>")),
    ).toBeNull();
  });
});

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("fetchRemoteMedia", () => {
  const MB = 1024 * 1024;
  const url = (i: number) =>
    `https://github.com/user-attachments/assets/cache-${i}`;
  let fetchRemoteMedia: typeof import("./remoteMedia").fetchRemoteMedia;

  beforeEach(async () => {
    invoke.mockReset();
    vi.resetModules();
    ({ fetchRemoteMedia } = await import("./remoteMedia"));
  });

  it("shares a request in flight and serves repeats from cache", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(16));
    const [first, second] = await Promise.all([
      fetchRemoteMedia(url(100)),
      fetchRemoteMedia(url(100)),
    ]);
    expect(first).toBe(second);
    expect(await fetchRemoteMedia(url(100))).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps cached bytes under a total budget", async () => {
    invoke.mockImplementation(async () => new ArrayBuffer(10 * MB));
    for (let i = 0; i < 6; i += 1) await fetchRemoteMedia(url(i));
    expect(invoke).toHaveBeenCalledTimes(6);

    // The newest files are still cached; the oldest were dropped.
    await fetchRemoteMedia(url(5));
    expect(invoke).toHaveBeenCalledTimes(6);
    await fetchRemoteMedia(url(0));
    expect(invoke).toHaveBeenCalledTimes(7);
  });

  it("refreshes recency on cache hits before evicting", async () => {
    invoke.mockImplementation(async () => new ArrayBuffer(10 * MB));
    const first = await fetchRemoteMedia(url(0));
    const second = await fetchRemoteMedia(url(1));
    const third = await fetchRemoteMedia(url(2));

    // Compare identities as booleans so Vitest never deep-compares large arrays.
    expect((await fetchRemoteMedia(url(0))) === first).toBe(true);
    const fourth = await fetchRemoteMedia(url(3));

    expect((await fetchRemoteMedia(url(0))) === first).toBe(true);
    expect((await fetchRemoteMedia(url(2))) === third).toBe(true);
    expect((await fetchRemoteMedia(url(3))) === fourth).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect((await fetchRemoteMedia(url(1))) === second).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it.each([0, 1])(
    "evicts older mixed-size entry %i to fit the byte budget",
    async (older) => {
      const sizes = new Map([
        [url(0), 4 * MB],
        [url(1), 8 * MB],
        [url(2), 20 * MB],
        [url(3), 12 * MB],
      ]);
      invoke.mockImplementation(
        async (_command, { url: src }: { url: string }) =>
          new ArrayBuffer(sizes.get(src)!),
      );
      const small = await fetchRemoteMedia(url(0));
      const medium = await fetchRemoteMedia(url(1));
      const large = await fetchRemoteMedia(url(2));

      // All three entries fit at exactly 32 MiB.
      expect((await fetchRemoteMedia(url(0))) === small).toBe(true);
      expect((await fetchRemoteMedia(url(1))) === medium).toBe(true);
      expect((await fetchRemoteMedia(url(2))) === large).toBe(true);
      expect(invoke).toHaveBeenCalledTimes(3);

      // Adding 12 MiB must evict both the 4 MiB and 8 MiB entries.
      const newest = await fetchRemoteMedia(url(3));
      expect((await fetchRemoteMedia(url(2))) === large).toBe(true);
      expect((await fetchRemoteMedia(url(3))) === newest).toBe(true);
      expect(invoke).toHaveBeenCalledTimes(4);

      const previous = older === 0 ? small : medium;
      expect((await fetchRemoteMedia(url(older))) === previous).toBe(false);
      expect(invoke).toHaveBeenCalledTimes(5);
    },
  );

  it("evicts when one new byte exceeds the exact budget", async () => {
    invoke.mockImplementation(async () => new ArrayBuffer(16 * MB));
    const first = await fetchRemoteMedia(url(0));
    const second = await fetchRemoteMedia(url(1));

    expect((await fetchRemoteMedia(url(0))) === first).toBe(true);
    expect((await fetchRemoteMedia(url(1))) === second).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);

    invoke.mockResolvedValueOnce(new ArrayBuffer(1));
    const tiny = await fetchRemoteMedia(url(2));
    expect((await fetchRemoteMedia(url(1))) === second).toBe(true);
    expect((await fetchRemoteMedia(url(2))) === tiny).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect((await fetchRemoteMedia(url(0))) === first).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("returns oversized responses without caching or evicting existing entries", async () => {
    invoke.mockResolvedValueOnce(new ArrayBuffer(16 * MB));
    invoke.mockImplementation(async () => new ArrayBuffer(32 * MB + 1));
    const cached = await fetchRemoteMedia(url(0));
    const oversized = await fetchRemoteMedia(url(1));

    expect(oversized.byteLength).toBe(32 * MB + 1);
    expect((await fetchRemoteMedia(url(0))) === cached).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    const repeat = await fetchRemoteMedia(url(1));
    expect(repeat.byteLength).toBe(32 * MB + 1);
    expect(repeat === oversized).toBe(false);
    expect((await fetchRemoteMedia(url(0))) === cached).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("retries after a failed request", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    invoke.mockResolvedValueOnce(new ArrayBuffer(8));
    await expect(fetchRemoteMedia(url(200))).rejects.toThrow("offline");
    expect((await fetchRemoteMedia(url(200))).byteLength).toBe(8);
  });
});
