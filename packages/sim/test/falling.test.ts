import { describe, expect, it } from "vitest";
import {
  applyCrater,
  applyDamage,
  createFlatHeightmap,
  FALL_DAMAGE_PER_WU,
  fallDamage,
  heightAt,
  settleTank,
  TANK_MAX_LIFE,
  type Tank,
} from "../src";

describe("4. un tanque sobre un cráter cae y recibe daño de caída", () => {
  // Suelo plano a 30 wu; Baby Missile (r = 3.5 → r entero 4) explota justo debajo del tanque.
  const ground = createFlatHeightmap(128, 30);
  const tank: Tank = { id: "B", x: 64, y: 30, life: TANK_MAX_LIFE };
  const cratered = applyCrater(ground, 64, 30, 3.5);

  it("el cráter deja al tanque sin piso", () => {
    expect(heightAt(cratered, tank.x)).toBeCloseTo(26, 5); // 30 - sin(π/2)·4
    expect(heightAt(cratered, tank.x)).toBeLessThan(tank.y);
  });

  it("el tanque cae hasta el fondo y el daño es distancia · 20", () => {
    const r = settleTank(cratered, tank);
    expect(r.fall).toBeDefined();
    expect(r.tank.y).toBeCloseTo(26, 5);
    expect(r.fall!.distance).toBeCloseTo(4, 5);
    expect(r.fall!.damage).toBeCloseTo(4 * FALL_DAMAGE_PER_WU, 4); // 80 hp
  });

  it("aplicar ese daño le saca vida", () => {
    const r = settleTank(cratered, tank);
    const hurt = applyDamage(r.tank, r.fall!.damage);
    expect(hurt.tank.life).toBeCloseTo(TANK_MAX_LIFE - 80, 4);
    expect(hurt.killed).toBe(false);
  });

  it("el suelo bajo el tanque queda aplanado a su nueva altura", () => {
    const r = settleTank(cratered, tank);
    for (let x = 62; x <= 66; x++) expect(r.heights[x]).toBe(r.tank.y);
    // Volver a asentar no lo mueve: ya tiene piso.
    expect(settleTank(r.heights, r.tank).fall).toBeUndefined();
  });

  it("un tanque con piso no cae", () => {
    expect(settleTank(ground, tank).fall).toBeUndefined();
  });

  it("caídas menores a 0.5 wu no dañan (MinFallingDistance)", () => {
    expect(fallDamage(0.49)).toBe(0);
    expect(fallDamage(0.5)).toBe(10);
  });

  it("una caída larga mata", () => {
    const pit = applyCrater(createFlatHeightmap(256, 60), 128, 60, 18); // 19 wu de hondo
    const r = settleTank(pit, { id: "C", x: 128, y: 60, life: TANK_MAX_LIFE });
    const hurt = applyDamage(r.tank, r.fall!.damage);
    expect(hurt.killed).toBe(true);
    expect(hurt.tank.life).toBe(0);
    expect(hurt.dealt).toBe(TANK_MAX_LIFE); // recortado a la vida que tenía
  });
});
