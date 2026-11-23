import { ACCESS_MODES } from "@/features/models/access";
import type { ModelCatalog, ModelChoice } from "@/features/models/types";
import type {
  ChangedFile,
  DiffLine,
  FileEntry,
  Project,
  SessionSummary,
  Turn,
} from "@/features/workspace/types";
import type { WatchFrame } from "@/features/workspace/watchUpdates";

// A sample workspace that answers the desktop's protocol from the phone
// itself, so the app can be tried (and reviewed) without a paired desktop.
// Nothing here leaves the phone or runs anywhere; replies are canned.

/** The demo desktop's pin. No real certificate fingerprint looks like it. */
export const DEMO_FINGERPRINT = "demo";
export const DEMO_DESKTOP = {
  name: "Demo desktop",
  fingerprint: DEMO_FINGERPRINT,
  addresses: [],
  deviceId: "demo",
};
export const DEMO_IDENTITY = { certificate: "", privateKey: "" };

const CHATS = "demo:chats";
const WEATHER = "demo:weather";
const NOTES = "demo:notes";
/** The projects a demo starts with chosen: all of them. */
export const DEMO_SELECTION = { projectIds: [WEATHER, NOTES], monoIds: [] };

const MODELS = [
  { id: "demo:standard", name: "Demo Standard" },
  { id: "demo:fast", name: "Demo Fast" },
];
const modelName = (id: string) =>
  MODELS.find((model) => model.id === id)?.name ?? MODELS[0].name;

const REPLY =
  "This is the demo workspace, so nothing ran on a computer and this reply is a sample.\n\n" +
  "Paired with Handwork on your desktop, your message goes to the coding agent " +
  "running there. Its reply streams in here as it works, and the files it changes " +
  "show up under **Changes**, ready to review and commit.\n\n" +
  "To use your own projects, leave the demo in Settings and scan the pairing code " +
  "from your desktop.";

type Conversation = { turns: Turn[]; busy: boolean; timer?: ReturnType<typeof setTimeout> };
type Files = Record<string, string>;
type State = {
  projects: Project[];
  sessions: SessionSummary[];
  conversations: Map<string, Conversation>;
  files: Record<string, Files>;
  changes: Record<string, ChangedFile[]>;
  ahead: Record<string, number>;
  choices: Map<string, ModelChoice>;
  next: number;
};

// Set at the foot of the file, once the sample files it holds are defined.
let state: State;
const waiting = new Set<() => void>();
const watches = new Map<
  number,
  { conversationId: string; sent: Map<string, Turn>; order?: string; busy?: boolean }
>();
let nextWatch = -1;

/** Wakes every watch waiting on a change. */
function changed() {
  for (const wake of [...waiting]) wake();
}

/** Puts the sample workspace back as it starts. */
export function resetDemo() {
  for (const conversation of state.conversations.values()) clearTimeout(conversation.timer);
  state = initial();
  watches.clear();
  changed();
}

/** Demo watches count down from -1; the native link's count up from zero. */
export const isDemoWatch = (watchId: number) => watchId < 0;

export async function demoRequest<T>(method: string, params: object = {}): Promise<T> {
  // A beat, as a desktop over the network takes one.
  await new Promise((resolve) => setTimeout(resolve, 60));
  return handle(method, params as Record<string, unknown>) as T;
}

export function demoOpenWatch(params: object): number {
  const { conversationId } = params as { conversationId: string };
  conversation(conversationId);
  const watchId = nextWatch--;
  watches.set(watchId, { conversationId, sent: new Map() });
  return watchId;
}

export async function demoNextUpdates<T>(watchId: number, timeoutMs: number): Promise<T[]> {
  const frame = () => {
    const watch = watches.get(watchId);
    if (!watch) throw new Error("The conversation closed");
    const current = conversation(watch.conversationId);
    const turns = current.turns.filter((turn) => watch.sent.get(turn.id) !== turn);
    const order = current.turns.map((turn) => turn.id);
    if (turns.length === 0 && watch.order === order.join("\n") && watch.busy === current.busy)
      return null;
    watch.sent = new Map(current.turns.map((turn) => [turn.id, turn]));
    watch.order = order.join("\n");
    watch.busy = current.busy;
    const update: WatchFrame = { busy: current.busy, older: false, order, turns };
    return update as T;
  };
  const ready = frame();
  if (ready) return [ready];
  await new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      waiting.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    waiting.add(wake);
  });
  const next = frame();
  return next ? [next] : [];
}

