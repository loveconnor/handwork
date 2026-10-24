import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EmptySession } from "./EmptySession";

it("shows the starter prompt and composer without games", () => {
  const markup = renderToStaticMarkup(
    createElement(EmptySession, {
      cwd: "/work/demo",
      composer: createElement("textarea", { "aria-label": "Message" }),
    }),
  );
  expect(markup).toContain("What should we work on in demo?");
  expect(markup).toContain('aria-label="Message"');
  expect(markup).not.toContain("<canvas");
});
