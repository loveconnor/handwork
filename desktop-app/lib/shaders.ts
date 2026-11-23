import type { Backdrop, BackdropStrength } from './desktop-api';

/**
 * Live backdrop shaders. Each one is a small fragment shader that paints a
 * colour field and how much of it to show; the field is then laid over the
 * window's own chrome colour, so a shader never fights the palette under it.
 * Everything is slow on purpose: it should feel like light moving, not motion.
 */
export type ShaderId = Exclude<Backdrop, 'none'>;
type RGB = [number, number, number];
type Colors = { c1: RGB; c2: RGB; c3: RGB };

const hex = (value: string): RGB => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255) as RGB;
const set = (a: string, b: string, c: string): Colors => ({ c1: hex(a), c2: hex(b), c3: hex(c) });

export const shaderPalettes: Record<ShaderId, { light: Colors; dark: Colors }> = {
  aurora: { light: set('#8fd6c3', '#9fb2f2', '#f0b9d6'), dark: set('#178a6c', '#3245b8', '#8c3290') },
  silk: { light: set('#e4c9ab', '#c7b6ec', '#ffffff'), dark: set('#4c3b60', '#2a4064', '#b8a4dc') },
  nebula: { light: set('#f7c4a1', '#b3c6f8', '#d5b2f2'), dark: set('#5e2370', '#1c3880', '#8a3640') },
  dune: { light: set('#efd2ab', '#e3b08f', '#fbf0e2'), dark: set('#4d3520', '#2b1f15', '#8c6440') },
};
export const shaderStrength: Record<BackdropStrength, number> = { subtle: 0.42, balanced: 0.68, vivid: 1 };

const common = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res; uniform float u_time; uniform vec3 u_base; uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3; uniform float u_mix;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
`;

const bodies: Record<ShaderId, string> = {
  // Two soft ribbons drifting across the sky, with faint vertical rays.
  aurora: `
vec4 shade(vec2 uv, float aspect, float t) {
  vec2 p = vec2(uv.x * aspect, uv.y);
  float w = fbm(vec2(p.x * 1.1 + t * 0.04, t * 0.03));
  float y1 = 0.64 + 0.34 * (w - 0.5) + 0.05 * sin(p.x * 2.1 + t * 0.15);
  float d1 = uv.y - y1; float r1 = exp(-d1 * d1 * 26.0);
  float rays = 0.6 + 0.4 * fbm(vec2(p.x * 6.0 + t * 0.06, uv.y * 1.2 - t * 0.02));
  float y2 = 0.34 + 0.3 * (fbm(vec2(p.x * 1.3 - t * 0.035, 3.0 + t * 0.02)) - 0.5);
  float d2 = uv.y - y2; float r2 = exp(-d2 * d2 * 22.0);
  vec3 col = mix(u_c1, u_c2, smoothstep(0.25, 0.75, w + 0.25 * (uv.x - 0.5)));
  col = mix(col, u_c3, r2 * 0.85);
  float a = max(r1 * rays, r2 * 0.7);
  return vec4(col, a * 0.92 + 0.08);
}`,
  // Folded satin: a gently warped field with a sheen along its creases.
  silk: `
vec4 shade(vec2 uv, float aspect, float t) {
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 1.5;
  float tt = t * 0.11;
  for (int i = 1; i < 5; i++) {
    float fi = float(i);
    p += vec2(0.6 / fi * sin(fi * p.y + tt + 0.3 * fi), 0.5 / fi * cos(fi * p.x + tt * 0.8 + 0.7 * fi));
  }
  float v = 0.5 + 0.5 * sin(p.x * 1.1 + p.y * 0.9);
  float h = pow(0.5 + 0.5 * sin(p.x * 1.6 - p.y * 1.25 + 1.2), 7.0);
  vec3 col = mix(u_c1, u_c2, v);
  col = mix(col, u_c3, h * 0.75);
  return vec4(col, 0.58 + 0.3 * v + 0.35 * h);
}`,
  // Three slow clouds of colour that wander and blend into each other.
  nebula: `
vec4 shade(vec2 uv, float aspect, float t) {
  vec2 p = vec2(uv.x * aspect, uv.y); float tt = t * 0.07;
  p += 0.1 * vec2(fbm(p * 1.8 + tt), fbm(p * 1.8 - tt + 5.0)) - 0.05;
  vec2 a1 = vec2(aspect * (0.22 + 0.16 * sin(tt * 1.1)), 0.72 + 0.18 * cos(tt * 0.9));
  vec2 a2 = vec2(aspect * (0.78 + 0.14 * cos(tt * 0.8 + 1.0)), 0.28 + 0.18 * sin(tt * 1.2));
  vec2 a3 = vec2(aspect * (0.5 + 0.28 * sin(tt * 0.6 + 2.0)), 0.5 + 0.24 * cos(tt * 0.7 + 3.0));
  float w1 = exp(-dot(p - a1, p - a1) * 2.6);
  float w2 = exp(-dot(p - a2, p - a2) * 2.6);
  float w3 = exp(-dot(p - a3, p - a3) * 3.2);
  float s = w1 + w2 + w3 + 0.0001;
  vec3 col = (u_c1 * w1 + u_c2 * w2 + u_c3 * w3) / s;
  return vec4(col, clamp(s * 0.95, 0.0, 0.95));
}`,
  // Wind-shaped sand: broad warm bands with fine contour lines.
  dune: `
