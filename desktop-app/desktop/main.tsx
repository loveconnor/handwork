import React from "react";
import { applyAppearance, savedAppearance } from "@/lib/appearance";
import { createRoot } from "react-dom/client";
import HandworkHarness from "@/components/site/HandworkHarness";
import { ThemeSync } from "@/components/site/ThemeSync";

import "./desktop.css";

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
createRoot(document.getElementById("root")!).render(<ErrorBoundary><ThemeSync /><HandworkHarness /></ErrorBoundary>);
