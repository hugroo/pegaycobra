import { describe, expect, it } from "vitest";
import {
  createFlatHeightmap,
  generateHeightmap,
  heightAt,
  launchVelocity,
  POWER_TO_VELOCITY,
  simulateShot,
  type ShotParams,
} from "../src";

// Escenario de referencia: suelo plano a 10 wu, mapa de 257 muestras, tanque en x = 40.
const FLAT = createFlatHeightmap(257, 10);
const BASE: ShotParams = { originX: 40, originY: 10, angleDeg: 45, power: 600, wind: 0 };

// Valores calculados a mano con el mismo paso (v += a; p += v/100) en doble precisión.
// Sin viento el x de impacto tiene forma cerrada: 40 + cos45 + 363 ticks · 25.4983 vu / 100.
const EXPECTED_X = 133.2658; // [wu]
const EXPECTED_TICKS = 363;

describe("1. tiro con potencia y ángulo conocidos", () => {
  it("cae en un x estable (±1 celda)", () => {
    const r = simulateShot(FLAT, BASE);
    expect(r.outcome).toBe("ground");
    expect(Math.abs(r.x - EXPECTED_X)).toBeLessThanOrEqual(1);
    expect(r.ticks).toBe(EXPECTED_TICKS);
  });

  it("es determinista: mismo input, mismo resultado bit a bit", () => {
    const a = simulateShot(FLAT, BASE, [], { recordPath: true });
    const b = simulateShot(FLAT, BASE, [], { recordPath: true });
    expect(b).toEqual(a);
  });

  it("es simétrico: 135° desde x = 200 cae espejado", () => {
    const r = simulateShot(FLAT, { ...BASE, originX: 200, angleDeg: 135 });
    expect(r.outcome).toBe("ground");
    expect(Math.abs(r.x - (200 - (EXPECTED_X - 40)))).toBeLessThanOrEqual(1);
  });

  it("la velocidad inicial sigue a getVelocityVector · (power + 1)", () => {
    const v = launchVelocity(90, 1000);
    expect(v.vx).toBeCloseTo(0, 10);
    expect(v.vy).toBeCloseTo(POWER_TO_VELOCITY * 1001, 10);
  });

  it("sobre terreno generado, misma semilla da el mismo impacto", () => {
    const h1 = generateHeightmap(1234);
    const h2 = generateHeightmap(1234);
    expect(h2).toEqual(h1);
    const shot: ShotParams = { originX: 30, originY: heightAt(h1, 30), angleDeg: 60, power: 700, wind: 1.5 };
    expect(simulateShot(h2, shot)).toEqual(simulateShot(h1, shot));
  });

  it("si se va del mapa devuelve offmap", () => {
    const r = simulateShot(FLAT, { ...BASE, power: 1000, originX: 200 });
    expect(r.outcome).toBe("offmap");
  });

  it("rechaza entradas no finitas", () => {
    expect(() => simulateShot(FLAT, { ...BASE, power: Number.NaN })).toThrow(RangeError);
  });
});

describe("2. el viento empuja el impacto en la dirección correcta", () => {
  const xWith = (wind: number, extra: Partial<ShotParams> = {}) =>
    simulateShot(FLAT, { ...BASE, ...extra, wind }).x;

  it("viento a favor (+x) alarga, en contra acorta", () => {
    const calm = xWith(0);
    expect(xWith(5)).toBeGreaterThan(calm + 1);
    expect(xWith(-5)).toBeLessThan(calm - 1);
  });

  it("el corrimiento crece con la intensidad", () => {
    const xs = [-5, -2, 0, 2, 5].map((w) => xWith(w));
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });

  it("valores de referencia: ±5 de viento mueve ~18.9 wu en 363 ticks", () => {
    // Δx = ½ · (5 · 0.4 / 70) · 363² / 100 ≈ 18.8 wu (más el término discreto).
    expect(Math.abs(xWith(5) - 152.1418)).toBeLessThanOrEqual(1);
    expect(Math.abs(xWith(-5) - 114.3898)).toBeLessThanOrEqual(1);
  });

  it("en un tiro hacia -x, viento +x lo acorta", () => {
    const left = { originX: 200, angleDeg: 135 };
    expect(xWith(5, left)).toBeGreaterThan(xWith(0, left));
  });

  it("el viento no cambia el tiempo de vuelo sobre suelo plano", () => {
    expect(simulateShot(FLAT, { ...BASE, wind: 5 }).ticks).toBe(EXPECTED_TICKS);
  });
});
