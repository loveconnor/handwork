import React from "react";
import { applyAppearance, savedAppearance } from "@/lib/appearance";
import { createRoot } from "react-dom/client";
import HandworkHarness from "@/components/site/HandworkHarness";
import HandworkQuickEntry from "@/components/site/HandworkQuickEntry";
import { ThemeSync } from "@/components/site/ThemeSync";
import { TooltipProvider } from "@/components/ui/tooltip";

import "katex/dist/katex.min.css";
import "./desktop.css";
import "./surface.css";

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="min-h-screen bg-canvas p-8 text-ink"><h1>Handwork could not render this view.</h1><pre className="mt-4 whitespace-pre-wrap">{this.state.error}</pre><p className="mt-4">Quit and reopen the app to recover your saved conversation. Completed tool actions are not undone.</p></main>;
    return this.props.children;
  }
}
applyAppearance(savedAppearance());
// This is the same /harness component as the web route, without the marketing layout.
// The global shortcut opens the same renderer in a compact window.
const quick = window.location.hash === "#quick";
createRoot(document.getElementById("root")!).render(<ErrorBoundary><TooltipProvider><ThemeSync />{quick ? <HandworkQuickEntry /> : <HandworkHarness />}</TooltipProvider></ErrorBoundary>);
