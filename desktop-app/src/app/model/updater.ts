import { useSyncExternalStore } from "react";
import { BundleType, getBundleType, getVersion } from "@tauri-apps/api/app";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { announceUpdateAvailable } from "../../features/settings/model/sounds";
import { forgetInstalledUpdate, rememberInstalledUpdate } from "./updateNotice";
export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";
export type UpdaterSnapshot = {
  phase: UpdaterPhase;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  error?: string;
  /** Set on Linux .deb/.rpm installs, which update through apt/dnf. */
  packageManaged?: PackageManagedInstall;
};
let pendingUpdate: Update | null = null;
const RELEASES_URL = "https://github.com/loveconnor/handwork/releases";
let snapshot: UpdaterSnapshot = { phase: "idle", currentVersion: "…" };
const subscribers = new Set<() => void>();
let checkPromise: Promise<UpdaterSnapshot> | null = null;
let operation: Promise<UpdaterSnapshot> | null = null;
let downloadedUpdate: Update | null = null;
const installGuards = new Set<() => Promise<void>>();
export function setBeforeUpdateInstall(guard: () => Promise<void>): () => void {
  installGuards.add(guard);
  return () => {
    installGuards.delete(guard);
  };
}
export function getUpdaterSnapshot(): UpdaterSnapshot {
  return snapshot;
}
function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}
export function useUpdaterSnapshot(): UpdaterSnapshot {
  return useSyncExternalStore(
    subscribe,
    getUpdaterSnapshot,
    getUpdaterSnapshot,
  );
}
function publish(
  next: UpdaterSnapshot,
  onProgress?: (next: UpdaterSnapshot) => void,
): UpdaterSnapshot {
  snapshot = next;
  for (const listener of subscribers) listener();
  onProgress?.(next);
  return next;
}
// The sidebar owns this subscription; StrictMode cleanup removes its timer.
export function startAutomaticUpdateChecks(): () => void {
  let lastCheck = 0;
  const checkIfDue = () => {
    if (Date.now() - lastCheck < 60 * 60 * 1000 || pendingUpdate || operation)
      return;
    lastCheck = Date.now();
    void runUpdateFlow(false);
  };
  checkIfDue();
  const timer = window.setInterval(checkIfDue, 60 * 60 * 1000);
  window.addEventListener("focus", checkIfDue);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", checkIfDue);
  };
}
/**
 * Linux `.deb` and `.rpm` installs belong to apt/dnf. Surface the package
 * manager instructions rather than trying to replace a managed installation.
 */