export function demoCloseWatch(watchId: number) {
  watches.delete(watchId);
  // Its waiting read ends now rather than at its timeout.
  changed();
}

function handle(method: string, params: Record<string, unknown>): unknown {
  const projectId = params.projectId as string;
  const conversationId = params.conversationId as string;
  switch (method) {
    case "workspace.list":
      return {
        projects: state.projects.map((project) => {
          const files = state.changes[project.id] ?? [];
          return {
            ...project,
            additions: files.reduce((sum, file) => sum + file.additions, 0),
            deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            busy: state.sessions.some(
              (session) => session.projectId === project.id && session.busy,
            ),
          };
        }),
        monos: [],
        sessions: state.sessions,
      };
    case "device.leave":
      return {};
    case "sessions.list": {
      const query = String(params.query ?? "").trim().toLowerCase();
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? 30);
      const since = Number(params.since ?? 0);
      const hidden = (params.hiddenHarnesses as string[] | undefined) ?? [];
      const sessions = state.sessions
        .filter(
          (session) =>
            session.projectId === projectId &&
            session.updatedAt >= since &&
            !hidden.includes(session.harness) &&
            session.title.toLowerCase().includes(query),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        sessions: sessions.slice(offset, offset + limit),
        hasMore: sessions.length > offset + limit,
      };
    }
    case "session.start": {
      const text = String(params.text ?? "");
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) throw new Error("This workspace item is no longer available");
      const id = `demo:session:${state.next++}`;
      const model = (params.model as string | undefined) ?? MODELS[0].id;
      state.sessions = [
        {
          id,
          projectId,
          title: text.trim().split("\n")[0].slice(0, 60) || "New session",
          harness: "handwork",
          model,
          modelName: modelName(model),
          branch: project.branch,
          runtimeMode: (params.runtimeMode as ModelChoice["runtimeMode"]) ?? "supervised",
          updatedAt: Date.now(),
        },
        ...state.sessions,
      ];
      state.conversations.set(id, { turns: [], busy: false });
      send(id, text, attachmentCount(params));
      return { sessionId: id };
    }
    case "conversation.send":
      send(conversationId, String(params.text ?? ""), attachmentCount(params));
      return {};
    case "conversation.read": {
      const current = conversation(conversationId);
      return { id: conversationId, messages: [], turns: current.turns, busy: current.busy };
    }
    case "conversation.older":
      return { turns: [], older: false };
    case "session.cancel":
      finish(conversationId);
      return {};
    case "session.configure": {
      const { conversationId: _, ...choice } = params;
      const model = choice.model as string | undefined;
      state.choices.set(conversationId, { ...choiceFor(conversationId), ...choice } as ModelChoice);
      updateSession(conversationId, {
        ...(model ? { model, modelName: modelName(model) } : {}),
        ...(choice.runtimeMode
          ? { runtimeMode: choice.runtimeMode as ModelChoice["runtimeMode"] }
          : {}),
      });
      return {};
    }
    case "session.rename":
      updateSession(conversationId, { title: String(params.title ?? "") });
      return {};
    case "session.archive":
    case "session.delete":
      finish(conversationId);
      state.sessions = state.sessions.filter((session) => session.id !== conversationId);
      state.conversations.delete(conversationId);
      return {};
    case "models.list": {
      const catalog: ModelCatalog = {
        harnesses: [{ id: "handwork", label: "Handwork" }],
        models: MODELS.map((model) => ({
          ...model,
          harness: "handwork",
          provider: "Demo",
          settings: [],
        })),
        runtimeModes: ACCESS_MODES.map(({ id, label, hint }) => ({ id, label, hint })),
        current: choiceFor(conversationId),
      };
      return catalog;
    }
    case "accounts.usage":
      return { accounts: {} };
    case "project.worktrees":
      return { worktrees: [] };
    case "project.files": {
      const folder = String(params.path ?? "");
      const prefix = folder ? `${folder}/` : "";
      const entries = new Map<string, FileEntry>();
      for (const path of Object.keys(state.files[projectId] ?? {})) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        entries.set(name, { name, isDir: rest.length > 0, ignored: false });
      }
      return {
        entries: [...entries.values()].sort(
          (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
        ),
      };
    }
    case "project.file": {
      const path = String(params.path ?? "");
      const text = state.files[projectId]?.[path];
      if (text === undefined) throw new Error("This file is no longer there");
      return { path, text, truncated: false };
    }
    case "project.fileHighlight":
      return { palette: [], lines: [], done: true };
    case "project.search": {
      const query = String(params.query ?? "").toLowerCase();
      return {
        results: Object.keys(state.files[projectId] ?? {})
          .filter((path) => path.toLowerCase().includes(query))
          .map((path) => ({ path, name: path.split("/").at(-1)! })),
      };
    }
    case "project.changes":
      return {
        branch: branchOf(projectId),
        files: state.changes[projectId] ?? [],
        ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
      };
    case "project.git":
      return {
        branch: branchOf(projectId),
        files: (state.changes[projectId] ?? []).length,
        remote: true,
        upstream: true,
        defaultBranch: "main",
        ahead: state.ahead[projectId] ?? 0,
        behind: 0,
        aheadOfDefault: state.ahead[projectId] ?? 0,
        canGenerate: true,
        pr: null,
      };
    case "project.gitAction":
      return gitAction(projectId, params);
    default:
      throw new Error("Unsupported mobile operation");
  }
}

