import { describe, expect, it } from "vitest";
import {
  applyCraterTerrain,
  applyMoundTerrain,
  buyItem,
  craterDepthAt,
  createFlatTerrain,
  generateTerrain,
  isPlayable,
  leaveMound,
  MAPS,
  MONEY_START,
  MOUND_TANK_GAP,
  resolveTurn,
  SHOP_ITEMS,
  startingInventory,
  TANK_MAX_LIFE,
  TANK_SIZE,
  tanks3DAt,
  terrainHeightAt,
  validateMound,
  WATER_LEVEL,
  WEAPONS,
  type MatchState3D,
  type Player,
  type Terrain,
} from "../src";
import { dial } from "./aim";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });
const withItems = (id: string, items: Player["inventory"]): Player => ({ ...fresh(id), inventory: { ...startingInventory(), ...items } });
const tankOf = (s: MatchState3D, id: string) => s.tanks.find((t) => t.id === id)!;
const invOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.inventory;

const GROUND = 10;
const RADIUS = WEAPONS.dirt.mound!.radius;
/** Lo que sube el centro de la loma: el radio entero del original, trunc(radius) + 1. */
const TOP = Math.trunc(RADIUS) + 1;
/** Donde cae yaw 90 / pitch 45 desde el centro si sale con potencia 600 (el duelo de roller-shield.test.ts). */
const HIT = { x: 128, z: 128 + 93 };
const FAR = { x: 30, z: 30 };

/** Terreno plano a 10, A en el centro y B donde diga el test: en HIT (abajo de la loma) o lejos. */
function duel(b: { x: number; z: number }, players: Player[] = [withItems("A", { dirt: 1, missile: 3, roller: 2 }), fresh("B")]): MatchState3D {
  const terrain = createFlatTerrain(257, 257, GROUND);
  return { terrain, wind: { x: 0, z: 0 }, tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 128, z: 128 }, b], TANK_MAX_LIFE), players };
}
// La Tierra, el Missile y el Roller salen igual (mismo alcance): una sola puntería para los tres.
const AIM = { playerId: "A", yaw: 90, pitch: 45, power: dial("dirt", 600) } as const;
const DIRT = { ...AIM, weaponId: "dirt" } as const;
const MISSILE = { ...AIM, weaponId: "missile" } as const;
const ROLLER = { ...AIM, weaponId: "roller" } as const;

/** Celdas que quedaron más altas y más bajas que antes. */
function moved(before: Terrain, after: Terrain): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (let i = 0; i < before.heights.length; i++) {
    if (after.heights[i]! > before.heights[i]!) up++;
    else if (after.heights[i]! < before.heights[i]!) down++;
  }
  return { up, down };
}