export type PackageManagedInstall = "deb" | "rpm";
export async function packageManagedInstall(): Promise<PackageManagedInstall | null> {
  let type: string | null;
  try {
    type = await getBundleType();
  } catch {
    return null;
  }
  if (type === BundleType.Deb) return "deb";
  if (type === BundleType.Rpm) return "rpm";
  return null;
}
export function packageManagerHint(kind: PackageManagedInstall): string {
  return kind === "deb"
    ? `Download one .deb from ${RELEASES_URL} and run: sudo apt install ./Handwork_X.Y.Z_amd64.deb\nReplace the file name with the one you downloaded.`
    : `Download one .rpm from ${RELEASES_URL} and run: sudo dnf install ./Handwork-X.Y.Z-1.x86_64.rpm\nReplace the file name with the one you downloaded.`;
}
function isTargetMissingError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  // tauri-plugin-updater Error::TargetsNotFound / Error::TargetNotFound.
  return /none of the fallback platforms|the platform `[^`]*` was not found/i.test(
    text,
  );
}
function isUpdaterNotConfiguredError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /updater does not have any endpoints set/i.test(text);
}
export async function readAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "0.0.0";
  }
}
export async function probeForUpdate(): Promise<Update | null> {
  await runUpdateFlow(false);
  return pendingUpdate;
}
async function checkForUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const currentVersion = await readAppVersion();
  publish({ phase: "checking", currentVersion }, onProgress);
  const managed = await packageManagedInstall();
  if (managed) {
    pendingUpdate = null;
    return publish(
      { phase: "idle", currentVersion, packageManaged: managed },
      onProgress,
    );
  }
  try {
    const update = await check({ timeout: 30_000 });
    pendingUpdate = update;
    if (!update)
      return publish({ phase: "current", currentVersion }, onProgress);
    announceUpdateAvailable(update.version);
    return publish(
      { phase: "available", currentVersion, availableVersion: update.version },
      onProgress,
    );
  } catch (err) {
    pendingUpdate = null;
    if (isUpdaterNotConfiguredError(err) || isTargetMissingError(err)) {
      return publish({ phase: "idle", currentVersion }, onProgress);
    }
    const error = err instanceof Error ? err.message : String(err);
    return publish({ phase: "error", currentVersion, error }, onProgress);
  }
}
export async function runUpdateFlow(
  manual: boolean,
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  if (operation) return operation;
  let result = snapshot;
  if (!pendingUpdate) {
    if (!checkPromise) {
      checkPromise = checkForUpdate(onProgress).finally(() => {
        checkPromise = null;
      });
    }
    result = await checkPromise;
  }
  if (!manual) return result;
  if (result.packageManaged) {
    await message(packageManagerHint(result.packageManaged), {
      title: "Handwork",
    });
  } else if (result.phase === "current") {
    await message("You're on the latest version.", { title: "Handwork" });
  } else if (result.phase === "idle") {
    await message(
      `Automatic updates aren't available for this install yet.\n\nDownload releases at ${RELEASES_URL}`,
      { title: "Handwork" },
    );
  } else if (result.phase === "error" && !pendingUpdate) {
    await message(`Couldn't check for updates.\n\n${result.error}`, {
      title: "Handwork",
    });
  } else if (result.phase === "ready") {
    if (
      await ask("The update is downloaded. Save your work and restart now?", {
        title: "Update ready",
        kind: "info",
      })
    )
      return installPendingUpdate(onProgress);
  } else if (pendingUpdate) {
    const notes = pendingUpdate.body?.trim();
    if (
      await ask(
        `Handwork ${pendingUpdate.version} is available (you have ${result.currentVersion}).${notes ? `\n\n${notes}` : ""}\n\nDownload now? You can restart when you’re ready.`,
        { title: "Update available", kind: "info" },
      )
    )
      return downloadPendingUpdate(onProgress);
  }
  return result;
}
export function downloadPendingUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  if (operation) return operation;
  operation = downloadUpdate(onProgress).finally(() => {
    operation = null;
  });
  return operation;
}
async function downloadUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const currentVersion = await readAppVersion();
  const update = pendingUpdate;
  if (!update) return publish({ phase: "idle", currentVersion }, onProgress);
  if (downloadedUpdate === update)
    return publish(
      { phase: "ready", currentVersion, availableVersion: update.version },
      onProgress,
    );
  let downloaded = 0;
  let contentLength = 0;
  publish(
    {
      phase: "downloading",
      currentVersion,
      availableVersion: update.version,
      progress: 0,
    },
    onProgress,
  );
  try {
    await update.download((event: DownloadEvent) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? 0;
        downloaded = 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
      }
      publish(
        {
          phase: "downloading",
          currentVersion,
          availableVersion: update.version,
          progress:
            contentLength > 0
              ? Math.min(100, Math.round((downloaded / contentLength) * 100))
              : undefined,
        },
        onProgress,
      );
    });
    downloadedUpdate = update;
    return publish(
      {
        phase: "ready",
        currentVersion,
        availableVersion: update.version,
        progress: 100,
      },
      onProgress,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failed = publish(
      {
        phase: "error",
        currentVersion,
        availableVersion: update.version,
        error,
      },
      onProgress,
    );
    await message(`Couldn't download the update. Try again.\n\n${error}`, {
      title: "Handwork",
    });
    return failed;
  }
}
export function installPendingUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  if (operation) return operation;
  operation = installUpdate(onProgress).finally(() => {
    operation = null;
  });
  return operation;
}
async function installUpdate(
  onProgress?: (snapshot: UpdaterSnapshot) => void,
): Promise<UpdaterSnapshot> {
  const update = downloadedUpdate;
  if (!update) return snapshot;
  const currentVersion = await readAppVersion();
  let installed = false;
  publish(
    { phase: "installing", currentVersion, availableVersion: update.version },
    onProgress,
  );
  try {
    for (const guard of installGuards) await guard();
    // NSIS exits this process as soon as installation starts. Persist the
    // version first so the relaunched Windows app can show What's new.
    rememberInstalledUpdate(update.version);
    await update.install();
    installed = true;
    pendingUpdate = null;
    downloadedUpdate = null;
    await relaunch();
    return publish(
      { phase: "current", currentVersion: update.version },
      onProgress,
    );
  } catch (err) {
    if (!installed) forgetInstalledUpdate();
    const error = err instanceof Error ? err.message : String(err);
    const failed = publish(
      {
        phase: installed ? "current" : "ready",
        currentVersion: installed ? update.version : currentVersion,
        availableVersion: update.version,
        error,
      },
      onProgress,
    );
    await message(
      installed
        ? "The update installed. Quit and reopen Handwork to finish."
        : `Couldn't restart for the update.\n\n${error}`,
      { title: "Handwork" },
    );
    return failed;
  }
}