function gitAction(projectId: string, params: Record<string, unknown>) {
  const files = state.changes[projectId] ?? [];
  const paths = (params.paths as string[] | undefined) ?? [];
  const stage = (staged: boolean, only?: string[]) => {
    state.changes[projectId] = files.map((file) =>
      only && !only.includes(file.relative) ? file : { ...file, staged, unstaged: !staged },
    );
  };
  switch (params.action) {
    case "stage":
      stage(true, paths);
      return {};
    case "unstage":
      stage(false, paths);
      return {};
    case "stageAll":
      stage(true);
      return {};
    case "unstageAll":
      stage(false);
      return {};
    case "generate":
      return { message: "Update the sample project" };
    case "commit": {
      // As on the desktop: what is staged, or everything when nothing is.
      const anyStaged = files.some((file) => file.staged);
      state.changes[projectId] = anyStaged ? files.filter((file) => !file.staged) : [];
      state.ahead[projectId] = (state.ahead[projectId] ?? 0) + 1;
      return {};
    }
    case "sync":
      state.ahead[projectId] = 0;
      return {};
    default:
      throw new Error("Pull requests need a paired desktop; this is the demo workspace.");
  }
}

function conversation(id: string): Conversation {
  const found = state.conversations.get(id);
  if (!found) throw new Error("This workspace item is no longer available");
  return found;
}

const branchOf = (projectId: string) =>
  state.projects.find((project) => project.id === projectId)?.branch ?? "main";

function choiceFor(conversationId?: string): ModelChoice {
  const saved = conversationId ? state.choices.get(conversationId) : undefined;
  if (saved) return saved;
  const session = state.sessions.find((item) => item.id === conversationId);
  return {
    harness: "handwork",
    model: session?.model ?? MODELS[0].id,
    modelSettings: {},
    runtimeMode: session?.runtimeMode ?? "supervised",
  };
}

function updateSession(id: string, update: Partial<SessionSummary>) {
  state.sessions = state.sessions.map((session) =>
    session.id === id ? { ...session, ...update } : session,
  );
}

function attachmentCount(params: Record<string, unknown>) {
  return Array.isArray(params.attachments) ? params.attachments.length : 0;
}

