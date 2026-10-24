import { homeDir } from "../../../../platform/tauri/fs";
import {
  setHarnessModels,
  type AgentModel,
} from "../../../../features/sessions/model/models";
import { AcpClient } from "../../core/acp";
import {
  killChild,
  resolveHandworkBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import { handworkSpawnCwd, modelsFromSessionNew } from "./handworkProtocol";
const PROBE_ID = "handwork-handwork-probe";
const REQUEST_TIMEOUT_MS = 12000;
let inflight: Promise<void> | null = null;
export function refreshHandworkCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = discoverHandworkModels()
    .then((models) => {
      if (models.length > 0) setHarnessModels("handwork", models);
    })
    .catch((error: unknown) => {
      // Preserve the last live catalog (or startup seeds) when offline/logged out.
      console.debug("[handwork] handwork catalog", error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
export async function discoverHandworkModels(workingDirectory?: string) {
  const { path, args } = await resolveHandworkBinary();
  const cwd = workingDirectory ?? (await homeDir());
  const probeId = `${PROBE_ID}-${crypto.randomUUID()}`;
  const acp = new AcpClient(probeId, {
    onRequest: (id, method) => {
      const response =
        method === "session/request_permission"
          ? acp.respond(id, { outcome: { outcome: "cancelled" } })
          : acp.respondError(id, {
              code: -32601,
              message: `Method not found: ${method}`,
            });
      void response.catch(() => undefined);
    },
  });
  watchChild(
    probeId,
    (line) => acp.pushLine(line),
    () => acp.close(new Error("Handwork probe exited")),
  );
  try {
    await spawnChild(
      probeId,
      path,
      args,
      handworkSpawnCwd(path, cwd),
      undefined,
      "handwork",
    );
    await acp.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          handwork: { backgroundTask: true },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Without this claim a compliant agent may omit configOptions from
          // session/new, leaving the catalog with nothing to enumerate.
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: "handwork", version: "0.1.0" },
      },
      REQUEST_TIMEOUT_MS,
    );
    // Authentication stays in the provider's Terminal UI; never start OAuth here.
    const created = await acp.request(
      "session/new",
      { cwd, mcpServers: [] },
      REQUEST_TIMEOUT_MS,
    );
    const available = await acp.request<{
      providers: {
        id: string;
        name?: string;
        connected?: boolean;
      }[];
    }>("handwork/providers/list", {}, REQUEST_TIMEOUT_MS);
    const sessionId = (
      created as {
        sessionId: string;
      }
    ).sessionId;
    const models: AgentModel[] = [];
    for (const provider of available.providers ?? []) {
      if (!provider.connected) continue;
      try {
        const configured = await acp.request(
          "session/set_config_option",
          {
            sessionId,
            configId: "provider",
            value: provider.id,
          },
          REQUEST_TIMEOUT_MS,
        );
        for (const model of modelsFromSessionNew(configured)) {
          models.push({
            ...model,
            id: `handwork:${provider.id}/${model.nativeId}`,
            nativeId: `${provider.id}/${model.nativeId}`,
            provider: { id: provider.id, name: provider.name ?? provider.id },
          });
        }
      } catch (error) {
        console.debug("[handwork] provider catalog", provider.id, error);
      }
    }
    return models.length ? models : modelsFromSessionNew(created);
  } finally {
    acp.close();
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  }
}
