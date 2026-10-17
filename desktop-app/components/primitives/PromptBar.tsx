"use client";

import { HoverTooltip } from "@/components/ui/tooltip";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createShader, playSweep, accentChain, ACCENTS } from "glimm";
import { IconArrowUp, IconChart, IconCheck, IconChevronDown, IconClose, IconFile, IconGlobe, IconLayers, IconLock, IconLockOpen, IconMic, IconPaperclip, IconPlus, IconStopFilled, type IconComponent } from "@/components/atoms/Icons";
import { Figma, GoogleGmail } from "honestui/logos";
import ModelPicker, { type PickerChoice } from "@/components/primitives/ModelPicker";
import { ProviderLogo } from "@/components/atoms/ProviderLogo";

/* The built-in "prism" palette is only cyan→indigo→magenta, so a sweep
 * reads as blue/purple. Build a true full-spectrum rainbow instead. */
const RAINBOW = accentChain([
  ACCENTS.red,
  ACCENTS.orange,
  ACCENTS.yellow,
  ACCENTS.green,
  ACCENTS.cyan,
  ACCENTS.blue,
  ACCENTS.purple,
]);

/* ─────────────────────────────────────────────────────────
 * PROMPT BAR
 * A composer with real controls: attach, @ data sources,
 * / commands, a model picker, dictation, and send.
 * Type @ or / to open the menus; ↑↓ + Enter to pick.
 * Variants: Rounded (card radius) · Pill (full radius).
 * ───────────────────────────────────────────────────────── */

const GLYPHS: Record<string, IconComponent> = {
  clip: IconPaperclip,
  chart: IconChart,
  layers: IconLayers,
  globe: IconGlobe,
};

/* real product marks, inline so the file stays self-contained */
const BRANDS: Record<string, React.ReactNode> = {
  figma: <Figma width={11} height={16} aria-hidden="true" />,
  slack: (
    <svg width="15" height="15" viewBox="0 0 127 127" aria-hidden="true">
      <path d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z" fill="#E01E5A" />
      <path d="M47 27.2c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.7 39.7.8 47 .8c7.3 0 13.2 5.9 13.2 13.2v13.2H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.3.7 54.4.7 47.1c0-7.3 5.9-13.2 13.2-13.2H47z" fill="#36C5F0" />
      <path d="M99.9 47.1c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V47.1zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.9C66.9 6.6 72.8.7 80.1.7c7.3 0 13.2 5.9 13.2 13.2v33.2z" fill="#2EB67D" />
      <path d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z" fill="#ECB22E" />
    </svg>
  ),
  gmail: <GoogleGmail width={15} height={12} aria-hidden="true" />,
};

type Source = {
  key: string;
  name: string;
  desc: string;
  glyph?: string;
  brand?: string;
  attach?: boolean;
  connect?: boolean;
};

const SOURCES: Source[] = [
  { key: "attach", name: "Add photos & files", desc: "Upload from your computer", glyph: "clip", attach: true },
  { key: "scoop", name: "Scoop Data", desc: "Sales & churn metrics", glyph: "chart" },
  { key: "flavors", name: "Flavor records", desc: "26 makers, tags, links", glyph: "layers" },
  { key: "web", name: "Web search", desc: "Real-time news and info", glyph: "globe" },
  { key: "figma", name: "Figma", desc: "Design-to-code workflows", brand: "figma" },
  { key: "slack", name: "Slack", desc: "Read and manage Slack", brand: "slack" },
  { key: "gmail", name: "Gmail", desc: "Read and manage Gmail", brand: "gmail", connect: true },
];

const COMMANDS = [
  { key: "compare", name: "/compare", desc: "Flavor vs. last summer" },
  { key: "churn-plan", name: "/churn-plan", desc: "Draft a churn schedule" },
  { key: "restock", name: "/restock", desc: "Build a reorder list" },
  { key: "draft-email", name: "/draft-email", desc: "Write a supplier email" },
  { key: "summarize", name: "/summarize", desc: "Digest the thread so far" },
];

const MODELS = [
  { key: "sprinkles-5", name: "Sprinkles 5", tag: "Flagship" },
  { key: "vanilla-1", name: "Vanilla 1", tag: "Basic" },
  { key: "freezer-burn", name: "Freezer Burn 0.4", tag: "Stale" },
];

const FILES = ["flavor-chart.png", "summer-menu.pdf", "pos-export.csv"];
const DICTATION = "Compare pistachio weekends to last summer";

/* self-running demo: walk the @ menu, then the / menu, and repeat.
 * Any pointer or key interaction hands control to the user. */
