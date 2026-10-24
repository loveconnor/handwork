import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  getVersion: vi.fn(),
  message: vi.fn(),
  relaunch: vi.fn(),
  remember: vi.fn(),
  forget: vi.fn(),
  ask: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mocks.getVersion,
  getBundleType: vi.fn().mockResolvedValue("nsis"),
  BundleType: {
    Nsis: "nsis",
    Msi: "msi",
    Deb: "deb",
    Rpm: "rpm",
    AppImage: "appimage",
    App: "app",
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: mocks.ask,
  message: mocks.message,
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("../../features/settings/model/sounds", () => ({
  announceUpdateAvailable: mocks.announce,
}));
vi.mock("./updateNotice", () => ({
  rememberInstalledUpdate: mocks.remember,
  forgetInstalledUpdate: mocks.forget,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  mocks.getVersion.mockResolvedValue("0.1.22");
  mocks.check.mockResolvedValue({
    version: "0.1.23",
    download: mocks.download,
    install: mocks.install,
  });
});
async function pending() {
  const updater = await import("./updater");
  await updater.probeForUpdate();
  return updater;
}

describe("desktop updates", () => {
  it("downloads with progress and waits for an explicit restart", async () => {
    mocks.download.mockImplementation(
      async (report: (event: DownloadEvent) => void) => {
        report({ event: "Started", data: { contentLength: 100 } });
        report({ event: "Progress", data: { chunkLength: 42 } });
        report({ event: "Finished" });
      },
    );
    const updater = await pending();
    const report = vi.fn();
    expect((await updater.downloadPendingUpdate(report)).phase).toBe("ready");
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "downloading", progress: 42 }),
    );
    expect(updater.getUpdaterSnapshot().phase).toBe("ready");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await updater.runUpdateFlow(false);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(updater.getUpdaterSnapshot().phase).toBe("ready");
  });
  it("checks once when the sidebar and Settings probe together", async () => {
    const updater = await import("./updater");
    await Promise.all([
      updater.runUpdateFlow(false),
      updater.runUpdateFlow(false),
    ]);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(updater.getUpdaterSnapshot().phase).toBe("available");
  });
  it("records the version before the Windows installer can exit the app", async () => {
    const updater = await pending();
    await updater.downloadPendingUpdate();
    await updater.installPendingUpdate();
    expect(mocks.remember).toHaveBeenCalledWith("0.1.23");
    expect(mocks.remember.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[0]!,
    );
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it("does not install if the restart guard detects an active response", async () => {
    const updater = await pending();
    await updater.downloadPendingUpdate();
    updater.setBeforeUpdateInstall(async () => {
      throw new Error("Finish active responses first");
    });
    expect((await updater.installPendingUpdate()).phase).toBe("ready");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("waits for workspace persistence before starting the installer", async () => {
    const updater = await pending();
    await updater.downloadPendingUpdate();
    let finish!: () => void;
    updater.setBeforeUpdateInstall(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const installing = updater.installPendingUpdate();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(mocks.install).not.toHaveBeenCalled();
    finish();
    await installing;
    expect(mocks.install).toHaveBeenCalledOnce();
  });
  it("shares one download and one installation across repeated clicks", async () => {
    const updater = await pending();
    await Promise.all([
      updater.downloadPendingUpdate(),
      updater.downloadPendingUpdate(),
    ]);
    expect(mocks.download).toHaveBeenCalledOnce();
    await Promise.all([
      updater.installPendingUpdate(),
      updater.installPendingUpdate(),
    ]);
    expect(mocks.install).toHaveBeenCalledOnce();
  });
  it("keeps a failed download retryable without installing", async () => {
    const updater = await pending();
    mocks.download.mockRejectedValueOnce(new Error("invalid signature"));
    expect((await updater.downloadPendingUpdate()).phase).toBe("error");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect((await updater.downloadPendingUpdate()).phase).toBe("ready");
  });
  it("keeps downloaded bytes after installation fails and clears the success notice", async () => {
    const updater = await pending();
    await updater.downloadPendingUpdate();
    mocks.install.mockRejectedValueOnce(new Error("install failed"));
    expect((await updater.installPendingUpdate()).phase).toBe("ready");
    expect(mocks.forget).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await updater.installPendingUpdate();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledTimes(2);
  });
  it("manual checks offer to download without automatically restarting", async () => {
    const updater = await import("./updater");
    mocks.ask.mockResolvedValue(true);
    expect((await updater.runUpdateFlow(true)).phase).toBe("ready");
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("does not install an update before downloading it", async () => {
    const updater = await pending();
    await updater.installPendingUpdate();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
  });
});
