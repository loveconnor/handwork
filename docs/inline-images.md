# Inline images

Handwork can draw images, SVG drawings, and Mermaid diagrams inside the interactive transcript. It decodes and rasterizes everything itself and sends the result to your terminal with the best graphics protocol the terminal supports. Terminals without graphics get readable text diagrams and colored half-block image previews; the stored transcript stays unchanged either way.

## What appears as an image

| Source | Shown as an image when |
| --- | --- |
| A Markdown paragraph that is only an image, such as `![plot](out/plot.png)` | The destination is a local file, a `file://` URL, a `data:image/...` URI, or (only when enabled) an `https://` URL, and it decodes. |
| A fenced code block tagged `svg` | The markup parses as SVG. |
| A fenced code block tagged `mermaid` | It is a supported diagram type (see below). |
| Images you attach to a prompt | Always, as a thumbnail under your message (up to 8 rows tall). |

Anything that cannot be drawn keeps its usual text form: the image link label, or the code block.

Images inside a sentence (`see ![x](x.png) here`) stay text. Relative paths resolve against the directory Handwork was started in.

### Formats

- PNG (all color types, bit depths, interlacing, transparency)
- JPEG (baseline and progressive, grayscale, YCbCr, CMYK; EXIF orientation is applied)
- GIF (first frame; animation is not played)
- WebP (lossy, lossless, with alpha, and the first frame of animations)
- SVG (shapes, paths, transforms, gradients, markers, `use`/`symbol`, text, inline and `<style>` CSS)

SVG text is drawn with the Hershey Simplex stroke font, so it looks like a clean single-line technical font rather than the font the drawing names. SVG files are shown on a white background because most are drawn for light pages. Clipping paths, masks, filters, patterns, and images embedded inside an SVG are not drawn.

SIXEL cannot carry fractional opacity. Handwork blends antialiased edges against the detected terminal background before encoding, so thin diagram labels retain their strokes instead of losing pixels below a transparency threshold. Completely empty pixels remain transparent. Changing the terminal background invalidates the composited payloads so their edge colors are rebuilt.

### Mermaid diagrams

Supported: `flowchart`/`graph` (all four directions, the common node shapes, solid, dotted, and thick edges, edge labels, `&` groups, and subgraphs), `stateDiagram`/`stateDiagram-v2`, `sequenceDiagram` (participants, all message arrow types, notes, `loop`/`alt`/`opt`/`par`/`critical`/`break` blocks, `autonumber`), and `pie`.

Other diagram types (for example `classDiagram`, `gantt`, `erDiagram`) stay as code blocks. Styling directives such as `classDef`, `style`, and `linkStyle` are accepted and ignored. Diagram colors follow your terminal's light or dark theme.

## Terminal support

Handwork picks the protocol at startup:

| Terminal | Protocol | How it is drawn |
| --- | --- | --- |
| Kitty, Ghostty | Kitty graphics with Unicode placeholders | The terminal draws the image from placeholder text cells, so it scrolls and redraws like text. |
| iTerm2, WezTerm | iTerm2 inline images | Pixels are drawn over blank cells after each frame. |
| Windows Terminal 1.22+, xterm, foot, VS Code with images enabled, other SIXEL terminals | SIXEL | Pixels are drawn over blank cells after each frame. |
| Apple Terminal, the Windows console host, tmux, screen, and anything else | Half blocks | Each cell shows two pixels with `▀`/`▄` and 24-bit (or 256) colors. |

Terminals that are not recognized by their environment variables are asked directly: Handwork queries Kitty graphics, SIXEL geometry (XTSMGRAPHICS), device attributes, and pixel dimensions. It retries briefly when the terminal answers before its image add-on is ready. SIXEL needs the terminal's cell size in pixels; when the terminal does not report it, Handwork uses half blocks instead of guessing.

Inside tmux or screen, Handwork always uses half blocks. Passing graphics through a multiplexer is not supported.

### Apple Terminal and other terminals without pixel graphics

Mermaid diagrams use native terminal text: flowcharts and state diagrams show node labels and their connections, sequences show participants and ordered messages, and pie charts show labeled values, percentages, and proportional bars. These are text equivalents rather than the graphical layout. Unsupported diagram types and SVG fences keep their source panels. Raster images still use half-block previews; high-resolution inline pixels require a terminal with a supported graphics protocol.