vec4 shade(vec2 uv, float aspect, float t) {
  vec2 p = vec2(uv.x * aspect, uv.y); float tt = t * 0.045;
  float h = uv.y * 1.35 + 0.75 * fbm(p * 0.65 + vec2(tt, tt * 0.4));
  float bands = 0.5 + 0.5 * sin(h * 6.2831);
  float ridge = pow(0.5 + 0.5 * sin(h * 6.2831 + 1.4), 10.0);
  float grain = fbm(p * 9.0 + vec2(h * 3.0, 0.0)) - 0.5;
  vec3 col = mix(u_c2, u_c1, smoothstep(0.1, 0.9, bands));
  col = mix(col, u_c3, ridge * 0.55);
  return vec4(col, 0.6 + 0.25 * bands + 0.2 * ridge + 0.08 * grain);
}`,
};

const main = `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec4 s = shade(uv, u_res.x / u_res.y, u_time);
  vec3 col = mix(u_base, s.rgb, clamp(s.a * u_mix, 0.0, 1.0));
  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * (1.5 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}`;

const vertex = 'attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }';

/** Any CSS colour (hex, oklch, color-mix) as 0..1 sRGB, via a 1px canvas. */
export function cssColor(value: string, fallback: RGB = [0.96, 0.96, 0.95]): RGB {
  try {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!ctx || !value.trim()) return fallback;
    ctx.fillStyle = '#000'; ctx.fillStyle = value.trim(); ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255];
  } catch { return fallback; }
}

export type ShaderInput = { base: RGB; colors: Colors; mix: number };

/**
 * One WebGL context for every shader on the page. Each view draws into it and
 * copies the frame onto its own 2D canvas, so the app holds a single GPU
 * context however many previews are open, and a lost context (a GPU reset, a
 * graphics switch) never shows the browser's broken-canvas face: the views
 * keep their last frame until the context is restored and rebuilt.
 */
class ShaderEngine {
  readonly canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext;
  private programs = new Map<ShaderId, { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }>();
  private lost = false;

  constructor() {
    const gl = this.canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL is unavailable.');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.lost = true; this.programs.clear(); });
    this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.setup(); });
    this.setup();
  }

  private setup() {
    const { gl } = this;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  }

  private program(id: ShaderId) {
    const cached = this.programs.get(id);
    if (cached) return cached;
    const { gl } = this;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader failed to compile.');
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, common + bodies[id] + main));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader failed to link.');
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of ['u_res', 'u_time', 'u_base', 'u_c1', 'u_c2', 'u_c3', 'u_mix']) uniforms[name] = gl.getUniformLocation(program, name);
    const entry = { program, uniforms };
    this.programs.set(id, entry);
    return entry;
  }

  /** Checks the shader builds here, so a view can fall back before showing. */
  prepare(id: ShaderId) { if (!this.lost) this.program(id); }

  /** Renders one frame and copies it onto the view's canvas. False while the context is gone. */
  render(id: ShaderId, target: CanvasRenderingContext2D, width: number, height: number, time: number, input: ShaderInput) {
    const { gl } = this;
    if (this.lost || gl.isContextLost()) return false;
    // The shared canvas only grows; each view draws into its bottom-left corner.
    if (this.canvas.width < width || this.canvas.height < height) {
      this.canvas.width = Math.max(this.canvas.width, width);
      this.canvas.height = Math.max(this.canvas.height, height);
    }
    const { program, uniforms } = this.program(id);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, width, height);
    gl.uniform2f(uniforms.u_res, width, height);
    gl.uniform1f(uniforms.u_time, time);
    gl.uniform3fv(uniforms.u_base, input.base);
    gl.uniform3fv(uniforms.u_c1, input.colors.c1);
    gl.uniform3fv(uniforms.u_c2, input.colors.c2);
    gl.uniform3fv(uniforms.u_c3, input.colors.c3);
    gl.uniform1f(uniforms.u_mix, input.mix);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    target.drawImage(this.canvas, 0, this.canvas.height - height, width, height, 0, 0, width, height);
    return true;
  }
}

let engine: ShaderEngine | null = null;
let engineFailedAt = -Infinity;
/** The shared engine, made on first use. A failed start is retried after a
 *  pause (the GPU may be resetting) rather than written off for the session. */
function sharedEngine() {
  if (engine || performance.now() - engineFailedAt < 3000) return engine;
  try { engine = new ShaderEngine(); } catch { engineFailedAt = performance.now(); }
  return engine;
}

/**
 * Shows one shader on one canvas. It renders below device resolution (the
 * fields are soft, so nothing is lost), caps its frame rate, sleeps while the
 * page is hidden, and draws a single still frame under reduced motion.
 */
export class ShaderView {
  private engine: ShaderEngine;
  private context: CanvasRenderingContext2D;
  private input: ShaderInput;
  private from: ShaderInput | null = null;
  private target: ShaderInput;
  private fadeStart = 0;
  private frame = 0;
  private last = 0;
  private clock = 0;
  private running = false;
  private resize: ResizeObserver;
  private still = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private canvas: HTMLCanvasElement, private id: ShaderId, input: ShaderInput, private options: { scale?: number; fps?: number; seed?: number } = {}) {
    // Check the GPU first: asking for an opaque 2D context paints the canvas
    // black, which would hide the fallback beneath it.
    const shared = sharedEngine();
    if (!shared) throw new Error('WebGL is unavailable.');
    shared.prepare(id);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas is unavailable.');
    this.engine = shared;
    this.context = context;
    this.input = this.target = input;
    this.clock = options.seed ?? 30;
    this.resize = new ResizeObserver(() => { this.fit(); this.draw(); });
    this.resize.observe(canvas);
    this.fit();
    document.addEventListener('visibilitychange', this.wake);
    this.still.addEventListener('change', this.wake);
    this.wake();
    this.draw();
  }

  /** New colours glide in over a moment rather than snapping, so a theme
   *  change feels like the light shifting. Reduced motion swaps them at once. */
  update(input: ShaderInput) {
    if (this.still.matches || document.visibilityState === 'hidden') { this.input = this.target = input; this.from = null; this.draw(); return; }
    this.from = this.input; this.target = input; this.fadeStart = performance.now();
    if (!this.running) this.wake();
  }

  private blend(now: number) {
    if (!this.from) return;
    const progress = Math.min(1, (now - this.fadeStart) / 420);
    const eased = 1 - Math.pow(1 - progress, 3);
    const mixRGB = (a: RGB, b: RGB): RGB => [a[0] + (b[0] - a[0]) * eased, a[1] + (b[1] - a[1]) * eased, a[2] + (b[2] - a[2]) * eased];
    const { from, target } = this;
    this.input = { base: mixRGB(from.base, target.base), colors: { c1: mixRGB(from.colors.c1, target.colors.c1), c2: mixRGB(from.colors.c2, target.colors.c2), c3: mixRGB(from.colors.c3, target.colors.c3) }, mix: from.mix + (target.mix - from.mix) * eased };
    if (progress >= 1) { this.input = target; this.from = null; }
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    document.removeEventListener('visibilitychange', this.wake);
    this.still.removeEventListener('change', this.wake);
  }

  private fit() {
    const scale = this.options.scale ?? 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
  }

  private draw() {
    try { this.engine.render(this.id, this.context, this.canvas.width, this.canvas.height, this.clock, this.input); }
    catch { /* Keep the last frame; the next one retries. */ }
  }

  private wake = () => {
    const animate = document.visibilityState !== 'hidden' && !this.still.matches;
    if (animate && !this.running) { this.running = true; this.last = performance.now(); this.frame = requestAnimationFrame(this.tick); }
    if (!animate) { this.running = false; cancelAnimationFrame(this.frame); if (this.from) { this.input = this.target; this.from = null; } this.draw(); }
  };

  private tick = (now: number) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    // Colour fades run at full rate so they stay smooth; drifting runs capped.
    const interval = this.from ? 0 : 1000 / (this.options.fps ?? 30);
    const elapsed = now - this.last;
    if (elapsed < interval - 1) return;
    this.blend(now);
    // A long gap (sleep, a stalled frame) resumes smoothly instead of jumping.
    this.clock += Math.min(elapsed, 100) / 1000;
    this.last = now;
    this.draw();
  };
}

/** The colours a shader should use right now, read from the live theme. */
export function shaderInput(id: ShaderId, strength: BackdropStrength | string | undefined, root: HTMLElement = document.documentElement): ShaderInput {
  const dark = root.dataset.theme === 'dark';
  const base = cssColor(getComputedStyle(root).getPropertyValue('--hw-chrome'), dark ? [0.06, 0.06, 0.065] : [0.965, 0.96, 0.95]);
  const mix = shaderStrength[(strength as BackdropStrength)] ?? shaderStrength.balanced;
  return { base, colors: shaderPalettes[id][dark ? 'dark' : 'light'], mix: dark ? mix * 0.9 : mix };
}
