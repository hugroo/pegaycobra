import { describe, expect, it } from "vitest";
import {
  applyCraterTerrain,
  createFlatTerrain,
  DIG_GAP,
  DIG_PRICE,
  DIG_RADIUS,
  digHole,
  generateTerrain,
  isDug,
  isWater,
  MAPS,
  onShore,
  SHOP_ITEMS,
  SHORE_LEVEL,
  TANK_SIZE,
  terrainHeightAt,
  validateDig,
  validateSpawn,
  WATER_LEVEL,
  WEAPONS,
} from "../src";

const GROUND = 20;
/** Lo que baja el centro del hoyo: el radio entero del original, trunc(radius) + 1. */
const DEPTH = Math.trunc(DIG_RADIUS) + 1;

describe("hoyo cavado en la tienda", () => {
  const island = () => generateTerrain(34, MAPS.island.terrain);
  const TANKS = [{ x: 128, z: 128 }];
  const STAKES = [{ x: 200, z: 128 }];

  it("es el cráter de un Missile ahí, sin tirar nada: mismo disco, con la boca en el piso, y la entrada no se toca", () => {
    const t = createFlatTerrain(257, 257, GROUND);
    const at = { x: 60.4, z: 70.8 };
    expect(DIG_RADIUS).toBe(WEAPONS.missile.craterRadius);
    expect(validateDig(t, TANKS, STAKES, at)).toEqual({ ok: true, x: at.x, y: GROUND, z: at.z });
    const down = digHole(t, TANKS, STAKES, at);
    expect(down.heights).toEqual(applyCraterTerrain(t, at.x, GROUND, at.z, DIG_RADIUS).heights);
    expect(terrainHeightAt(down, 60, 70)).toBeCloseTo(GROUND - DEPTH, 4);
    expect(down.heights.every((h, i) => h <= t.heights[i]!)).toBe(true);
    expect(down.heights.filter((h) => h < GROUND).length).toBeGreaterThan(100);
    expect(t.heights.every((h) => h === GROUND)).toBe(true);
    // Lo cavado es hoyo para el que elige dónde nacer: ahí no nace nadie.
    expect(isDug(down, t, at.x, at.z)).toBe(true);
    expect(validateSpawn(down, t, at, [])).toEqual({ ok: false, reason: "ahí hay un hoyo" });
  });

  it("cuesta plata y nada más: no es una carta de la tienda, y no cambia el precio de la Tierra", () => {
    expect(DIG_PRICE).toBe(800);
    expect(Object.keys(SHOP_ITEMS)).not.toContain("dig");
    expect(SHOP_ITEMS.dirt.price).toBe(1150);
  });

  it("si el corte llega a la altura del agua, queda agua: en la orilla sí, un poco más arriba no", () => {
    const at = { x: 90, z: 90 };
    const shore = createFlatTerrain(257, 257, SHORE_LEVEL);
    expect(onShore(shore, at.x, at.z)).toBe(true);
    const lake = digHole(shore, [], [], at);
    expect(terrainHeightAt(lake, at.x, at.z)).toBeLessThanOrEqual(WATER_LEVEL);
    expect(isWater(lake, at.x, at.z)).toBe(true);
    // El borde del hoyo baja menos: sigue siendo piso firme.
    expect(isWater(lake, at.x + DEPTH - 1, at.z)).toBe(false);

    const higher = createFlatTerrain(257, 257, SHORE_LEVEL + 0.5);
    expect(onShore(higher, at.x, at.z)).toBe(false);
    const dry = digHole(higher, [], [], at);
    expect(terrainHeightAt(dry, at.x, at.z)).toBeCloseTo(WATER_LEVEL + 0.5, 4);
    expect(isWater(dry, at.x, at.z)).toBe(false);
  });

  it("no se cava en el agua, ni en el borde, ni afuera; en un hoyo sí, y queda más hondo", () => {
    const t = island();
    const water = { x: 6, z: 128 };
    expect(terrainHeightAt(t, water.x, water.z)).toBeLessThanOrEqual(WATER_LEVEL);
    expect(validateDig(t, [], [], water)).toEqual({ ok: false, reason: "ahí hay agua" });
    expect(() => digHole(t, [], [], water)).toThrow("ahí hay agua");
    const flat = createFlatTerrain(257, 257, GROUND);
    for (const out of [{ x: 1, z: 128 }, { x: 128, z: 255 }, { x: -5, z: 128 }, { x: 128, z: 400 }]) {
      expect(validateDig(flat, [], [], out), JSON.stringify(out)).toEqual({ ok: false, reason: "fuera del mapa" });
    }
    expect(validateDig(flat, [], [], { x: Number.NaN, z: 128 }).ok).toBe(false);
    expect(validateDig(flat, [], [], { x: 2, z: 254 }).ok).toBe(true);

    const once = digHole(flat, [], [], { x: 80, z: 80 });
    const bottom = terrainHeightAt(once, 80, 80);
    expect(validateDig(once, [], [], { x: 80, z: 80 })).toMatchObject({ ok: true, y: bottom });
    expect(terrainHeightAt(digHole(once, [], [], { x: 80, z: 80 }), 80, 80)).toBeCloseTo(bottom - DEPTH, 4);
  });

  it(`no se cava sobre un tanque ni sobre una estaca: con el disco a menos de ${DIG_GAP} celdas se rechaza, y donde vale ese piso no baja`, () => {
    const t = createFlatTerrain(257, 257, GROUND);
    expect(DIG_GAP).toBe(DEPTH + TANK_SIZE);
    // Un punto que no está justo en una celda, y todos los de alrededor, también con decimales.
    const spot = { x: 128.6, z: 127.3 };
    for (const [kind, reason] of [["tank", "ahí hay un tanque"], ["stake", "ahí nace alguien"]] as const) {
      const tanks = kind === "tank" ? [spot] : [];
      const stakes = kind === "stake" ? [spot] : [];
      let ok = 0;
      let no = 0;
      let sunk = 0;
      for (let z = 112.5; z < 144; z += 0.75) {
        for (let x = 112.25; x < 144; x += 0.75) {
          const check = validateDig(t, tanks, stakes, { x, z });
          const lowered = terrainHeightAt(applyCraterTerrain(t, x, GROUND, z, DIG_RADIUS), spot.x, spot.z) < GROUND;
          // El disco se centra en la celda del punto: desde ahí se mide.
          expect(check.ok, `${kind} ${x}, ${z}`).toBe(Math.hypot(Math.trunc(x) - spot.x, Math.trunc(z) - spot.z) >= DIG_GAP);
          if (check.ok) {
            expect(lowered, `${kind} ${x}, ${z}`).toBe(false);
            expect(terrainHeightAt(digHole(t, tanks, stakes, { x, z }), spot.x, spot.z)).toBe(GROUND);
            ok++;
          } else {
            expect(check).toEqual({ ok: false, reason });
            expect(() => digHole(t, tanks, stakes, { x, z })).toThrow(reason);
            no++;
            if (lowered) sunk++;
          }
        }
      }
      expect(ok).toBeGreaterThan(500);
      // La regla no está de más: la mayor parte de lo que rechaza le habría sacado el piso.
      expect(sunk).toBeGreaterThan(no * 0.6);
    }
    // Cuenta cualquiera de los tanques y cualquiera de las estacas, no solo el primero.
    expect(validateDig(t, [...TANKS, { x: 40, z: 40 }], STAKES, { x: 45, z: 40 }).ok).toBe(false);
    expect(validateDig(t, TANKS, [...STAKES, { x: 40, z: 40 }], { x: 45, z: 40 }).ok).toBe(false);
    expect(validateDig(t, [...TANKS, { x: 40, z: 40 }], [...STAKES, { x: 40, z: 90 }], { x: 60, z: 40 }).ok).toBe(true);
  });
});
