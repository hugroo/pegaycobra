import { describe, expect, it } from "vitest";
import {
  applyCrater,
  craterDepthAt,
  createFlatHeightmap,
  DEFAULT_TERRAIN,
  generateHeightmap,
  heightAt,
  MIN_LAND_HEIGHT,
  scaleHeightmap,
} from "../src";

const allFinite = (h: Float32Array) => h.every((v) => Number.isFinite(v));

describe("heightmap generado", () => {
  it("tiene el ancho pedido, es Float32Array, finito y con bordes en 0", () => {
    const h = generateHeightmap(42);
    expect(h).toBeInstanceOf(Float32Array);
    expect(h.length).toBe(DEFAULT_TERRAIN.width);
    expect(allFinite(h)).toBe(true);
    expect(h[0]).toBe(0);
    expect(h[1]).toBe(0);
    expect(h[h.length - 1]).toBe(0);
    expect(Math.max(...h)).toBeLessThanOrEqual(DEFAULT_TERRAIN.heightMax);
    expect(Math.max(...h)).toBeGreaterThan(0);
  });

  it("semillas distintas dan terrenos distintos", () => {
    expect(generateHeightmap(1)).not.toEqual(generateHeightmap(2));
  });

  it("scale de un mapa todo cero no produce NaN", () => {
    const h = scaleHeightmap(new Float32Array(10), 60);
    expect(allFinite(h)).toBe(true);
  });
});

describe("3. un cráter baja las alturas y no deja NaN", () => {
  const before = generateHeightmap(7);
  // Impacto sobre la cima más alta, para que seguro haya tierra que sacar.
  const peak = before.indexOf(Math.max(...before));
  const cx = peak + 0.4;
  const cy = heightAt(before, cx);
  const radius = 6;
  const after = applyCrater(before, cx, cy, radius);

  it("ninguna altura sube y la del centro baja", () => {
    for (let i = 0; i < before.length; i++) expect(after[i]!).toBeLessThanOrEqual(before[i]!);
    expect(after[peak]!).toBeLessThan(before[peak]!);
  });

  it("el centro queda a cy - profundidad (r entero = 7 → 7 wu)", () => {
    expect(craterDepthAt(radius, 0)).toBe(7);
    expect(after[peak]!).toBeCloseTo(cy - 7, 4);
  });

  it("fuera del radio no cambia nada", () => {
    for (let i = 0; i < before.length; i++) {
      if (Math.abs(i - peak) >= 7) expect(after[i]).toBe(before[i]);
    }
  });

  it("no deja NaN ni Infinity", () => {
    expect(allFinite(after)).toBe(true);
  });

  it("no muta el heightmap de entrada", () => {
    expect(generateHeightmap(7)).toEqual(before);
  });

  it("no cava por debajo de MIN_LAND_HEIGHT", () => {
    const low = applyCrater(createFlatHeightmap(64, 1), 32, 1, 10);
    expect(Math.min(...low)).toBeGreaterThanOrEqual(MIN_LAND_HEIGHT);
    expect(allFinite(low)).toBe(true);
  });

  it("cráteres repetidos en el mismo punto siguen siendo finitos", () => {
    let h = before;
    for (let i = 0; i < 50; i++) h = applyCrater(h, cx, heightAt(h, cx), 18);
    expect(allFinite(h)).toBe(true);
    expect(Math.min(...h)).toBeGreaterThanOrEqual(MIN_LAND_HEIGHT);
  });

  it("rechaza coordenadas NaN en vez de propagarlas", () => {
    expect(() => applyCrater(before, Number.NaN, 10, 3)).toThrow(RangeError);
  });
});