The conversation viewer receives wheel reports directly in Apple Terminal and VS Code rather than relying on alternate-screen arrow-key translation. In Apple Terminal, **View > Allow Mouse Reporting** must be checked (the default for new windows). Otherwise Terminal blocks the events even when Handwork requests them. See [Apple's mouse-reporting guide](https://support.apple.com/guide/terminal/trmlc69728a5/mac). Arrow keys and Page Up/Page Down also scroll the viewer. Mouse reporting returns to the normal composer mode when the viewer closes.

### VS Code

VS Code disables terminal images by default. This repository's `.vscode/settings.json` enables `terminal.integrated.enableImages` for the workspace. Start a new integrated terminal after applying the setting, then restart Handwork so it can detect pixel graphics. Image support also requires VS Code's terminal GPU acceleration; keep `terminal.integrated.gpuAcceleration` set to `auto` or `on`.

Handwork selects SIXEL in VS Code, even when the terminal also acknowledges a Kitty query: that acknowledgment does not establish support for Handwork's Unicode placeholder rendering. Startup probes wait for usable graphics and pixel dimensions instead of treating an early device-attributes reply as a final answer. This follows the graphics-specific probing used in [Oh My Pi](https://github.com/can1357/oh-my-pi/blob/afdc8bd10e69974bfcd7565a2c6f70d1b488919c/packages/tui/src/tui.ts#L2413), while retaining Handwork's own renderer.

When terminal image support is disabled, Mermaid diagrams use native text and raster images use half blocks. `HANDWORK_IMAGES=off` keeps diagram source and image labels as text instead. See [VS Code's terminal documentation](https://code.visualstudio.com/docs/terminal/advanced#_images).

## Controlling images

Set `HANDWORK_IMAGES` before starting Handwork to override detection:

| Value | Effect |
| --- | --- |
| `kitty`, `iterm2`, `sixel`, `blocks` | Use that protocol. |
| `off` (or `none`, `0`, `false`) | Draw no images; keep the text forms. |

For example, `HANDWORK_IMAGES=blocks handwork`.

## Remote images are off by default

Handwork does not load `http://` or `https://` images unless you set `HANDWORK_REMOTE_IMAGES=1`.

A model can be steered, for example by instructions hidden in a web page it read, into writing an image link whose URL carries parts of your conversation. Loading that image would send the data to whoever controls the URL. Keeping remote images off removes that path.

When you turn remote images on, each URL is fetched once per session with the same protections as the web tool: public addresses only, no redirects to other hosts, a 10 MiB limit, and a 5-second deadline.

## Limits

- An image appears only if it decodes when its message arrives. A file created afterward will not appear in that message.
- With iTerm2 and SIXEL protocols, Handwork redraws visible images whenever the transcript scrolls, because scrolling repaints the screen. Over slow connections such as SSH, large images can make streaming feel slower; `HANDWORK_IMAGES=blocks` avoids this.
- Images in tool results (for example screenshots returned by MCP tools) are sent to the model but are not yet shown in the transcript.
- CMYK JPEGs are converted without a color profile, so their colors are approximate.
- Diagram layout is automatic and aims for readability, not an exact match with Mermaid's own renderer.

## Development checks

Run the focused image suite without starting a provider session:

```sh
zig build test-images --test-timeout 60s --summary all
```

It covers independent reference pixels for PNG, GIF, baseline/progressive/grayscale/CMYK JPEG, and lossless/lossy WebP; allocation failures; seeded malformed inputs; SVG and Mermaid rendering; terminal detection; placeholder layout; synchronized frame writes; cache eviction; and transcript text fallback. The synthetic fixtures and their regeneration instructions live in `src/core/images/fixtures`.

Cross-compile the tests for each Windows architecture:

```sh
zig build test-images-check -Dtarget=x86_64-windows-gnu -Doptimize=ReleaseSafe
zig build test-images-check -Dtarget=aarch64-windows-gnu -Doptimize=ReleaseSafe
```

Windows CI runs `test-images` on its native x64 host. Cross-compilation checks types and linking; it does not verify a terminal's display behavior.

For a terminal walkthrough, show a local raster, an SVG fence, a Mermaid fence, and an attachment thumbnail. Resize the window and change its font size, scroll until each image is partly visible, open and close the full transcript with Control-O, and confirm neighboring text and the composer remain usable. Repeat with `HANDWORK_IMAGES=off` to check labels and code fallbacks, including keyboard and screen-reader use. Native terminal display, clipboard selection, and assistive-technology checks remain separate from protocol and PTY automation.
