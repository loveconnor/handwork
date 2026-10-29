import "@/desktop/desktop.css";
import type { Metadata } from "next";
import HandworkHarness from "@/components/site/HandworkHarness";

export const metadata: Metadata = {
  title: "Handwork",
  description:
    "The Handwork desktop harness: your projects, coding tools, and saved conversations, powered by the native Handwork engine.",
};

export default function HarnessPage() {
  return <HandworkHarness />;
}