/** Adds the message as a new turn and streams the sample reply into it. */
function send(id: string, text: string, attachments: number) {
  const current = conversation(id);
  finish(id);
  const turnId = `turn-${state.next++}`;
  const started = Date.now();
  const user = {
    type: "user" as const,
    id: `${turnId}-0`,
    text,
    at: started,
    ...(attachments ? { attachments } : {}),
  };
  current.turns = [...current.turns, { id: turnId, items: [user], copyText: "", footer: false }];
  current.busy = true;
  updateSession(id, { busy: true, updatedAt: started });
  changed();
  const words = REPLY.split(/(?<= )/);
  let shown = 0;
  const step = () => {
    shown = Math.min(words.length, shown + 3);
    const reply = words.slice(0, shown).join("");
    const done = shown === words.length;
    current.turns = current.turns.map((turn) =>
      turn.id === turnId
        ? {
            ...turn,
            items: [user, { type: "text", id: `${turnId}-1`, text: reply, streaming: !done }],
            copyText: reply,
          }
        : turn,
    );
    if (done) finish(id);
    else {
      current.timer = setTimeout(step, 90);
      changed();
    }
  };
  current.timer = setTimeout(step, 700);
}

/** Ends the turn in progress, if there is one, where it stands. */
function finish(id: string) {
  const current = state.conversations.get(id);
  if (!current?.busy) return;
  clearTimeout(current.timer);
  current.timer = undefined;
  current.busy = false;
  const now = Date.now();
  current.turns = current.turns.map((turn, index) =>
    index === current.turns.length - 1
      ? {
          ...turn,
          footer: true,
          completedAt: now,
          items: turn.items.map((item) =>
            item.type === "text" ? { ...item, streaming: false } : item,
          ),
        }
      : turn,
  );
  updateSession(id, { busy: false, updatedAt: now });
  changed();
}

function initial(): State {
  const now = Date.now();
  const minutes = (count: number) => now - count * 60_000;
  const project = (id: string, name: string, branch: string, color: string): Project => ({
    id,
    name,
    path: `/Users/demo/Projects/${name}`,
    machine: DEMO_DESKTOP.name,
    branch,
    color,
    additions: 0,
    deletions: 0,
    defaultHarness: "handwork",
    defaultModel: MODELS[0].id,
    defaultModelName: MODELS[0].name,
    defaultRuntimeMode: "supervised",
  });
  const session = (
    id: string,
    projectId: string,
    title: string,
    branch: string,
    updatedAt: number,
  ): SessionSummary => ({
    id,
    projectId,
    title,
    harness: "handwork",
    model: MODELS[0].id,
    modelName: MODELS[0].name,
    branch,
    runtimeMode: "supervised",
    updatedAt,
  });
  const turn = (id: string, at: number, ask: string, steps: string[], reply: string): Turn => ({
    id,
    items: [
      { type: "user", id: `${id}-0`, text: ask, at },
      ...steps.map((text, index) => ({
        type: "notice" as const,
        id: `${id}-${index + 1}`,
        text,
      })),
      { type: "text", id: `${id}-${steps.length + 1}`, text: reply },
    ],
    copyText: reply,
    footer: true,
    completedAt: at + 48_000,
  });
  const conversations = new Map<string, Conversation>([
    [
      "demo:session:forecast",
      {
        busy: false,
        turns: [
          turn(
            "turn-a",
            minutes(34),
            "Add a five-day forecast under the current conditions.",
            ["Read src/App.tsx", "Read src/api/weather.ts", "Edit src/api/weather.ts", "Create src/components/Forecast.tsx", "Edit src/App.tsx"],
            "The forecast is in. I added `fetchForecast` to `src/api/weather.ts`, a `Forecast` component that shows the next five days, and rendered it under the current conditions in `App.tsx`.\n\nThe three files are under **Changes** if you'd like to review them before committing.",
          ),
          turn(
            "turn-b",
            minutes(21),
            "Show the high and low for each day too.",
            ["Edit src/components/Forecast.tsx"],
            "Each day now shows its high and low, with the low in a lighter weight so the high reads first.",
          ),
        ],
      },
    ],
    [
      "demo:session:units",
      {
        busy: false,
        turns: [
          turn(
            "turn-c",
            minutes(60 * 26),
            "Why does the temperature show in Kelvin?",
            ["Read src/api/weather.ts"],
            "The request in `src/api/weather.ts` doesn't ask for a unit, and the weather service answers in Kelvin by default. Passing `units=metric` (or `imperial`) fixes it. Want me to add a setting for it?",
          ),
        ],
      },
    ],
    [
      "demo:session:search",
      {
        busy: false,
        turns: [
          turn(
            "turn-d",
            minutes(60 * 5),
            "Add search to the notes list endpoint.",
            ["Read server/routes/notes.ts", "Edit server/routes/notes.ts", "Run npm test"],
            "`GET /notes` now takes a `q` parameter and matches it against each note's title and body, ignoring case. The tests pass, including two new ones for search.",
          ),
        ],
      },
    ],
    [
      "demo:session:regex",
      {
        busy: false,
        turns: [
          turn(
            "turn-e",
            minutes(60 * 3),
            "Explain what a debounce is, briefly.",
            [],
            "A debounce waits until calls stop arriving for a set time before running the function once. It's how a search box avoids sending a request on every keystroke: it waits for a pause in typing, then sends one.",
          ),
        ],
      },
    ],
  ]);
  return {
    projects: [
      { ...project(CHATS, "Chats", "", "hsl(210 8% 58%)"), kind: "chats", path: "" },
      project(WEATHER, "weather-app", "forecast", "hsl(211 92% 62%)"),
      project(NOTES, "notes-api", "main", "hsl(142 55% 50%)"),
    ],
    sessions: [
      session("demo:session:forecast", WEATHER, "Add a five-day forecast", "forecast", minutes(20)),
      session("demo:session:units", WEATHER, "Temperature shows in Kelvin", "main", minutes(60 * 26)),
      session("demo:session:search", NOTES, "Search for the notes endpoint", "main", minutes(60 * 5)),
      session("demo:session:regex", CHATS, "What a debounce is", "", minutes(60 * 3)),
    ],
    conversations,
    files: { [WEATHER]: WEATHER_FILES, [NOTES]: NOTES_FILES },
    changes: { [WEATHER]: weatherChanges(), [NOTES]: [] },
    ahead: {},
    choices: new Map(),
    next: 1,
  };
}