const AUTO_STEPS: {
  draft: string;
  active?: number;
  connect?: boolean;
  modelOpen?: boolean;
  model?: string;
  hold: number;
}[] = [
  { draft: "", connect: false, model: "vanilla-1", hold: 1100 },
  { draft: "@", active: 0, hold: 900 },
  { draft: "@", active: 1, hold: 620 },
  { draft: "@", active: 4, hold: 620 },
  { draft: "@", active: 6, hold: 700 },
  { draft: "@", active: 6, connect: true, hold: 1000 },
  { draft: "", hold: 700 },
  { draft: "/", active: 0, hold: 900 },
  { draft: "/", active: 1, hold: 620 },
  { draft: "/", active: 3, hold: 1000 },
  { draft: "", hold: 800 },
  // open the model picker and upgrade to the flagship → rainbow sweep
  { draft: "", modelOpen: true, hold: 1200 },
  { draft: "", model: "sprinkles-5", hold: 2400 },
  { draft: "", hold: 900 },
];

/* the last @word or /word being typed, if any */
function parseToken(draft: string): { kind: "at" | "slash"; query: string; start: number } | null {
  const match = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!match) return null;
  return {
    kind: match[2] === "@" ? "at" : "slash",
    query: match[3].toLowerCase(),
    start: match.index + match[1].length,
  };
}

export type PromptBarRuntime = {
  /** Controlled draft; pair with the same parent state setter across composer instances. */
  draft?: string;
  onDraftChange?: React.Dispatch<React.SetStateAction<string>>;
  disabled?: boolean;
  busy?: boolean;
  modelLabel?: string;
  /** Engine-provided model choices; when present the trigger opens the model picker. */
  models?: PickerChoice[];
  modelValue?: string;
  onSelectModel?: (value: string) => void;
  providers?: PickerChoice[];
  providerValue?: string;
  onSelectProvider?: (value: string) => void;
  fastMode?: boolean;
  onToggleFastMode?: () => void;
  efforts?: PickerChoice[];
  effortValue?: string;
  onSelectEffort?: (value: string) => void;
  /** Permission modes shown as a chip beside the model. */
  modes?: PickerChoice[];
  modeValue?: string;
  onSelectMode?: (value: string) => void;
  /** Bump to open the model picker from outside (e.g. the /model command). */
  modelMenuRequest?: number;
  /** Opens provider management from the picker's rail. */
  onManageProviders?: () => void;
  /** Files staged for the next prompt; the host reads them and owns the list. */
  attachments?: { name: string; size: number; mimeType: string }[];
  onAddFiles?: () => void;
  onDropFiles?: (files: File[]) => void;
  onRemoveAttachment?: (index: number) => void;
  /** Dictation through a system voice app; the button only renders when one is available. */
  voice?: { available: boolean; listening: boolean; onToggle: () => void };
  /** Fallback when no model list is available (e.g. open a settings surface). */
  onConfigure?: () => void;
  onCancel?: () => void;
  /** Engine-advertised slash commands; typing "/" offers them and Enter runs the match via onCommand. */
  commands?: { name: string; description: string; input?: string }[];
  onCommand?: (name: string, args: string) => void | Promise<void>;
};

