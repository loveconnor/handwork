import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import "../../src/styles/index.css";

localStorage.setItem("handwork.pacedReveal", "0");
const formProgram = `root = Stack([form])
form = Form("trip", Buttons([Button("Plan trip", @ToAssistant("Plan my trip", {source: "trip form"}))]), [destination, transport])
destination = FormControl("Destination", Input("destination", "Where to?"))
transport = FormControl("Transport", Select("transport", [SelectItem("train", "Train"), SelectItem("plane", "Plane")], "Choose transport"))`;
function Fixture() {
  const [sent, setSent] = useState("");
  const params = new URLSearchParams(location.search);
  const project = params.has("project");
  const program = params.has("line")
    ? `root = Stack([chart])
chart = LineChart(["Year 1", "Year 2", "Year 3"], [Series("Monthly retainer", [1000, 1050, 1100])], "linear", "Year", "Monthly retainer")`
    : params.has("chart")
      ? `root = Stack([chart, table])
chart = BarChart(["Jan", "Feb"], [Series("Orders", [12, 18])], "grouped", "Month", "Orders")
table = Table([Col("Month", ["Jan", "Feb"]), Col("Orders", [12, 18])])`
      : formProgram;
  return (
    <>
      <AgentTranscript
        blocks={[
          {
            id: "reply",
            role: "assistant",
            text:
              "Choose your destination.\n\n```honestai\n" + program + "\n```",
          },
        ]}
        onGeneratedMessage={project ? undefined : setSent}
      />
      <output data-testid="sent">{sent}</output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