const FORECAST = `import type { Day } from "../api/weather";

export function Forecast({ days }: { days: Day[] }) {
  return (
    <ul className="forecast">
      {days.map((day) => (
        <li key={day.date}>
          <span>{day.label}</span>
          <strong>{Math.round(day.high)}°</strong>
          <span className="low">{Math.round(day.low)}°</span>
        </li>
      ))}
    </ul>
  );
}
`;

const WEATHER_FILES: Files = {
  "README.md": "# weather-app\n\nA small weather app: current conditions and a five-day forecast.\n\n```sh\nnpm install\nnpm run dev\n```\n",
  "package.json": `{\n  "name": "weather-app",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build",\n    "test": "vitest run"\n  }\n}\n`,
  "src/App.tsx": `import { useEffect, useState } from "react";
import { fetchCurrent, fetchForecast, type Current, type Day } from "./api/weather";
import { Forecast } from "./components/Forecast";

export function App() {
  const [current, setCurrent] = useState<Current | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  useEffect(() => {
    void fetchCurrent("London").then(setCurrent);
    void fetchForecast("London").then(setDays);
  }, []);
  if (!current) return <p>Loading…</p>;
  return (
    <main>
      <h1>{current.city}</h1>
      <p className="now">{Math.round(current.temperature)}°</p>
      <Forecast days={days} />
    </main>
  );
}
`,
  "src/api/weather.ts": `export type Current = { city: string; temperature: number };
export type Day = { date: string; label: string; high: number; low: number };

const BASE = "https://api.example.com/weather";

export async function fetchCurrent(city: string): Promise<Current> {
  const response = await fetch(\`\${BASE}/current?city=\${city}&units=metric\`);
  return response.json();
}

export async function fetchForecast(city: string): Promise<Day[]> {
  const response = await fetch(\`\${BASE}/forecast?city=\${city}&days=5&units=metric\`);
  return response.json();
}
`,
  "src/components/Forecast.tsx": FORECAST,
};

