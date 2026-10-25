import { useState } from "react";
import { createRoot } from "react-dom/client";
import GeneratedReplyDOM from "../../mobile/src/features/sessions/GeneratedReplyDOM";

const program = `root = Stack([form])
form = Form("trip", Buttons([Button("Plan trip", @ToAssistant("Plan my trip", {source: "trip form"}))]), [destination, transport])
destination = FormControl("Destination", Input("destination", "Where to?"))
transport = FormControl("Transport", Select("transport", [SelectItem("train", "Train"), SelectItem("plane", "Plane")], "Choose transport"))`;
function Fixture() {
  const [sent, setSent] = useState("");
  return <>
    <GeneratedReplyDOM
      program={program}
      streaming={false}
      busy={new URLSearchParams(location.search).has("busy")}
      scheme={new URLSearchParams(location.search).has("light") ? "light" : "dark"}
      send={async (text) => { setSent(text); }}
      openUrl={async () => {}}
    />
    <output data-testid="sent">{sent}</output>
  </>;
}
document.body.style.cssText = "background:#0f0f0f;color:#ebebeb;padding:20px;overflow-wrap:anywhere";
createRoot(document.getElementById("root")!).render(<Fixture />);