describe("Tierra", () => {
  it("cae como un Missile y, donde cae, el terreno sube: una loma, ni una celda más baja", () => {
    const m = duel(FAR);
    const flat = m.terrain.heights.slice();
    const { shot, state, damage, falls, blocked, fire } = resolveTurn(m, DIRT);
    expect(shot).toEqual(resolveTurn(m, MISSILE).shot);
    expect(shot.outcome).toBe("ground");
    expect(isPlayable("dirt")).toBe(true);

    const { up, down } = moved(m.terrain, state.terrain);
    expect(down).toBe(0);
    expect(up).toBeGreaterThan(Math.PI * (RADIUS - 1) ** 2); // un disco, no una fila
    // La cima queda en el centro y la loma se apaga hacia el borde del disco. El tiro termina un
    // pelo bajo el piso, y la loma se mide desde ahí.
    const cx = Math.trunc(shot.x);
    const cz = Math.trunc(shot.z);
    const h = (dx: number, dz: number) => terrainHeightAt(state.terrain, cx + dx, cz + dz);
    expect(shot.y).toBeLessThanOrEqual(GROUND);
    expect(shot.y).toBeGreaterThan(GROUND - 0.5);
    expect(h(0, 0)).toBeCloseTo(shot.y + TOP, 4);
    expect(h(4, 0)).toBeCloseTo(shot.y + craterDepthAt(RADIUS, 4), 4);
    expect(h(0, -4)).toBeCloseTo(h(4, 0), 4);
    expect(h(RADIUS, 0)).toBeGreaterThan(GROUND);
    expect(h(RADIUS, 0)).toBeLessThan(h(4, 0));
    expect(h(TOP, 0)).toBe(GROUND);
    expect(h(0, TOP + 5)).toBe(GROUND);

    // No es un golpe: ni daño, ni caídas, ni fuego, ni plata. Se gastó una y la entrada no se tocó.
    expect([damage, falls, blocked, fire]).toEqual([[], [], [], null]);
    expect(state.players[0]!.money).toBe(MONEY_START);
    expect(invOf(state, "A").dirt).toBe(0);
    expect(m.terrain.heights).toEqual(flat);
  });

  it("el tanque que quedó debajo sube con la loma: queda apoyado arriba, no enterrado, con la vida que tenía", () => {
    const m = duel(HIT);
    const { shot, state, damage, falls } = resolveTurn(m, DIRT);
    expect(shot.outcome).toBe("tank"); // le cayó encima
    const b = tankOf(state, "B");
    expect(b.y).toBeGreaterThan(GROUND + TOP - 1);
    expect(b.y).toBe(terrainHeightAt(state.terrain, b.x, b.z));
    expect([b.x, b.z]).toEqual([HIT.x, HIT.z]);
    expect(b.life).toBe(TANK_MAX_LIFE);
    expect([damage, falls]).toEqual([[], []]);
    // Al que está lejos no lo mueve.
    expect(tankOf(state, "A")).toEqual(tankOf(m, "A"));
  });

  it("el escudo no la frena ni se gasta: la loma sube igual", () => {
    const m = duel(HIT, [withItems("A", { dirt: 1 }), buyItem(fresh("B"), "shield")]);
    const { state, blocked } = resolveTurn(m, DIRT);
    expect(blocked).toEqual([]);
    expect(invOf(state, "B").shield).toBe(1);
    expect(tankOf(state, "B").y).toBeGreaterThan(GROUND + TOP - 1);
    expect(tankOf(state, "B").life).toBe(TANK_MAX_LIFE);
  });

  it("un Missile después vuelve a abrir un hoyo ahí", () => {
    const mound = resolveTurn(duel(HIT), DIRT).state;
    // Con la misma puntería el Missile ya no llega al tanque: pega antes, en la ladera, y la abre.
    const { shot, state } = resolveTurn(mound, MISSILE);
    expect(shot.outcome).toBe("ground");
    expect(shot.y).toBeGreaterThan(GROUND + 2);
    const { up, down } = moved(mound.terrain, state.terrain);
    expect(up).toBe(0);
    expect(down).toBeGreaterThan(0);
    expect(terrainHeightAt(state.terrain, shot.x, shot.z)).toBeLessThan(terrainHeightAt(mound.terrain, shot.x, shot.z) - 1);

    // Al que quedó arriba se le sigue pudiendo pegar: con un poco más de potencia el Missile le da
    // de lleno, y el hoyo se abre en la cima.
    const power = Array.from({ length: 150 }, (_, k) => MISSILE.power + k).find((p) => resolveTurn(mound, { ...MISSILE, power: p }).shot.tankId === "B");
    expect(power).toBeDefined();
    const hit = resolveTurn(mound, { ...MISSILE, power: power! }).state;
    expect(tankOf(hit, "B").life).toBe(0);
    expect(terrainHeightAt(hit.terrain, HIT.x, HIT.z)).toBeLessThan(terrainHeightAt(mound.terrain, HIT.x, HIT.z) - 1);
  });

  it("un Roller que pega en la loma la baja rodando; en lo llano, el mismo tiro no rodaba", () => {
    const flat = duel(FAR);
    const onFlat = resolveTurn(flat, ROLLER).shot;
    expect(onFlat.x).toBe(onFlat.landed!.x);
    expect(onFlat.z).toBe(onFlat.landed!.z);

    const mound = resolveTurn(flat, DIRT).state;
    const { shot } = resolveTurn(mound, ROLLER);
    expect(shot.outcome).toBe("ground");
    const landed = shot.landed!;
    expect(landed.y).toBeGreaterThan(GROUND + 2); // tocó en la ladera, no en el piso de antes
    expect(shot.y).toBeLessThan(landed.y - 2);
    expect(shot.y).toBeLessThan(GROUND + 1); // llegó al pie
    expect(Math.hypot(shot.x - landed.x, shot.z - landed.z)).toBeGreaterThan(2);
  });

  it("tierra sobre tierra sigue subiendo, y el que está arriba sube otra vez", () => {
    const m = duel(HIT, [withItems("A", { dirt: 2 }), fresh("B")]);
    const one = resolveTurn(m, { ...DIRT, pitch: 90, power: 0 }).state; // sobre sí mismo
    const two = resolveTurn(one, { ...DIRT, pitch: 90, power: 0 }).state;
    expect(tankOf(one, "A").y).toBeGreaterThan(GROUND + TOP - 1);
    expect(tankOf(two, "A").y).toBeGreaterThan(tankOf(one, "A").y + TOP - 1);
    expect(tankOf(two, "A").life).toBe(TANK_MAX_LIFE);
    expect(invOf(two, "A").dirt).toBe(0);
  });

  it("si se fue del mapa no levanta nada, y sin Tierra no se puede tirar", () => {
    const m = duel(HIT);
    const gone = resolveTurn(m, { ...DIRT, power: 1000 });
    expect(gone.shot.outcome).toBe("offmap");
    expect(gone.state.terrain).toBe(m.terrain);
    expect(invOf(gone.state, "A").dirt).toBe(0);
    expect(() => resolveTurn(duel(HIT, [fresh("A"), fresh("B")]), DIRT)).toThrow();
  });
});