const NOTES_FILES: Files = {
  "README.md": "# notes-api\n\nA small HTTP API for notes.\n\n- `GET /notes?q=` lists notes, optionally matching a search.\n- `POST /notes` adds one.\n",
  "package.json": `{\n  "name": "notes-api",\n  "private": true,\n  "scripts": {\n    "start": "node server/index.js",\n    "test": "vitest run"\n  }\n}\n`,
  "server/routes/notes.ts": `import { Router } from "express";
import { notes } from "../store";

export const router = Router();

router.get("/notes", (request, response) => {
  const query = String(request.query.q ?? "").toLowerCase();
  response.json(
    notes.filter((note) =>
      (note.title + " " + note.body).toLowerCase().includes(query),
    ),
  );
});
`,
  "server/store.ts": `export type Note = { id: string; title: string; body: string };

export const notes: Note[] = [];
`,
};

/** A unified diff's lines, numbered as the desktop numbers them. */
function diff(oldStart: number, newStart: number, rows: [DiffLine["kind"], string][]): DiffLine[] {
  let oldNumber = oldStart;
  let newNumber = newStart;
  const removed = rows.filter(([kind]) => kind !== "add").length;
  const added = rows.filter(([kind]) => kind !== "del").length;
  return [
    {
      kind: "hunk",
      text: `@@ -${oldStart},${removed} +${newStart},${added} @@`,
      oldNumber: null,
      newNumber: null,
    },
    ...rows.map(([kind, text]) => ({
      kind,
      text,
      oldNumber: kind === "add" ? null : oldNumber++,
      newNumber: kind === "del" ? null : newNumber++,
    })),
  ];
}

function weatherChanges(): ChangedFile[] {
  const forecast = FORECAST.trimEnd().split("\n");
  return [
    {
      relative: "src/App.tsx",
      status: "modified",
      additions: 5,
      deletions: 1,
      staged: false,
      unstaged: true,
      lines: [
        ...diff(1, 1, [
          ["context", 'import { useEffect, useState } from "react";'],
          ["del", 'import { fetchCurrent, type Current } from "./api/weather";'],
          ["add", 'import { fetchCurrent, fetchForecast, type Current, type Day } from "./api/weather";'],
          ["add", 'import { Forecast } from "./components/Forecast";'],
          ["context", ""],
          ["context", "export function App() {"],
          ["context", "  const [current, setCurrent] = useState<Current | null>(null);"],
          ["add", "  const [days, setDays] = useState<Day[]>([]);"],
          ["context", "  useEffect(() => {"],
          ["context", '    void fetchCurrent("London").then(setCurrent);'],
          ["add", '    void fetchForecast("London").then(setDays);'],
          ["context", "  }, []);"],
        ]),
        ...diff(13, 16, [
          ["context", "      <h1>{current.city}</h1>"],
          ["context", '      <p className="now">{Math.round(current.temperature)}°</p>'],
          ["add", "      <Forecast days={days} />"],
          ["context", "    </main>"],
        ]),
      ],
    },
    {
      relative: "src/api/weather.ts",
      status: "modified",
      additions: 6,
      deletions: 0,
      staged: false,
      unstaged: true,
      lines: diff(1, 1, [
        ["context", "export type Current = { city: string; temperature: number };"],
        ["add", "export type Day = { date: string; label: string; high: number; low: number };"],
        ["context", ""],
        ["context", 'const BASE = "https://api.example.com/weather";'],
      ]).concat(
        diff(8, 9, [
          ["context", "}"],
          ["add", ""],
          ["add", "export async function fetchForecast(city: string): Promise<Day[]> {"],
          ["add", "  const response = await fetch(`${BASE}/forecast?city=${city}&days=5&units=metric`);"],
          ["add", "  return response.json();"],
          ["add", "}"],
        ]),
      ),
    },
    {
      relative: "src/components/Forecast.tsx",
      status: "untracked",
      additions: forecast.length,
      deletions: 0,
      staged: false,
      unstaged: true,
      lines: diff(0, 1, forecast.map((text) => ["add", text])),
    },
  ];
}

state = initial();