/** "/name rest" against the advertised command list; null when the draft is an ordinary prompt. */
function matchCommand(draft: string, commands: { name: string }[]): { name: string; args: string } | null {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  if (!match || !commands.some((command) => command.name === match[1])) return null;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

// A stable parent setter shares edit revisions across the hero → thread remount.
// Weak keys let this bookkeeping disappear when the parent's state is released.
const controlledDraftRevisions = new WeakMap<React.Dispatch<React.SetStateAction<string>>, { current: number }>();

export default function PromptBar({
  variant = "Rounded",
  demo = true,
  tall = false,
  placeholder,
  onSend,
  runtime,
}: {
  variant?: string;
  /** the self-running walkthrough; turn off when embedding in a real surface */
  demo?: boolean;
  /** hero sizing: a multi-line input with controls on their own row */
  tall?: boolean;
  placeholder?: string;
  onSend?: (text: string) => void | Promise<void>;
  runtime?: PromptBarRuntime;
}) {
  const pill = variant === "Pill";
  const [localDraft, setLocalDraft] = useState("");
  const controlled = runtime?.draft !== undefined;
  const draft = controlled ? runtime.draft! : localDraft;
  const setDraft: React.Dispatch<React.SetStateAction<string>> = controlled
    ? runtime.onDraftChange ?? (() => {})
    : setLocalDraft;
  const [dismissed, setDismissed] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [model, setModel] = useState(MODELS[1]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [active, setActive] = useState(0);
  const [listening, setListening] = useState(false);
  const [auto, setAuto] = useState(demo && !runtime);
  const sendingRef = useRef(false);
  const localDraftRevision = useRef(0);
  let draftRevision = localDraftRevision;
  if (controlled && runtime.onDraftChange) {
    let sharedRevision = controlledDraftRevisions.get(runtime.onDraftChange);
    if (!sharedRevision) {
      sharedRevision = { current: 0 };
      controlledDraftRevisions.set(runtime.onDraftChange, sharedRevision);
    }
    draftRevision = sharedRevision;
  }
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [autoStep, setAutoStep] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const wide = expanded || tall;
  const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [modelBox, setModelBox] = useState<{ top: number; height: number } | null>(null);
  const [modelHovered, setModelHovered] = useState<number | null>(null);
  const [modelMenuLeft, setModelMenuLeft] = useState(0);
  const [modelMenuBottom, setModelMenuBottom] = useState(0);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modelGroupRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const modelRowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const glimmRef = useRef<HTMLCanvasElement>(null);
  const shaderRef = useRef<ReturnType<typeof createShader> | null>(null);
  const sweepingRef = useRef(false);

  /* hand control to the user: stop the demo loop, and when they aim at
   * the input itself, clear the demo's leftover draft for a clean start */
  const takeOver = (event: { target: EventTarget | null }) => {
    setAuto(false);
    if (!runtime && auto && event.target === inputRef.current) setDraft("");
  };

  /* Runtime composers only offer the engine's slash commands, and only while
   * the draft is just that leading command token. */
  const runtimeCommands = runtime?.commands ?? [];
  const parsedToken = dismissed ? null : parseToken(draft);
  const token = !parsedToken ? null : runtime
    ? (parsedToken.kind === "slash" && parsedToken.start === 0 && runtimeCommands.length > 0 ? parsedToken : null)
    : parsedToken;
  const menu: "at" | "slash" | null = runtime ? (token ? "slash" : null) : plusOpen ? "at" : token?.kind ?? null;
  const query = plusOpen ? "" : token?.query ?? "";

  const rows: { key: string; name: string; desc: string }[] =
    menu === "at"
      ? SOURCES.filter((s) => s.name.toLowerCase().includes(query))
      : menu === "slash"
        ? runtime
          ? runtimeCommands
              .filter((c) => c.name.startsWith(query))
              .map((c) => ({ key: c.name, name: `/${c.name}`, desc: c.input ? `${c.description} · ${c.input}` : c.description }))
          : COMMANDS.filter((c) => c.name.slice(1).startsWith(query))
        : [];

  useEffect(() => {
    setActive(0);
    setEngaged(false);
  }, [menu, query]);

  /* a single highlight glides to the active row instead of each row
   * toggling its own background — matches the gliding pill in the nav */
  useLayoutEffect(() => {
    const target = rowRefs.current[active];
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [menu, query, active, connected, rows.length]);

  /* In runtime mode the rows come from the engine's config options and the
   * selection is owned by the parent; the demo keeps its local MODELS list. */
  const runtimeModels = runtime?.models;
  const menuModels: { key: string; name: string; tag?: string }[] = runtimeModels
    ? runtimeModels.map((m) => ({ key: m.value, name: m.name }))
    : MODELS;
  const currentModelKey = runtime ? runtime.modelValue : model.key;
  const modelMenuWidth = runtime ? 440 : 176;
  const hasModelMenu = runtime ? !!runtimeModels?.length && !!runtime.onSelectModel : true;

  /* same gliding highlight in the model menu — floats to the hovered
   * row, falling back to the currently-selected model */
  const modelIndex = menuModels.findIndex((m) => m.key === currentModelKey);
  useLayoutEffect(() => {
    if (!modelOpen) return;
    const target = modelRowRefs.current[modelHovered ?? modelIndex];
    if (target) setModelBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [modelOpen, modelHovered, modelIndex]);

  /* The menu is outside the clipped composer, so align it to the model
   * trigger by measurement instead of pinning it to the far-right edge. */
  useLayoutEffect(() => {
    if (!modelOpen || !composerAnchorRef.current || !modelRef.current) return;
    const anchorRect = composerAnchorRef.current.getBoundingClientRect();
    const triggerRect = modelRef.current.getBoundingClientRect();
    setModelMenuLeft(Math.max(0, Math.min(triggerRect.left - anchorRect.left, anchorRect.width - modelMenuWidth)));
    setModelMenuBottom(anchorRect.bottom - triggerRect.top + 8);
  }, [modelOpen, wide, model.name, runtime?.modelLabel, modelMenuWidth]);

  useEffect(() => {
    if (!modelOpen) setModelHovered(null);
  }, [modelOpen]);
  const [modeOpen, setModeOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const modelMenuRequest = runtime?.modelMenuRequest;
  useEffect(() => {
    if (modelMenuRequest) { setPlusOpen(false); setModeOpen(false); setModelOpen(true); }
  }, [modelMenuRequest]);

  /* Build the shader with a pinned hue phase. createShader seeds its
   * internal hueShift from Math.random(), which made the sweep a different
   * colour on every reload — pin it so the rainbow is identical each time. */
  const makeShader = () => {
    const canvas = glimmRef.current;
    if (!canvas) return null;
    const random = Math.random;
    Math.random = () => 0;
    try {
      return createShader({
        canvas,
        palette: RAINBOW,
        direction: "ltr",
        bandTight: 10,
        swellAmount: 0.85,
      });
    } finally {
      Math.random = random;
    }
  };

  /* Glimm shader lives inside the composer, invisible at rest. Selecting
   * the flagship model fires a one-shot rainbow sweep across the interior. */
  useEffect(() => {
    shaderRef.current = makeShader();
    return () => {
      shaderRef.current?.destroy();
      shaderRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const celebrate = () => {
    if (sweepingRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Recreate the shader per sweep so uTime restarts at 0 — the hue phase
    // (which drifts with time) is then identical on every trigger.
    shaderRef.current?.destroy();
    const shader = makeShader();
    shaderRef.current = shader;
    if (!shader) return;
    sweepingRef.current = true;
    const sweep = playSweep(shader, {
      palette: RAINBOW,
      direction: "ltr",
      sweepMs: 570,
      outroMs: 80,
      peakAlpha: 1.3,
      bandTight: 10,
      brightness: 1.4,
      swellAmount: 1,
      waveSpeed: 1.8,
      easing: "easeOutExpo",
    });
    sweep.done.finally(() => {
      sweepingRef.current = false;
    });
  };

  const selectModel = (next: { key: string; name: string; tag?: string }) => {
    setModelOpen(false);
    if (runtime) {
      if (next.key !== runtime.modelValue) runtime.onSelectModel?.(next.key);
      return;
    }
    const local = MODELS.find((m) => m.key === next.key);
    if (!local) return;
    setModel(local);
    if (local.key === "sprinkles-5") celebrate();
  };

  /* autoplay: apply the current step, then advance after its hold */
  useEffect(() => {
    if (runtime || !auto) return;
    const step = AUTO_STEPS[autoStep % AUTO_STEPS.length];
    setDraft(step.draft);
    if (step.active !== undefined) setActive(step.active);
    if (step.connect !== undefined) setConnected(step.connect);
    if (step.modelOpen !== undefined) setModelOpen(step.modelOpen);
    if (step.model) {
      const next = MODELS.find((m) => m.key === step.model);
      if (next) selectModel(next);
    }
    const t = setTimeout(() => setAutoStep((s) => s + 1), step.hold);
    return () => clearTimeout(t);
  }, [auto, autoStep, runtime]);

  /* dictation resolves after a beat, like a real transcript landing */
  useEffect(() => {
    if (runtime || !listening) return;
    const t = setTimeout(() => {
      setDraft((current) => (current ? `${current.trimEnd()} ${DICTATION}` : DICTATION));
      setListening(false);
      inputRef.current?.focus();
    }, 2200);
    return () => clearTimeout(t);
  }, [listening, runtime]);

  /* Move wrapped text above the controls, then grow to a compact maximum. */
  useLayoutEffect(() => {
    const input = inputRef.current;
    const controls = controlsRef.current;
    const measure = measureRef.current;
    const modelButton = modelRef.current;
    if (!input || !controls || !measure || !modelButton) return;

    const fixedControlsWidth = 28 * (showMic ? 3 : 2) + (modelGroupRef.current?.offsetWidth ?? modelButton.offsetWidth);
    const inlineGaps = 4 * 4;
    const inlineInputWidth = controls.clientWidth - fixedControlsWidth - inlineGaps;
    const needsFullWidth = draft.includes("\n") || measure.offsetWidth + 8 > inlineInputWidth;
    if (needsFullWidth !== expanded) {
      setExpanded(needsFullWidth);
    }

    const minHeight = 28;
    const maxHeight = 100;
    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded]);

  /* clicking anywhere outside the composer closes the open menus */
  useEffect(() => {
    if (!modelOpen && !plusOpen && !modeOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-promptbar]")) {
        setModelOpen(false);
        setPlusOpen(false);
        setModeOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen, plusOpen, modeOpen]);

  const closeMenus = () => {
    setPlusOpen(false);
    setModelOpen(false);
    setModeOpen(false);
  };

  const pick = (row: { key: string; name: string }) => {
    const source = SOURCES.find((s) => s.key === row.key);
    if (source?.attach) {
      setAttachments((current) => [...current, FILES[current.length % FILES.length]]);
      if (token) setDraft(draft.slice(0, token.start));
    } else if (menu === "at") {
      setDraft(`${token ? draft.slice(0, token.start) : draft}@${row.name} `);
    } else {
      setDraft(`${token ? draft.slice(0, token.start) : draft}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    inputRef.current?.focus();
  };

  const staged = runtime ? runtime.attachments ?? [] : attachments.map((name) => ({ name, size: 0, mimeType: "" }));
  const showMic = !runtime || !!runtime.voice?.available;
  const canSend = !runtime?.disabled && !runtime?.busy && !sending &&
    (draft.trim().length > 0 || staged.length > 0) &&
    (!runtime || !!onSend);
  const canStop = !!runtime?.busy && !runtime.disabled && !!runtime.onCancel;
  const send = async () => {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    const revision = draftRevision.current;
    const submittedDraft = draft;
    const submittedAttachments = attachments;
    const command = runtime?.onCommand ? matchCommand(submittedDraft, runtimeCommands) : null;
    // The message leaves the composer immediately, like any chat client; a reply can take a while.
    setDraft((current) => (current === submittedDraft ? "" : current));
    setAttachments((current) => (current === submittedAttachments ? [] : current));
    closeMenus();
    try {
      if (command) await runtime!.onCommand!(command.name, command.args);
      else await onSend?.(submittedDraft.trim());
    } catch {
      // Restore the text unless the user has already typed something new. The parent
      // updater sees the latest draft even after this instance unmounts.
      setDraft((current) => (draftRevision.current === revision && current === "" ? submittedDraft : current));
      setAttachments((current) => (current.length === 0 ? submittedAttachments : current));
      setSendError("Message not sent. Your draft has been kept. Try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div
      data-promptbar
      className={demo && !runtime ? "flex min-h-[384px] w-full max-w-105 flex-col justify-end pb-8" : "w-full"}
      onPointerDownCapture={takeOver}
      onKeyDownCapture={takeOver}
      onDragOver={(event) => { if (runtime?.onDropFiles && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        if (!runtime?.onDropFiles) return;
        event.preventDefault();
        setDropping(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length) runtime.onDropFiles(files);
      }}
    >
      {/* composer is the anchor — menus grow up from its top edge */}
      <div ref={composerAnchorRef} className="relative">
      {/* ── @ / slash menu ─────────────────────────────── */}
      {menu && (
        <div
          onMouseLeave={() => setEngaged(false)}
          className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-[10px] bg-surface p-1 shadow-raised"
          style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom center" }}
        >
          {/* single gliding highlight — appears once a row is hovered */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
            style={{
              top: rowBox?.top ?? 0,
              height: rowBox?.height ?? 0,
              opacity: rowBox && engaged && rows.length > 0 ? 1 : 0,
              transition:
                "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
            }}
          />
          {rows.map((row, i) => {
            const source = menu === "at" ? SOURCES.find((s) => s.key === row.key) : undefined;
            const Glyph = GLYPHS[source?.glyph ?? "clip"] ?? IconPaperclip;
            return (
              <button
                key={row.key}
                type="button"
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  setActive(i);
                  setEngaged(true);
                }}
                onClick={() => pick(row)}
                className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2 text-left"
              >
                {source && (
                  <span className="flex size-5.5 shrink-0 items-center justify-center text-ink-2">
                    {source.brand ? BRANDS[source.brand] : <Glyph size={15} />}
                  </span>
                )}
                <span className="shrink-0 text-[12.5px] font-medium text-ink">
                  {row.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{row.desc}</span>
                {source?.connect && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      setConnected((current) => !current);
                    }}
                    className={`shrink-0 text-[12px] font-medium transition-colors duration-100 ${
                      connected ? "text-green" : "text-accent-ink hover:underline"
                    }`}
                  >
                    {connected ? "Connected" : "Connect"}
                  </span>
                )}
              </button>
            );
          })}
          {rows.length === 0 && (
            <div className="flex h-9 items-center px-2 text-[12px] text-ink-3">
              No matches for “{query}”
            </div>
          )}
          <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-3">
            {menu === "at" ? "Type to search sources & files" : runtime ? "Type to search commands · Enter runs the command" : "Type to search commands"}
          </div>
        </div>
      )}

      {/* ── model menu ─────────────────────────────────── */}
      {runtime && hasModelMenu && modelOpen && (
        <ModelPicker
          models={runtimeModels ?? []}
          modelValue={runtime.modelValue}
          onSelectModel={(value) => runtime.onSelectModel?.(value)}
          providers={runtime.providers}
          providerValue={runtime.providerValue}
          onSelectProvider={runtime.onSelectProvider}
          fastMode={runtime.fastMode}
          onToggleFastMode={runtime.onToggleFastMode}
          disabled={runtime.disabled || runtime.busy}
          efforts={runtime.efforts}
          effortValue={runtime.effortValue}
          onSelectEffort={runtime.onSelectEffort}
          onManageProviders={runtime.onManageProviders}
          onClose={() => { setModelOpen(false); inputRef.current?.focus(); }}
          className="absolute z-10"
          style={{ width: modelMenuWidth, left: modelMenuLeft, bottom: modelMenuBottom, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
        />
      )}
      {runtime && modeOpen && runtime.modes?.length && (
        <div role="menu" aria-label="Permission mode" className="absolute z-10 w-64 rounded-[10px] bg-surface p-1 shadow-raised" style={{ left: modelMenuLeft, bottom: modelMenuBottom, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}>
          {runtime.modes.map((mode) => (
            <button key={mode.value} type="button" role="menuitemradio" aria-checked={mode.value === runtime.modeValue} onMouseDown={(event) => event.preventDefault()}
              onClick={() => { if (mode.value !== runtime.modeValue) runtime.onSelectMode?.(mode.value); setModeOpen(false); inputRef.current?.focus(); }}
              className="flex w-full items-start gap-2.5 rounded-[7px] px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover">
              <span className="mt-0.5 shrink-0 text-ink-3">{mode.value === "ask" ? <IconLock size={13} /> : <IconLockOpen size={13} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium text-ink">{mode.name}</span>
                {mode.description && <span className="block text-[11.5px] leading-snug text-ink-3">{mode.description}</span>}
              </span>
              <span className={`shrink-0 pt-0.5 text-ink ${mode.value === runtime.modeValue ? "" : "invisible"}`}><IconCheck size={13} strokeWidth={2.5} /></span>
            </button>
          ))}
        </div>
      )}
      {!runtime && modelOpen && (
        <div
          role="listbox"
          aria-label="Models"
          onMouseLeave={() => setModelHovered(null)}
          className="absolute z-10 max-h-64 overflow-y-auto rounded-[10px] bg-surface p-1 shadow-raised"
          style={{ width: modelMenuWidth, left: modelMenuLeft, bottom: modelMenuBottom, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
        >
          {/* single gliding highlight — floats to the hovered / selected row */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
            style={{
              top: modelBox?.top ?? 0,
              height: modelBox?.height ?? 0,
              opacity: modelBox && modelHovered !== null ? 1 : 0,
              transition:
                "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
            }}
          />
          {menuModels.map((m, i) => (
            <button
              key={m.key}
              type="button"
              role="option"
              aria-selected={m.key === currentModelKey}
              ref={(el) => {
                modelRowRefs.current[i] = el;
              }}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setModelHovered(i)}
              onClick={() => {
                selectModel(m);
                inputRef.current?.focus();
              }}
              className="relative z-10 flex h-7.5 w-full items-center gap-2 rounded-[6px] px-2 text-left"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{m.name}</span>
              {m.tag && <span className="shrink-0 text-[11px] text-ink-3">{m.tag}</span>}
              <span className={`shrink-0 text-ink ${m.key === currentModelKey ? "" : "invisible"}`}>
                <IconCheck size={13} strokeWidth={2.5} />
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── composer ───────────────────────────────────── */}
      <div
        className={`relative isolate flex flex-col overflow-hidden border bg-surface shadow-card transition-[border-color,border-radius] duration-150 focus-within:border-line-strong ${dropping ? "border-accent" : "border-line"} ${
          tall ? "gap-2.5 p-3.5" : "gap-1.5 p-1.5"
        } ${
          pill ? (attachments.length > 0 || wide ? "rounded-[24px]" : "rounded-full") : tall ? "rounded-[22px]" : "rounded-[14px]"
        }`}
      >
        {/* rainbow glimm sweep — plays across the interior on model change.
            explicit w/h: a <canvas> is a replaced element and won't stretch
            to inset-0 alone, which feeds back into the shader's ResizeObserver. */}
        <canvas
          ref={glimmRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
          style={{ borderRadius: "inherit" }}
        />
        <span
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none absolute invisible whitespace-pre text-[13px] leading-[18px]"
        >
          {draft}
        </span>

        {staged.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 pt-0.5 ${pill ? "px-1" : "px-0.5"}`}>
            {staged.map((file, i) => (
              <HoverTooltip key={`${file.name}-${i}`} content={file.size ? `${file.mimeType} · ${Math.max(1, Math.round(file.size / 1024))} KB` : undefined}><span

                className={`flex h-6.5 items-center gap-1.5 bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline ${
                  pill ? "rounded-full" : "rounded-chip"
                }`}
                style={{ animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}

              >
                <IconFile size={12} />
                <span className="max-w-36 truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => runtime ? runtime.onRemoveAttachment?.(i) : setAttachments((current) => current.filter((_, j) => j !== i))}
                  className={`-my-1 flex size-6 items-center justify-center text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink ${
                    pill ? "rounded-full" : "rounded-[5px]"
                  }`}
                >
                  <IconClose size={10} strokeWidth={2.5} />
                </button>
              </span></HoverTooltip>
            ))}
          </div>
        )}

        <div
          ref={controlsRef}
          className={`grid items-end gap-x-1 gap-y-1.5 ${
            wide
              ? (showMic ? "grid-cols-[28px_auto_minmax(0,1fr)_28px_28px]" : "grid-cols-[28px_auto_minmax(0,1fr)_28px]")
              : (showMic ? "grid-cols-[28px_minmax(0,1fr)_auto_28px_28px]" : "grid-cols-[28px_minmax(0,1fr)_auto_28px]")
          }`}
        >
          <button
            type="button"
            aria-label={runtime ? "Add files" : "Add attachments and sources"}
            disabled={!!runtime && (runtime.disabled || !runtime.onAddFiles)}
            aria-expanded={!runtime && plusOpen}
            onClick={() => {
              if (runtime) { runtime.onAddFiles?.(); return; }
              setModelOpen(false);
              setPlusOpen((current) => !current);
              inputRef.current?.focus();
            }}
            className={`flex size-7 shrink-0 items-center justify-center justify-self-start text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.94] ${
              pill ? "rounded-full" : "rounded-[8px]"
            } ${plusOpen ? "bg-hover text-ink" : ""} ${wide ? "col-start-1 row-start-2" : "col-start-1 row-start-1"}`}
          >
            <IconPlus size={16} strokeWidth={2} />
          </button>

          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            disabled={runtime?.disabled}
            readOnly={controlled && !runtime.onDraftChange}
            onChange={(event) => {
              draftRevision.current += 1;
              setDraft(event.target.value);
              setDismissed(false);
              setPlusOpen(false);
            }}
            onKeyDown={(event) => {
              if (menu && rows.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setEngaged(true);
                  setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
                  return;
                }
                /* Enter on an exactly typed runtime command runs it; otherwise it completes the row. */
                const exact = !!runtime && event.key === "Enter" && rows[active].name === draft.trim();
                if (!exact && ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")) {
                  event.preventDefault();
                  pick(rows[active]);
                  return;
                }
              }
              if (event.key === "Escape") {
                setDismissed(true);
                closeMenus();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={!runtime && listening ? "Listening…" : placeholder ?? "Write a message…"}
            aria-label="Prompt"
            className={`${tall ? "min-h-[68px] px-2 py-2 text-[14px] leading-5" : "min-h-7 px-1 py-[5px] text-[13px] leading-[18px]"} min-w-0 w-full resize-none bg-transparent text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 ${
              wide ? "col-span-full col-start-1 row-start-1" : "col-start-2 row-start-1"
            }`}
          />

          {/* model picker · reasoning · permission mode */}
          <div ref={modelGroupRef} className={`flex min-w-0 items-center gap-0.5 ${wide ? "col-start-2 row-start-2 justify-self-start" : "col-start-3 row-start-1"}`}>
          <button
            ref={modelRef}
            type="button"
            aria-expanded={hasModelMenu ? modelOpen : undefined}
            aria-haspopup={hasModelMenu ? "dialog" : undefined}
            aria-label={hasModelMenu ? "Choose model" : "Configure model"}
            disabled={!!runtime && (runtime.disabled || (!hasModelMenu && !runtime.onConfigure))}
            onClick={() => {
              if (runtime && !hasModelMenu) {
                runtime.onConfigure?.();
                return;
              }
              setPlusOpen(false);
              setModeOpen(false);
              setModelOpen((current) => !current);
            }}
            className={`flex h-7 min-w-0 shrink items-center gap-1.5 px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink ${
              pill ? "rounded-full" : "rounded-[8px]"
            }`}
          >
            {runtime?.providerValue && <ProviderLogo provider={runtime.providerValue} name={runtime.providers?.find((item) => item.value === runtime.providerValue)?.name} size={13} className="text-ink-3" />}
            <span className="truncate">{runtime ? runtime.modelLabel ?? "Configure model" : model.name}</span>
            <span className="text-ink-3">
              <IconChevronDown size={11} strokeWidth={2.4} />
            </span>
          </button>
          {runtime?.efforts?.length && runtime.effortValue ? (
            <>
              <span aria-hidden className="h-4 w-px bg-line" />
              <HoverTooltip content="Reasoning effort · change it in the model picker"><span aria-label="Reasoning effort"  className="flex h-7 shrink-0 items-center px-1.5 text-[12px] font-medium capitalize text-ink-3">
                {runtime.efforts.find((item) => item.value === runtime.effortValue)?.name ?? runtime.effortValue}
              </span></HoverTooltip>
            </>
          ) : null}
          {runtime?.modes?.length && runtime.modeValue ? (
            <>
              <span aria-hidden className="h-4 w-px bg-line" />
              <button type="button" aria-haspopup="menu" aria-expanded={modeOpen} aria-label={`Permission mode: ${runtime.modes.find((item) => item.value === runtime.modeValue)?.name ?? runtime.modeValue}`} disabled={runtime.disabled}
                onClick={() => { setPlusOpen(false); setModelOpen(false); setModeOpen((current) => !current); }}
                className={`flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink ${pill ? "rounded-full" : "rounded-[8px]"}`}>
                <span className="text-ink-3">{runtime.modeValue === "ask" ? <IconLock size={12} /> : <IconLockOpen size={12} />}</span>
                {runtime.modes.find((item) => item.value === runtime.modeValue)?.name ?? runtime.modeValue}
                <span className="text-ink-3"><IconChevronDown size={11} strokeWidth={2.4} /></span>
              </button>
            </>
          ) : null}
          </div>

          {/* dictation — in runtime mode this drives the host's voice app and only shows when one exists */}
          {showMic && <button
            type="button"
            aria-label={(runtime ? runtime.voice!.listening : listening) ? "Stop dictation" : "Start dictation"}
            disabled={!!runtime && runtime.disabled}
            aria-pressed={runtime ? runtime.voice!.listening : listening}
            onClick={() => runtime ? runtime.voice!.onToggle() : setListening((current) => !current)}
            className={`flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-150 active:scale-[0.94] ${
              pill ? "rounded-full" : "rounded-[8px]"
            } ${(runtime ? runtime.voice!.listening : listening) ? "bg-accent-tint text-accent-ink" : "text-ink-3 hover:bg-hover hover:text-ink"} ${wide ? "col-start-4 row-start-2" : "col-start-4 row-start-1"}`}
          >
            {(runtime ? runtime.voice!.listening : listening) ? (
              <span className="flex h-3.5 items-center gap-[2.5px]">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-[2.5px] rounded-full bg-current"
                    style={{ height: "100%", animation: `eq-bounce 900ms ease-in-out ${i * 150}ms infinite` }}
                  />
                ))}
              </span>
            ) : (
              <IconMic size={15} strokeWidth={2} />
            )}
          </button>}

          {/* send — tactile square (round in the pill variant) */}
          <button
            type="button"
            aria-label={runtime?.busy ? "Stop" : "Send"}
            disabled={runtime?.busy ? !canStop : !canSend}
            onClick={runtime?.busy ? () => runtime.onCancel?.() : send}
            className={`flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] ${
              pill ? "rounded-full" : "rounded-[8px]"
            } ${showMic ? (wide ? "col-start-5 row-start-2" : "col-start-5 row-start-1") : (wide ? "col-start-4 row-start-2" : "col-start-4 row-start-1")}`}
            style={{
              background: canSend || canStop ? "var(--ink)" : "var(--line-strong)",
              color: canSend || canStop ? "var(--surface)" : "var(--ink-2)",
            }}
          >
            {runtime?.busy ? <IconStopFilled size={16} strokeWidth={2.4} /> : <IconArrowUp size={16} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
      </div>
      {sendError && <p role="alert" className="mt-2 text-[12px] text-ink-2">{sendError}</p>}
    </div>
  );
}