describe("loma 3D: sube un disco", () => {
  it("lo que ya asoma por encima de la esfera no se toca, y los bordes del mapa tampoco", () => {
    // Un paredón a 40 al lado del impacto: más alto que cy + depth en todas sus celdas.
    const t = createFlatTerrain(64, 64, GROUND);
    for (let z = 0; z < 64; z++) for (let x = 35; x < 64; x++) t.heights[x + z * 64] = 40;
    const out = applyMoundTerrain(t, 32, GROUND, 32, 6);
    const at = (x: number, z: number) => out.heights[x + z * 64]!;
    expect(at(32, 32)).toBeCloseTo(GROUND + 7, 5);
    expect(at(30, 32)).toBeCloseTo(GROUND + craterDepthAt(6, 2), 5);
    expect(at(36, 32)).toBe(40);
    expect(at(36, 30)).toBe(40);

    const edge = applyMoundTerrain(createFlatTerrain(64, 64, GROUND), 1, GROUND, 1, 6);
    for (let i = 0; i < 64; i++) {
      expect(edge.heights[i]).toBe(GROUND); // fila z = 0
      expect(edge.heights[i * 64]).toBe(GROUND); // columna x = 0
    }
    expect(edge.heights[2 + 2 * 64]).toBeGreaterThan(GROUND);
  });

  it("en una ladera se apoya sin escalón: cuesta abajo suma la loma al relieve, cuesta arriba no pasa la esfera", () => {
    // Ladera pareja que sube 1 por celda hacia +X; el tiro pega en x = 32, donde el piso está a 30.
    const CY = 30;
    const t = createFlatTerrain(64, 64, 0);
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) t.heights[x + z * 64] = CY + (x - 32);
    const out = applyMoundTerrain(t, 32, CY, 32, RADIUS);
    const before = (x: number) => t.heights[x + 32 * 64]!;
    const after = (x: number) => out.heights[x + 32 * 64]!;
    for (let x = 32 - TOP; x <= 32 + TOP; x++) {
      const depth = craterDepthAt(RADIUS, x - 32);
      expect(after(x)).toBeGreaterThanOrEqual(before(x));
      if (x <= 32) expect(after(x)).toBeCloseTo(before(x) + depth, 4);
      else expect(after(x)).toBeCloseTo(Math.max(before(x), CY + depth), 4);
      // Con la regla del original acá había un salto de 6 entre x = 38 (sube) y x = 39 (no se toca).
      expect(Math.abs(after(x + 1) - after(x))).toBeLessThan(3);
    }
    expect(after(38)).toBeGreaterThan(before(38));
    expect(after(39)).toBe(before(39));
  });

  it("radio 0 no cambia nada, no muta la entrada y rechaza coordenadas no finitas", () => {
    const t = createFlatTerrain(64, 64, GROUND);
    const same = applyMoundTerrain(t, 32, GROUND, 32, 0);
    expect(same.heights).toEqual(t.heights);
    applyMoundTerrain(t, 32, GROUND, 32, 6);
    expect(t.heights.every((v) => v === GROUND)).toBe(true);
    expect(() => applyMoundTerrain(t, Number.NaN, GROUND, 32, 6)).toThrow(RangeError);
  });
});

