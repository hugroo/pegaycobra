import { describe, expect, it } from "vitest";
import {
  buyItem,
  createFlatTerrain,
  isPlayable,
  MONEY_START,
  resolveTurn,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  startingInventory,
  TANK_MAX_LIFE,
  tanks3DAt,
  terrainHeightAt,
  WEAPONS,
  type MatchState3D,
  type Player,
  type Terrain,
} from "../src";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });
const withItems = (id: string, items: Player["inventory"]): Player => ({ ...fresh(id), inventory: { ...startingInventory(), ...items } });
const lifeOf = (s: MatchState3D, id: string) => s.tanks.find((t) => t.id === id)!.life;
const invOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.inventory;

const KEEP = WEAPONS.leapfrog.bounce!.keep;
const SLOPE_TOP = 100;
const FAR = { x: 30, z: 30 };

/** La ladera de roller-shield.test.ts: meseta a 60 hasta x = 100 y de ahí baja 0.4 por celda hacia +X. */
function hillside(): Terrain {
  const t = createFlatTerrain(257, 257, 0);
  for (let z = 0; z < 257; z++) for (let x = 0; x < 257; x++) t.heights[x + z * 257] = Math.max(5, 60 - 0.4 * Math.max(0, x - SLOPE_TOP));
  return t;
}
/** Lo mismo al revés: piso a 10 hasta x = 150 y de ahí sube 0.4 por celda hacia +X. */
function uphill(): Terrain {
  const t = createFlatTerrain(257, 257, 0);
  for (let z = 0; z < 257; z++) for (let x = 0; x < 257; x++) t.heights[x + z * 257] = 10 + 0.4 * Math.max(0, x - 150);
  return t;
}

/** A tira hacia +X con dos Rebotes y tres Misiles; B donde diga el test (por defecto lejos, fuera del camino). */
function match(terrain: Terrain, a: { x: number; z: number }, b = FAR, players: Player[] = [withItems("A", { leapfrog: 2, missile: 3 }), fresh("B")]): MatchState3D {
  return { terrain, wind: { x: 0, z: 0 }, tanks: tanks3DAt(terrain, ["A", "B"], [a, b], TANK_MAX_LIFE), players };
}
const onHill = (b = FAR, players?: Player[]) => match(hillside(), { x: 90, z: 128 }, b, players);
const onFlat = (b = FAR, players?: Player[]) => match(createFlatTerrain(257, 257, 10), { x: 60, z: 128 }, b, players);

const AIM = { playerId: "A", yaw: 0, pitch: 45, power: 300 } as const;
const BOUNCE = { ...AIM, weaponId: "leapfrog" } as const;
const MISSILE = { ...AIM, weaponId: "missile" } as const;

const pointAt = (path: number[], tick: number) => path.slice(tick * 3, tick * 3 + 3);
const heightAt = (t: Terrain, at: { x: number; z: number }) => terrainHeightAt(t, Math.round(at.x), Math.round(at.z));

