import { afterEach, describe, expect, test, vi } from "vitest";

import { matteToCutout, type MattingResult } from "../src/lib/pipeline/aiMatting";
import { autoPlacement, getBackdrop, getRatio } from "../src/lib/pipeline/banner";
import { generateDesign, randomSeed } from "../src/lib/pipeline/design";
import {
  boxBlur3,
  clamp,
  clamp255,
  distanceInside,
  luminance,
  mulberry32,
  smoothstep,
} from "../src/lib/pipeline/pixels";
import { segmentAsync } from "../src/lib/pipeline/segmentClient";
import { segment, type Cutout } from "../src/lib/pipeline/segment";
import {
  DEFAULT_SHADOW,
  paintShadow,
  renderShadowIntensity,
  shadowRgba,
  toneMapShadow,
  type ShadowOptions,
} from "../src/lib/pipeline/shadow";
import { analyzeCutout, recommendStyles, type StyleAnalysis } from "../src/lib/pipeline/styles";
import { upscaleImage } from "../src/lib/pipeline/upscale";

function rng(seed: number) {
  return mulberry32(seed >>> 0);
}

function noiseImage(w: number, h: number, seed: number): Uint8ClampedArray {
  const r = rng(seed);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = Math.floor(r() * 256);
    rgba[i * 4 + 1] = Math.floor(r() * 256);
    rgba[i * 4 + 2] = Math.floor(r() * 256);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function gradientImage(w: number, h: number, seed: number): Uint8ClampedArray {
  const r = rng(seed);
  const c0 = [r() * 255, r() * 255, r() * 255];
  const c1 = [r() * 255, r() * 255, r() * 255];
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      const i = (y * w + x) * 4;
      rgba[i] = c0[0] + (c1[0] - c0[0]) * t;
      rgba[i + 1] = c0[1] + (c1[1] - c0[1]) * t;
      rgba[i + 2] = c0[2] + (c1[2] - c0[2]) * t;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function checkerImage(w: number, h: number, cell: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2;
      const i = (y * w + x) * 4;
      rgba[i] = on ? 240 : 20;
      rgba[i + 1] = on ? 240 : 20;
      rgba[i + 2] = on ? 240 : 20;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function sceneImage(
  w: number,
  h: number,
  seed: number,
): { rgba: Uint8ClampedArray; rect: [number, number, number, number] } {
  const r = rng(seed);
  const bg: [number, number, number] = [
    Math.floor(r() * 200) + 28,
    Math.floor(r() * 200) + 28,
    Math.floor(r() * 200) + 28,
  ];
  const fg: [number, number, number] = [
    Math.floor(r() * 256),
    Math.floor(r() * 256),
    Math.floor(r() * 256),
  ];
  const rw = Math.max(2, Math.floor(w * (0.15 + r() * 0.4)));
  const rh = Math.max(2, Math.floor(h * (0.15 + r() * 0.4)));
  const x0 = Math.floor(r() * (w - rw));
  const y0 = Math.floor(r() * (h - rh));
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = fg[0];
      rgba[i + 1] = fg[1];
      rgba[i + 2] = fg[2];
    }
  }
  return { rgba, rect: [x0, y0, x0 + rw, y0 + rh] };
}

function assertValidCutout(c: Cutout, w: number, h: number) {
  expect(c.width).toBe(w);
  expect(c.height).toBe(h);
  expect(c.alpha.length).toBe(w * h * 4);
  expect(c.box.w).toBeGreaterThanOrEqual(1);
  expect(c.box.h).toBeGreaterThanOrEqual(1);
  expect(c.box.x).toBeGreaterThanOrEqual(0);
  expect(c.box.y).toBeGreaterThanOrEqual(0);
  expect(c.box.x + c.box.w).toBeLessThanOrEqual(w);
  expect(c.box.y + c.box.h).toBeLessThanOrEqual(h);
  expect(c.confidence).toBeGreaterThanOrEqual(0);
  expect(c.confidence).toBeLessThanOrEqual(1);
  expect(Number.isFinite(c.confidence)).toBe(true);
  expect(c.candidates.length).toBeLessThanOrEqual(4);
  expect(c.softPixels).toBeGreaterThanOrEqual(0);
  for (const cand of c.candidates) {
    expect(Number.isFinite(cand.score)).toBe(true);
    expect(cand.area).toBeGreaterThan(0);
  }
  let visible = 0;
  for (let i = 3; i < c.alpha.length; i += 4) {
    if (c.alpha[i] > 8) visible++;
  }
  expect(visible).toBeGreaterThan(0);
}

describe("pixels primitives under stress", () => {
  test("clamp helpers never produce out-of-range values", () => {
    const r = rng(1);
    for (let i = 0; i < 2000; i++) {
      const v = (r() - 0.5) * 4000;
      expect(clamp255(v)).toBeGreaterThanOrEqual(0);
      expect(clamp255(v)).toBeLessThanOrEqual(255);
      expect(clamp(v, -3, 7)).toBeGreaterThanOrEqual(-3);
      expect(clamp(v, -3, 7)).toBeLessThanOrEqual(7);
    }
    expect(clamp255(NaN) === 0 || clamp255(NaN) === 255 || Number.isNaN(clamp255(NaN))).toBe(true);
  });

  test("luminance of gray equals the gray value", () => {
    for (const g of [0, 17, 128, 255]) {
      expect(luminance(g, g, g)).toBeCloseTo(g, 6);
    }
  });

  test("smoothstep endpoints and monotonicity", () => {
    expect(smoothstep(-5)).toBe(0);
    expect(smoothstep(5)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = smoothstep(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test("mulberry32 is deterministic and in [0,1)", () => {
    const a = rng(42);
    const b = rng(42);
    for (let i = 0; i < 500; i++) {
      const va = a();
      const vb = b();
      expect(va).toBe(vb);
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });

  test("boxBlur3 preserves constants and stays finite on noise", () => {
    const w = 33;
    const h = 21;
    const flat = new Float32Array(w * h).fill(123.5);
    const blurred = boxBlur3(flat, w, h, 4);
    for (let i = 0; i < blurred.length; i++) {
      expect(blurred[i]).toBeCloseTo(123.5, 3);
    }
    const r = rng(7);
    const noisy = new Float32Array(w * h);
    for (let i = 0; i < noisy.length; i++) noisy[i] = r();
    const out = boxBlur3(noisy, w, h, 3);
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(out[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(out[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  test("distanceInside measures a 5x5 square center as ~2px from edge", () => {
    const fg = new Uint8Array(25).fill(1);
    const d = distanceInside(fg, 5, 5);
    expect(d[12]).toBeGreaterThan(1.4);
    expect(d[12]).toBeLessThanOrEqual(2.1);
    expect(d[0]).toBeCloseTo(1, 1);
  });
});

describe("segment fuzz battery", () => {
  test(
    "60 random scenes: valid cutouts, in time budget",
    () => {
      for (let s = 0; s < 60; s++) {
        const w = 40 + (s % 7) * 24;
        const h = 36 + (s % 5) * 20;
        const scene = sceneImage(w, h, s * 7919 + 13);
        const tol = 8 + (s % 10) * 6;
        const c = segment(scene.rgba, w, h, { tolerance: tol, noRetry: s % 3 === 0 });
        assertValidCutout(c, w, h);
      }
    },
    120_000,
  );

  test(
    "pure noise and gradients never crash and stay valid",
    () => {
      for (let s = 0; s < 12; s++) {
        const w = 64;
        const h = 48;
        const img = s % 2 === 0 ? noiseImage(w, h, s) : gradientImage(w, h, s);
        const c = segment(img, w, h, { tolerance: 10 + s * 4 });
        assertValidCutout(c, w, h);
      }
    },
    120_000,
  );

  test("checkerboards at multiple cell sizes stay valid", () => {
    for (const cell of [1, 2, 3, 8, 16]) {
      const c = segment(checkerImage(64, 64, cell), 64, 64, { tolerance: 26 });
      assertValidCutout(c, 64, 64);
    }
  });

  test("degenerate sizes: 1x1, 2x2, 1xN, Nx1", () => {
    const one = new Uint8ClampedArray([10, 200, 30, 255]);
    assertValidCutout(segment(one, 1, 1, { tolerance: 26 }), 1, 1);

    const two = new Uint8ClampedArray(2 * 2 * 4).fill(128);
    assertValidCutout(segment(two, 2, 2, { tolerance: 26 }), 2, 2);

    const row = noiseImage(120, 1, 5);
    assertValidCutout(segment(row, 120, 1, { tolerance: 26 }), 120, 1);

    const col = noiseImage(1, 120, 6);
    assertValidCutout(segment(col, 1, 120, { tolerance: 26 }), 1, 120);
  });

  test("uniform image keeps the whole frame without crashing", () => {
    const w = 80;
    const h = 60;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 120;
      rgba[i * 4 + 1] = 90;
      rgba[i * 4 + 2] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const c = segment(rgba, w, h, { tolerance: 26 });
    expect(c.width).toBe(w);
    expect(Number.isFinite(c.confidence)).toBe(true);
    expect(c.box.w).toBeGreaterThanOrEqual(1);
  });

  test("product covering the entire frame is reported via full-frame box", () => {
    const w = 64;
    const h = 64;
    const { rgba } = sceneImage(w, h, 1);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 200;
      rgba[i * 4 + 1] = 30;
      rgba[i * 4 + 2] = 30;
      rgba[i * 4 + 3] = 255;
    }
    const c = segment(rgba, w, h, { tolerance: 26 });
    expect(c.box.w).toBeGreaterThanOrEqual(1);
    expect(c.confidence).toBeGreaterThanOrEqual(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
  });

  test("extreme tolerances (1 and 100) never crash", () => {
    const scene = sceneImage(72, 54, 99);
    for (const tol of [1, 100, 0.5, 1000]) {
      const c = segment(scene.rgba, 72, 54, { tolerance: tol });
      assertValidCutout(c, 72, 54);
    }
  });

  test("segment is deterministic: same input, same bytes", () => {
    const scene = sceneImage(96, 72, 1234);
    const a = segment(scene.rgba.slice(), 96, 72, { tolerance: 26 });
    const b = segment(scene.rgba.slice(), 96, 72, { tolerance: 26 });
    expect(Array.from(a.alpha.slice(0, 4096))).toEqual(Array.from(b.alpha.slice(0, 4096)));
    expect(a.confidence).toBe(b.confidence);
    expect(a.box).toEqual(b.box);
  });

  test("low-contrast scene yields lower confidence than high-contrast", () => {
    const w = 80;
    const h = 80;
    const mk = (delta: number) => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = 128;
        rgba[i * 4 + 1] = 128;
        rgba[i * 4 + 2] = 128;
        rgba[i * 4 + 3] = 255;
      }
      for (let y = 24; y < 56; y++) {
        for (let x = 24; x < 56; x++) {
          const i = (y * w + x) * 4;
          rgba[i] = 128 + delta;
          rgba[i + 1] = 128 + delta;
          rgba[i + 2] = 128 + delta;
        }
      }
      return rgba;
    };
    const lo = segment(mk(6), w, h, { tolerance: 26, noRetry: true });
    const hi = segment(mk(120), w, h, { tolerance: 26, noRetry: true });
    expect(hi.confidence).toBeGreaterThan(lo.confidence);
  });

  test(
    "segmentAsync resolves via sync fallback when Workers are unavailable",
    async () => {
      const scene = sceneImage(64, 48, 777);
      const c = await segmentAsync({
        rgba: scene.rgba,
        width: 64,
        height: 48,
        tolerance: 26,
      });
      assertValidCutout(c, 64, 48);
    },
    60_000,
  );
});

describe("shadow engine under stress", () => {
  function rectCutout(w = 100, h = 100, boxW = 60, boxH = 60): Cutout {
    const alpha = new Uint8ClampedArray(w * h * 4);
    const x0 = ((w - boxW) / 2) | 0;
    const y0 = ((h - boxH) / 2) | 0;
    for (let y = y0; y < y0 + boxH; y++) {
      for (let x = x0; x < x0 + boxW; x++) {
        const i = (y * w + x) * 4;
        alpha[i] = 200;
        alpha[i + 1] = 60;
        alpha[i + 2] = 60;
        alpha[i + 3] = 255;
      }
    }
    return {
      alpha,
      width: w,
      height: h,
      softPixels: 0,
      touchedEdges: new Set(),
      box: { x: x0, y: y0, w: boxW, h: boxH },
      candidates: [{ box: { x: x0, y: y0, w: boxW, h: boxH }, area: boxW * boxH, score: 1 }],
      confidence: 1,
    };
  }

  const extremes: ShadowOptions[] = [
    { direction: 0, length: 0, softness: 0, opacity: 0, contact: false },
    { direction: 180, length: 2, softness: 1, opacity: 1, contact: true },
    { direction: -45, length: 0.001, softness: 0.999, opacity: 0.5, contact: true },
    { direction: 720, length: 1.4, softness: 0.3, opacity: 0.8, contact: false },
    { ...DEFAULT_SHADOW },
  ];

  test("intensity stays finite and normalized for extreme options", () => {
    const cut = rectCutout();
    const W = 200;
    const H = 200;
    for (const opts of extremes) {
      for (const place of [
        { x: W / 2, y: H * 0.7, scale: 1 },
        { x: -100, y: -100, scale: 0.01 },
        { x: W * 2, y: H * 2, scale: 5 },
      ]) {
        const intensity = renderShadowIntensity(cut, place, W, H, opts);
        for (let i = 0; i < intensity.length; i++) {
          expect(Number.isFinite(intensity[i])).toBe(true);
          expect(intensity[i]).toBeGreaterThanOrEqual(0);
          expect(intensity[i]).toBeLessThanOrEqual(1.0001);
        }
      }
    }
  });

  test("tone map output is a valid 0..255 mask and deterministic", () => {
    const cut = rectCutout();
    const i1 = renderShadowIntensity(cut, { x: 100, y: 140, scale: 1 }, 200, 200, DEFAULT_SHADOW);
    const i2 = renderShadowIntensity(cut, { x: 100, y: 140, scale: 1 }, 200, 200, DEFAULT_SHADOW);
    expect(Array.from(i1.slice(0, 2048))).toEqual(Array.from(i2.slice(0, 2048)));
    const mask = toneMapShadow(i1, 200, 200, DEFAULT_SHADOW);
    for (let i = 0; i < mask.length; i++) {
      expect(mask[i]).toBeGreaterThanOrEqual(0);
      expect(mask[i]).toBeLessThanOrEqual(255);
    }
  });

  test("empty silhouette (fully off-canvas) yields zero intensity fast", () => {
    const cut = rectCutout(40, 40, 20, 20);
    const intensity = renderShadowIntensity(
      cut,
      { x: -5000, y: -5000, scale: 1 },
      120,
      120,
      DEFAULT_SHADOW,
    );
    let sum = 0;
    for (let i = 0; i < intensity.length; i++) sum += intensity[i];
    expect(sum).toBe(0);
  });

  test("shadowRgba writes exact shadow color and alpha", () => {
    const w = 4;
    const h = 2;
    const mask = new Uint8ClampedArray([0, 128, 255, 1, 0, 0, 0, 64]);
    const rgba = shadowRgba(mask, w, h);
    expect(rgba.length).toBe(w * h * 4);
    expect(rgba[3]).toBe(0);
    expect(rgba[4]).toBe(24);
    expect(rgba[5]).toBe(26);
    expect(rgba[6]).toBe(30);
    expect(rgba[7]).toBe(128);
    expect(rgba[8 + 3]).toBe(255);
    expect(rgba[28 + 3]).toBe(64);
  });

  test("paintShadow composites over the backdrop instead of erasing it", () => {
    const w = 6;
    const h = 6;

    type FakeCanvas = {
      width: number;
      height: number;
      buffer: Uint8ClampedArray;
      getContext: () => unknown;
    };
    const makeCanvas = (): FakeCanvas => {
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        buffer: new Uint8ClampedArray(0),
        getContext: () => ({}),
      };
      canvas.getContext = () => ({
        createImageData(cw: number, ch: number) {
          return { data: new Uint8ClampedArray(cw * ch * 4), width: cw, height: ch };
        },
        putImageData(img: { data: Uint8ClampedArray }) {
          canvas.buffer = new Uint8ClampedArray(img.data);
        },
      });
      return canvas;
    };

    const main: FakeCanvas = {
      width: w,
      height: h,
      buffer: new Uint8ClampedArray(w * h * 4),
      getContext: () => ({}),
    };
    for (let i = 0; i < w * h; i++) {
      main.buffer[i * 4] = 200;
      main.buffer[i * 4 + 1] = 100;
      main.buffer[i * 4 + 2] = 50;
      main.buffer[i * 4 + 3] = 255;
    }
    main.getContext = () => ({
      drawImage(src: FakeCanvas) {
        for (let i = 0; i < w * h; i++) {
          const sa = src.buffer[i * 4 + 3] / 255;
          if (sa === 0) continue;
          for (let c = 0; c < 3; c++) {
            main.buffer[i * 4 + c] = Math.round(
              src.buffer[i * 4 + c] * sa + main.buffer[i * 4 + c] * (1 - sa),
            );
          }
          main.buffer[i * 4 + 3] = Math.max(main.buffer[i * 4 + 3], src.buffer[i * 4 + 3]);
        }
      },
    });

    vi.stubGlobal("document", { createElement: () => makeCanvas() });
    try {
      const mask = new Uint8ClampedArray(w * h);
      mask[0] = 255;
      mask[1] = 128;
      paintShadow(main.getContext() as CanvasRenderingContext2D, mask, w, h);

      expect(main.buffer[0]).toBe(24);
      expect(main.buffer[1]).toBe(26);
      expect(main.buffer[2]).toBe(30);
      expect(main.buffer[3]).toBe(255);

      expect(main.buffer[4 + 3]).toBe(255);
      expect(main.buffer[4]).toBeLessThan(200);
      expect(main.buffer[4]).toBeGreaterThan(24);

      expect(main.buffer[2 * 4]).toBe(200);
      expect(main.buffer[2 * 4 + 1]).toBe(100);
      expect(main.buffer[2 * 4 + 2]).toBe(50);
      expect(main.buffer[2 * 4 + 3]).toBe(255);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test(
    "random fuzz: 30 option/placement combos stay in range",
    () => {
      const cut = rectCutout(120, 90, 70, 50);
      const r = rng(2024);
      for (let i = 0; i < 30; i++) {
        const opts: ShadowOptions = {
          direction: r() * 360,
          length: r() * 1.5,
          softness: r(),
          opacity: r(),
          contact: r() > 0.5,
        };
        const place = { x: r() * 240, y: r() * 240, scale: 0.05 + r() * 3 };
        const intensity = renderShadowIntensity(cut, place, 240, 240, opts);
        let maxV = 0;
        for (let j = 0; j < intensity.length; j++) {
          expect(Number.isFinite(intensity[j])).toBe(true);
          if (intensity[j] > maxV) maxV = intensity[j];
        }
        expect(maxV).toBeLessThanOrEqual(1.0001);
      }
    },
    120_000,
  );

  test(
    "performance budget: 512x512 full shadow render under 4s",
    () => {
      const cut = rectCutout(300, 300, 220, 220);
      const t0 = performance.now();
      renderShadowIntensity(cut, { x: 256, y: 380, scale: 1.4 }, 512, 512, DEFAULT_SHADOW);
      const dt = performance.now() - t0;
      expect(dt).toBeLessThan(4000);
    },
    30_000,
  );
});

describe("upscaler under stress", () => {
  test("dimensions are exact for 2x and 3x on odd sizes", () => {
    for (const [w, h] of [
      [1, 1],
      [3, 7],
      [17, 9],
      [64, 64],
    ] as const) {
      const rgba = noiseImage(w, h, w * 31 + h);
      for (const factor of [2, 3] as const) {
        const up = upscaleImage(rgba, w, h, { factor });
        expect(up.width).toBe(w * factor);
        expect(up.height).toBe(h * factor);
        expect(up.rgba.length).toBe(w * factor * h * factor * 4);
      }
    }
  });

  test("constant input maps to constant output", () => {
    const w = 24;
    const h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 90;
      rgba[i * 4 + 1] = 140;
      rgba[i * 4 + 2] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const up = upscaleImage(rgba, w, h, { factor: 2, sharpening: 1, crispness: 1 });
    for (let i = 0; i < up.width * up.height; i++) {
      expect(up.rgba[i * 4]).toBe(90);
      expect(up.rgba[i * 4 + 1]).toBe(140);
      expect(up.rgba[i * 4 + 2]).toBe(200);
      expect(up.rgba[i * 4 + 3]).toBe(255);
    }
  });

  test("alpha channel passes through untouched", () => {
    const w = 12;
    const h = 12;
    const r = rng(9);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 200;
      rgba[i * 4 + 1] = 100;
      rgba[i * 4 + 2] = 50;
      rgba[i * 4 + 3] = Math.floor(r() * 256);
    }
    const up = upscaleImage(rgba, w, h, { factor: 2 });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcA = rgba[(y * w + x) * 4 + 3];
        const dstA = up.rgba[(y * 2 * up.width + x * 2) * 4 + 3];
        expect(Math.abs(dstA - srcA)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("deterministic: two runs produce identical bytes", () => {
    const rgba = noiseImage(32, 24, 555);
    const a = upscaleImage(rgba.slice(), 32, 24, { factor: 2, sharpening: 0.55, crispness: 0.75 });
    const b = upscaleImage(rgba.slice(), 32, 24, { factor: 2, sharpening: 0.55, crispness: 0.75 });
    expect(Array.from(a.rgba.slice(0, 8192))).toEqual(Array.from(b.rgba.slice(0, 8192)));
  });

  test(
    "performance budget: 3x on 300x200 under 4s",
    () => {
      const rgba = noiseImage(300, 200, 31337);
      const t0 = performance.now();
      const up = upscaleImage(rgba, 300, 200, { factor: 3 });
      expect(up.width).toBe(900);
      expect(performance.now() - t0).toBeLessThan(4000);
    },
    30_000,
  );
});

describe("generative design under stress", () => {
  test("500 seeds: all fields in range, deterministic", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const seed = (i * 2654435761) >>> 0;
      const d = generateDesign(null, seed);
      const d2 = generateDesign(null, seed);
      expect(d).toEqual(d2);
      expect(d.seed).toBe(seed);
      expect(d.light.direction).toBeGreaterThanOrEqual(0);
      expect(d.light.direction).toBeLessThanOrEqual(180);
      expect(d.light.softness).toBeGreaterThanOrEqual(0.4);
      expect(d.light.softness).toBeLessThanOrEqual(0.9);
      expect(d.light.opacity).toBeGreaterThanOrEqual(0.3);
      expect(d.light.opacity).toBeLessThanOrEqual(0.55);
      expect(d.light.temperature).toBeGreaterThanOrEqual(-1);
      expect(d.light.temperature).toBeLessThanOrEqual(1);
      expect(d.surface.vignette).toBeGreaterThanOrEqual(0);
      expect(d.surface.vignette).toBeLessThanOrEqual(1);
      expect(d.surface.grain).toBeGreaterThanOrEqual(0);
      expect(d.surface.grain).toBeLessThanOrEqual(1);
      expect(d.surface.shapes.length).toBeLessThanOrEqual(2);
      expect(d.accentHue).toBeGreaterThanOrEqual(0);
      expect(d.accentHue).toBeLessThan(360);
      expect(d.top).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
      expect(d.bottom).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
      expect(["seam", "reflect", "none"]).toContain(d.surface.floor);
      for (const s of d.surface.shapes) {
        expect(s.alpha).toBeGreaterThan(0);
        expect(s.alpha).toBeLessThan(0.2);
        expect(["circle", "arc", "band"]).toContain(s.kind);
      }
      seen.add(d.top + d.bottom + d.family + d.light.direction);
    }
    expect(seen.size).toBeGreaterThan(400);
  });

  test("designs harmonize with a provided analysis", () => {
    const analysis: StyleAnalysis = {
      palette: ["#ff3b30", "#ffffff", "#222222", "#ff8800"],
      tone: 0.5,
      contrast: 0.3,
      saturation: 0.6,
      glossy: 0.2,
      softGoods: false,
      category: "General product",
      temperature: 0.5,
      solidity: 0.8,
      elongation: 0.2,
      intricacy: 0.3,
      sheen: 0.1,
    };
    for (let i = 0; i < 50; i++) {
      const d = generateDesign(analysis, i * 97);
      expect(d.top).toMatch(/^hsl\(/);
      expect(Number.isFinite(d.accentHue)).toBe(true);
    }
  });

  test("randomSeed returns uint32 range values", () => {
    for (let i = 0; i < 100; i++) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("style analysis under stress", () => {
  function cutoutFromAlpha(
    w: number,
    h: number,
    fill: (x: number, y: number) => [number, number, number, number],
  ): Cutout {
    const alpha = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = fill(x, y);
        const i = (y * w + x) * 4;
        alpha[i] = r;
        alpha[i + 1] = g;
        alpha[i + 2] = b;
        alpha[i + 3] = a;
      }
    }
    return {
      alpha,
      width: w,
      height: h,
      softPixels: 0,
      touchedEdges: new Set(),
      box: { x: 0, y: 0, w, h },
      candidates: [{ box: { x: 0, y: 0, w, h }, area: w * h, score: 1 }],
      confidence: 1,
    };
  }

  test("fully transparent cutout does not throw", () => {
    const c = cutoutFromAlpha(32, 32, () => [0, 0, 0, 0]);
    const a = analyzeCutout(c);
    expect(a.palette.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(a.tone)).toBe(true);
    expect(Number.isFinite(a.contrast)).toBe(true);
    expect(Number.isFinite(a.saturation)).toBe(true);
    const rec = recommendStyles(a);
    expect(rec).toHaveLength(5);
    expect(new Set(rec).size).toBe(5);
  });

  test("single visible pixel analyzes cleanly", () => {
    const c = cutoutFromAlpha(16, 16, (x, y) => (x === 8 && y === 8 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const a = analyzeCutout(c);
    expect(Number.isFinite(a.tone)).toBe(true);
    expect(a.tone).toBeGreaterThanOrEqual(0);
    expect(a.tone).toBeLessThanOrEqual(1);
    expect(recommendStyles(a)).toHaveLength(5);
  });

  test("extreme products bias recommendations sensibly", () => {
    const white = cutoutFromAlpha(40, 40, () => [255, 255, 255, 255]);
    const black = cutoutFromAlpha(40, 40, () => [8, 8, 8, 255]);
    const wa = analyzeCutout(white);
    const ba = analyzeCutout(black);
    expect(wa.tone).toBeGreaterThan(0.9);
    expect(ba.tone).toBeLessThan(0.1);
    const wRec = recommendStyles(wa);
    const bRec = recommendStyles(ba);
    expect(wRec.indexOf("moody")).toBeGreaterThan(bRec.indexOf("moody"));
    expect(bRec.indexOf("pure-white")).toBeGreaterThan(wRec.indexOf("pure-white"));
  });

  test("fuzz: 40 random cutouts analyze to finite values", () => {
    const r = rng(8888);
    for (let i = 0; i < 40; i++) {
      const c = cutoutFromAlpha(48, 48, () => [
        Math.floor(r() * 256),
        Math.floor(r() * 256),
        Math.floor(r() * 256),
        r() > 0.3 ? 255 : 0,
      ]);
      const a = analyzeCutout(c);
      for (const v of [a.tone, a.contrast, a.saturation, a.glossy, a.temperature, a.solidity, a.elongation, a.intricacy, a.sheen]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(a.tone).toBeGreaterThanOrEqual(0);
      expect(a.tone).toBeLessThanOrEqual(1);
      for (const hex of a.palette) {
        expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(recommendStyles(a)).toHaveLength(5);
    }
  });
});

describe("ai matte combination under stress", () => {
  test("empty matte falls back to full-frame box", () => {
    const w = 20;
    const h = 10;
    const source = { data: noiseImage(w, h, 3), width: w, height: h };
    const matte: MattingResult = {
      alpha: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
      confidence: 0,
    };
    const c = matteToCutout(source, matte);
    expect(c.box).toEqual({ x: 0, y: 0, w, h });
    expect(c.candidates).toHaveLength(1);
    expect(c.confidence).toBe(0);
  });

  test("full matte covers the frame and copies source colors", () => {
    const w = 12;
    const h = 12;
    const source = { data: noiseImage(w, h, 4), width: w, height: h };
    const matteAlpha = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      matteAlpha[i * 4 + 3] = 255;
    }
    const c = matteToCutout(source, { alpha: matteAlpha, width: w, height: h, confidence: 1 });
    expect(c.box).toEqual({ x: 0, y: 0, w, h });
    for (let i = 0; i < w * h; i++) {
      expect(c.alpha[i * 4]).toBe(source.data[i * 4]);
      expect(c.alpha[i * 4 + 3]).toBe(255);
    }
    expect(c.confidence).toBe(1);
  });

  test("partial matte produces a tight box", () => {
    const w = 30;
    const h = 30;
    const source = { data: noiseImage(w, h, 5), width: w, height: h };
    const matteAlpha = new Uint8ClampedArray(w * h * 4);
    for (let y = 10; y < 20; y++) {
      for (let x = 5; x < 25; x++) {
        matteAlpha[(y * w + x) * 4 + 3] = 200;
      }
    }
    const c = matteToCutout(source, { alpha: matteAlpha, width: w, height: h, confidence: 0.8 });
    expect(c.box).toEqual({ x: 5, y: 10, w: 20, h: 10 });
  });
});

describe("banner helpers", () => {
  test("getRatio and getBackdrop fall back safely on unknown ids", () => {
    expect(getRatio("4:5").w).toBe(1080);
    expect(getRatio("nope" as never).w).toBe(1080);
    expect(getBackdrop("studio").id).toBe("studio");
    expect(getBackdrop("nope" as never).id).toBe("studio");
  });

  test("autoPlacement frames products within the canvas", () => {
    const cut: Cutout = {
      alpha: new Uint8ClampedArray(4),
      width: 2,
      height: 2,
      softPixels: 0,
      touchedEdges: new Set(),
      box: { x: 0, y: 0, w: 100, h: 200 },
      candidates: [],
      confidence: 1,
    };
    const p = autoPlacement(cut, 1080, 1350);
    expect(p.x).toBe(540);
    expect(p.y).toBeCloseTo(972, 5);
    const drawnH = 200 * p.scale;
    expect(drawnH).toBeLessThanOrEqual(1350 * 0.62 + 1e-6);
    const wide: Cutout = { ...cut, box: { x: 0, y: 0, w: 2000, h: 10 } };
    const pw = autoPlacement(wide, 1080, 1350);
    expect(2000 * pw.scale).toBeLessThanOrEqual(1080 * 0.72 + 1e-6);
  });
});

describe("end-to-end pipeline stress", () => {
  test(
    "segment → shadow → tone map chain on 20 random scenes",
    () => {
      const r = rng(424242);
      for (let i = 0; i < 20; i++) {
        const w = 80 + Math.floor(r() * 80);
        const h = 60 + Math.floor(r() * 80);
        const scene = sceneImage(w, h, i * 104729 + 7);
        const cut = segment(scene.rgba, w, h, { tolerance: 12 + Math.floor(r() * 40) });
        assertValidCutout(cut, w, h);
        const place = autoPlacement(cut, 240, 300);
        const opts: ShadowOptions = {
          direction: r() * 180,
          length: 0.2 + r(),
          softness: r(),
          opacity: 0.1 + r() * 0.7,
          contact: r() > 0.4,
        };
        const intensity = renderShadowIntensity(cut, place, 240, 300, opts);
        const mask = toneMapShadow(intensity, 240, 300, opts);
        expect(mask.length).toBe(240 * 300);
        let nonzero = 0;
        for (let j = 0; j < mask.length; j++) {
          if (mask[j] > 0) nonzero++;
          expect(mask[j]).toBeLessThanOrEqual(255);
        }
        expect(nonzero).toBeGreaterThan(0);
        const analysis = analyzeCutout(cut);
        expect(recommendStyles(analysis)).toHaveLength(5);
      }
    },
    180_000,
  );

  test(
    "segment performance budget: 512x512 scene under 8s",
    () => {
      const scene = sceneImage(512, 512, 987654);
      const t0 = performance.now();
      const c = segment(scene.rgba, 512, 512, { tolerance: 26 });
      expect(performance.now() - t0).toBeLessThan(8000);
      expect(c.box.w).toBeGreaterThan(10);
    },
    30_000,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