describe("loma dejada en la tienda", () => {
  const island = () => generateTerrain(34, MAPS.island.terrain);
  const TANKS = [{ x: 128, z: 128 }];

  it("es la loma de una Tierra que cae ahí: mismo disco, apoyada en el piso, y la entrada no se toca", () => {
    const t = createFlatTerrain(257, 257, GROUND);
    const at = { x: 60.4, z: 70.8 };
    expect(validateMound(t, TANKS, at)).toEqual({ ok: true, x: at.x, y: GROUND, z: at.z });
    const up = leaveMound(t, TANKS, at);
    expect(up.heights).toEqual(applyMoundTerrain(t, at.x, GROUND, at.z, RADIUS).heights);
    expect(terrainHeightAt(up, 60, 70)).toBeCloseTo(GROUND + TOP, 4);
    expect(up.heights.every((h, i) => h >= t.heights[i]!)).toBe(true);
    expect(t.heights.every((h) => h === GROUND)).toBe(true);
  });

  it("no va en el agua, ni en el borde, ni afuera; en un hoyo sí, y lo tapa", () => {
    const t = island();
    const water = { x: 6, z: 128 };
    expect(terrainHeightAt(t, water.x, water.z)).toBeLessThanOrEqual(WATER_LEVEL);
    expect(validateMound(t, [], water)).toEqual({ ok: false, reason: "ahí hay agua" });
    expect(() => leaveMound(t, [], water)).toThrow("ahí hay agua");
    const flat = createFlatTerrain(257, 257, GROUND);
    for (const out of [{ x: 1, z: 128 }, { x: 128, z: 255 }, { x: -5, z: 128 }, { x: 128, z: 400 }]) {
      expect(validateMound(flat, [], out), JSON.stringify(out)).toEqual({ ok: false, reason: "fuera del mapa" });
    }
    expect(validateMound(flat, [], { x: Number.NaN, z: 128 }).ok).toBe(false);
    expect(validateMound(flat, [], { x: 2, z: 254 }).ok).toBe(true);

    const holed = applyCraterTerrain(flat, 80, GROUND, 80, WEAPONS.missile.craterRadius);
    const bottom = terrainHeightAt(holed, 80, 80);
    expect(bottom).toBeLessThan(GROUND);
    expect(validateMound(holed, [], { x: 80, z: 80 })).toMatchObject({ ok: true, y: bottom });
    expect(terrainHeightAt(leaveMound(holed, [], { x: 80, z: 80 }), 80, 80)).toBeGreaterThan(GROUND);
  });

  it(`no va sobre un tanque, vivo o no: con el disco a menos de ${MOUND_TANK_GAP} celdas se rechaza, y donde vale el piso del tanque no sube`, () => {
    const t = createFlatTerrain(257, 257, GROUND);
    expect(MOUND_TANK_GAP).toBe(TOP + TANK_SIZE);
    // Un tanque que no está parado justo en una celda, y todos los puntos de alrededor, también con decimales.
    const tank = { x: 128.6, z: 127.3 };
    let ok = 0;
    let no = 0;
    let buried = 0;
    for (let z = 108.5; z < 148; z += 0.75) {
      for (let x = 108.25; x < 148; x += 0.75) {
        const check = validateMound(t, [tank], { x, z });
        const raised = terrainHeightAt(applyMoundTerrain(t, x, GROUND, z, RADIUS), tank.x, tank.z) > GROUND;
        // El disco se centra en la celda del punto: desde ahí se mide.
        expect(check.ok, `${x}, ${z}`).toBe(Math.hypot(Math.trunc(x) - tank.x, Math.trunc(z) - tank.z) >= MOUND_TANK_GAP);
        if (check.ok) {
          expect(raised, `${x}, ${z}`).toBe(false);
          expect(terrainHeightAt(leaveMound(t, [tank], { x, z }), tank.x, tank.z)).toBe(GROUND);
          ok++;
        } else {
          expect(check).toEqual({ ok: false, reason: "ahí hay un tanque" });
          expect(() => leaveMound(t, [tank], { x, z })).toThrow("ahí hay un tanque");
          no++;
          if (raised) buried++;
        }
      }
    }
    expect(ok).toBeGreaterThan(500);
    // La regla no está de más: casi todo lo que rechaza le habría subido el piso al tanque.
    expect(buried).toBeGreaterThan(no * 0.7);
    // Cuenta cualquiera de los tanques, no solo el primero.
    expect(validateMound(t, [...TANKS, { x: 40, z: 40 }], { x: 45, z: 40 }).ok).toBe(false);
    expect(validateMound(t, [...TANKS, { x: 40, z: 40 }], { x: 60, z: 40 }).ok).toBe(true);
  });
});

describe("tienda con Tierra", () => {
  it("en la carta se llama Tierra, viene de a 1 y sale lo que una Dirt Ball del original", () => {
    expect(SHOP_ITEMS.dirt.name).toBe("Tierra");
    expect(SHOP_ITEMS.dirt.pack).toBe(1);
    expect(SHOP_ITEMS.dirt.price).toBe(1150);
    const a = buyItem(fresh("A"), "dirt");
    expect(a.inventory.dirt).toBe(1);
    expect(a.money).toBe(MONEY_START - SHOP_ITEMS.dirt.price);
    expect(buyItem(a, "dirt").inventory.dirt).toBe(2);
  });
});