describe("Rebote", () => {
  it("en una ladera el primer choque es piso y no explota: pica, y el segundo golpe es más adelante", () => {
    const m = onHill();
    const { shot, state, damage } = resolveTurn(m, BOUNCE, { recordPath: true });
    const first = shot.bounce!;
    expect(first).toBeDefined();
    // Primer choque: el piso de la ladera.
    expect(first.x).toBeGreaterThan(SLOPE_TOP);
    expect(first.y).toBe(terrainHeightAt(m.terrain, first.x, first.z));
    // Segundo: también piso, bastante más adelante y, como la ladera baja, más abajo.
    expect(shot.outcome).toBe("ground");
    expect(shot.x).toBeGreaterThan(first.x + 10);
    expect(shot.y).toBeLessThan(first.y - 4);
    expect(shot.z).toBeCloseTo(128, 6);
    expect(shot.ticks).toBeGreaterThan(first.tick + 50);

    // El hoyo queda en el segundo golpe. Donde picó, el piso está como estaba.
    expect(heightAt(state.terrain, shot)).toBeLessThan(heightAt(m.terrain, shot) - 3);
    expect(Math.abs(shot.x - first.x)).toBeGreaterThan(WEAPONS.leapfrog.craterRadius + 2);
    expect(heightAt(state.terrain, first)).toBe(heightAt(m.terrain, first));
    expect(damage).toEqual([]);
    expect(invOf(state, "A").leapfrog).toBe(1);
  });

  it("sale como un Misil: hasta el pique es el mismo recorrido, y donde el Misil explota este sigue", () => {
    const m = onHill();
    const shot = resolveTurn(m, BOUNCE, { recordPath: true }).shot;
    const missile = resolveTurn(m, MISSILE, { recordPath: true }).shot;
    const first = shot.bounce!;
    expect(first.tick).toBe(missile.ticks);
    expect([first.x, first.z]).toEqual([missile.x, missile.z]);
    expect(shot.path!.slice(0, first.tick * 3)).toEqual(missile.path!.slice(0, first.tick * 3));
    // El punto del pique va apoyado en el piso (el Misil termina un poco por debajo).
    expect(pointAt(shot.path!, first.tick)).toEqual([first.x, first.y, first.z]);
    expect(first.y).toBeGreaterThanOrEqual(missile.y);
    // Un punto por tick, los dos tramos seguidos, hasta donde terminó.
    expect(shot.path!.length / 3 - 1).toBe(shot.ticks);
    expect(shot.path!.slice(-3)).toEqual([shot.x, shot.y, shot.z]);
  });

  it("sigue con menos fuerza: sale del pique para arriba, con el mismo rumbo y la mitad de la velocidad", () => {
    const shot = resolveTurn(onFlat(), BOUNCE, { recordPath: true }).shot;
    const first = shot.bounce!;
    const path = shot.path!;
    const [x0] = pointAt(path, first.tick - 1);
    const [x1, y1] = pointAt(path, first.tick);
    const [x2, y2] = pointAt(path, first.tick + 1);
    expect(KEEP).toBe(0.5);
    expect(y2!).toBeGreaterThan(y1!);
    expect(x2! - x1!).toBeCloseTo((x1! - x0!) * KEEP, 9);
    // En piso llano el segundo tramo es mucho más corto que el primero, y más bajo.
    const leg1 = first.x - 60;
    const leg2 = shot.x - first.x;
    expect(leg2).toBeGreaterThan(5);
    expect(leg2).toBeLessThan(leg1 / 2);
    const top = (from: number, to: number) => Math.max(...path.filter((_, i) => i % 3 === 1).slice(from, to + 1));
    expect(top(first.tick, shot.ticks) - 10).toBeLessThan((top(0, first.tick) - 10) / 2);
  });

  it("pica una sola vez: el segundo golpe explota, y no rueda ni se abre", () => {
    const m = onHill();
    const { shot, state } = resolveTurn(m, BOUNCE, { recordPath: true });
    expect(shot.landed).toBeUndefined();
    expect(shot.split).toBeUndefined();
    // Terminó donde volvió a tocar el piso, en plena ladera: de ahí no siguió, ni volando ni rodando.
    expect(shot.y).toBeLessThanOrEqual(terrainHeightAt(m.terrain, shot.x, shot.z));
    expect(terrainHeightAt(m.terrain, shot.x + 1, shot.z)).toBeLessThan(terrainHeightAt(m.terrain, shot.x, shot.z));
    // Un solo hoyo, del tamaño del de un Misil.
    const lowered = (after: Terrain) => after.heights.reduce((n, h, i) => n + (h < m.terrain.heights[i]! ? 1 : 0), 0);
    const missile = lowered(resolveTurn(m, MISSILE).state.terrain);
    expect(Math.abs(lowered(state.terrain) - missile)).toBeLessThan(missile * 0.2);
  });

  it("con un tanque en el primer punto no hay segundo tramo: explota ahí", () => {
    const free = resolveTurn(onHill(), BOUNCE).shot;
    const first = free.bounce!;
    const m = onHill({ x: first.x, z: first.z });
    const { shot, state, damage } = resolveTurn(m, BOUNCE, { recordPath: true });
    expect(shot.outcome).toBe("tank");
    expect(shot.tankId).toBe("B");
    expect(shot.bounce).toBeUndefined();
    // Termina contra el tanque, antes de llegar al piso, y es exactamente lo que hace un Misil.
    expect(shot.ticks).toBeLessThan(first.tick);
    expect(Math.hypot(shot.x - first.x, shot.z - first.z)).toBeLessThan(2);
    const missile = resolveTurn(m, MISSILE, { recordPath: true });
    expect(shot).toEqual(missile.shot);
    expect(damage.map((d) => [d.targetId, d.cause, d.damage])).toEqual(missile.damage.map((d) => [d.targetId, d.cause, d.damage]));
    expect(lifeOf(state, "B")).toBe(0);
    // El hoyo está ahí, no donde habría caído el segundo golpe.
    expect(heightAt(state.terrain, first)).toBeLessThan(heightAt(m.terrain, first));
    expect(heightAt(state.terrain, free)).toBe(heightAt(m.terrain, free));
  });

  it("un tanque en el segundo tramo lo frena: explota contra él", () => {
    const free = resolveTurn(onFlat(), BOUNCE).shot;
    const { shot, state } = resolveTurn(onFlat({ x: free.x, z: free.z }), BOUNCE);
    expect(shot.bounce).toEqual(free.bounce);
    expect(shot.outcome).toBe("tank");
    expect(shot.tankId).toBe("B");
    expect(lifeOf(state, "B")).toBe(0);
  });

  it("cuesta arriba también sigue para adelante: no vuelve hacia el que tiró", () => {
    const m = match(uphill(), { x: 120, z: 128 });
    const { shot } = resolveTurn(m, { ...BOUNCE, power: 500 });
    const first = shot.bounce!;
    expect(first.x).toBeGreaterThan(150); // picó en la subida
    expect(shot.outcome).toBe("ground");
    expect(shot.x).toBeGreaterThan(first.x + 3);
    expect(shot.y).toBeGreaterThan(first.y);
  });

  it("si el segundo tramo se va del mapa no explota nada: el terreno queda igual", () => {
    const m = match(createFlatTerrain(257, 257, 10), { x: 185, z: 128 });
    const { shot, state, damage } = resolveTurn(m, { ...BOUNCE, power: 500 });
    expect(shot.bounce!.x).toBeLessThan(256); // picó adentro, cerca del borde
    expect(shot.outcome).toBe("offmap");
    expect(state.terrain).toBe(m.terrain);
    expect(damage).toEqual([]);
    expect(invOf(state, "A").leapfrog).toBe(1);
  });

  it("la fantasma hace la misma cuenta que el server: mismo pique, mismo camino, mismo final", () => {
    const m = onHill();
    const a = m.tanks[0]!;
    const ghost = simulateWeaponShot3D(
      m.terrain,
      WEAPONS.leapfrog,
      { originX: a.x, originY: a.y, originZ: a.z, yaw: BOUNCE.yaw, pitch: BOUNCE.pitch, power: BOUNCE.power, wind: m.wind, shooterId: "A" },
      m.tanks,
      { recordPath: true },
    );
    expect(ghost).toEqual(resolveTurn(m, BOUNCE, { recordPath: true }).shot);
    expect(ghost.bounce).toBeDefined();
  });

  it("el viento empuja los dos tramos", () => {
    const calm = resolveTurn(onFlat(), BOUNCE).shot;
    const windy = resolveTurn({ ...onFlat(), wind: { x: 0, z: 4 } }, BOUNCE).shot;
    const drift1 = windy.bounce!.z - calm.bounce!.z;
    expect(drift1).toBeGreaterThan(0);
    expect(windy.z - calm.z).toBeGreaterThan(drift1);
  });

  it("el segundo golpe es una explosión como cualquiera: el escudo la absorbe y se gasta", () => {
    const free = resolveTurn(onFlat(), BOUNCE).shot;
    const near = { x: free.x + 3, z: free.z };
    const hit = resolveTurn(onFlat(near), BOUNCE);
    expect(hit.shot.outcome).toBe("ground");
    expect(lifeOf(hit.state, "B")).toBeLessThan(TANK_MAX_LIFE);
    const shielded = resolveTurn(onFlat(near, [withItems("A", { leapfrog: 2 }), withItems("B", { shield: 1 })]), BOUNCE);
    expect(shielded.blocked).toEqual(["B"]);
    expect(lifeOf(shielded.state, "B")).toBe(TANK_MAX_LIFE);
    expect(invOf(shielded.state, "B").shield).toBe(0);
  });

  it("sin munición no se tira", () => {
    expect(() => resolveTurn(onFlat(FAR, [fresh("A"), fresh("B")]), BOUNCE)).toThrow(/sin munición/);
  });
});

describe("tienda con Rebote", () => {
  it("se llama Rebote, viene de a 2 y se puede disparar", () => {
    expect(SHOP_ITEMS.leapfrog.name).toBe("Rebote");
    expect(SHOP_ITEMS.leapfrog.pack).toBe(2);
    expect(isPlayable("leapfrog")).toBe(true);
    const bought = buyItem(fresh("A"), "leapfrog");
    expect(bought.inventory.leapfrog).toBe(2);
    expect(bought.money).toBe(MONEY_START - SHOP_ITEMS.leapfrog.price);
    expect(startingInventory().leapfrog).toBeUndefined();
  });
});
