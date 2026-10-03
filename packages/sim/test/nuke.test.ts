import { describe, expect, it } from "vitest";
import {
  buyItem,
  createFlatTerrain,
  isPlayable,
  MONEY_START,
  resolveTurn,
  SHOP_ITEMS,
  startingInventory,
  TANK_MAX_LIFE,
  tanks3DAt,
  terrainHeightAt,
  WEAPONS,
  type MatchState3D,
  type Player,
} from "../src";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });
const withItems = (id: string, items: Player["inventory"]): Player => ({ ...fresh(id), inventory: { ...startingInventory(), ...items } });
const lifeOf = (s: MatchState3D, id: string) => s.tanks.find((t) => t.id === id)!.life;
const invOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.inventory;

const GROUND = 10;
const B = { x: 128, z: 128 + 93 };

/** Terreno plano a 10, A en el centro y B donde cae yaw 90 / pitch 45 / power 600 (el duelo de roller-shield.test.ts). */
function duel(b: Player = fresh("B"), a: Player = withItems("A", { nuke: 1, missile: 3 })): MatchState3D {
  const terrain = createFlatTerrain(257, 257, GROUND);
  return {
    terrain,
    wind: { x: 0, z: 0 },
    tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 128, z: 128 }, B], TANK_MAX_LIFE),
    players: [a, b],
  };
}
const AIM = { playerId: "A", yaw: 90, pitch: 45, power: 600 } as const;
const NUKE = { ...AIM, weaponId: "nuke" } as const;
const MISSILE = { ...AIM, weaponId: "missile" } as const;

/** Celdas que el tiro bajó. */
function lowered(before: MatchState3D, after: MatchState3D): number {
  let n = 0;
  for (let i = 0; i < before.terrain.heights.length; i++) if (after.terrain.heights[i]! < before.terrain.heights[i]!) n++;
  return n;
}

describe("Nuke", () => {
  it("con escudo, el Nuke baja la vida y deja el cráter; el escudo no se gasta", () => {
    const m = duel(buyItem(fresh("B"), "shield"));
    const { shot, state, blocked, damage } = resolveTurn(m, NUKE);
    expect(shot.outcome).toBe("tank");
    expect(blocked).toEqual([]); // el cartel dice el daño, no "bloqueado"
    expect(lifeOf(state, "B")).toBeLessThan(TANK_MAX_LIFE);
    expect(damage.some((d) => d.targetId === "B" && d.cause === "explosion" && d.damage > 0)).toBe(true);
    expect(invOf(state, "B").shield).toBe(1);
    expect(invOf(state, "A").nuke).toBe(0);
    // El cráter: el piso bajó donde estaba B y a 10 celdas, más lejos que el radio del Missile.
    expect(terrainHeightAt(state.terrain, B.x, B.z)).toBeLessThan(GROUND);
    expect(terrainHeightAt(state.terrain, B.x + 10, B.z)).toBeLessThan(GROUND);
  });

  it("el mismo escudo sí frena un Missile en el mismo lugar", () => {
    const { state, blocked } = resolveTurn(duel(buyItem(fresh("B"), "shield")), MISSILE);
    expect(blocked).toEqual(["B"]);
    expect(lifeOf(state, "B")).toBe(TANK_MAX_LIFE);
  });

  it("el hoyo es varias veces el del Missile", () => {
    const m = duel();
    const nuke = resolveTurn(m, NUKE).state;
    const missile = resolveTurn(m, MISSILE).state;
    expect(lowered(m, nuke)).toBeGreaterThan(3 * lowered(m, missile));
    // A 10 celdas del impacto el Missile no tocó el piso.
    expect(terrainHeightAt(missile.terrain, B.x + 10, B.z)).toBe(GROUND);
    expect(WEAPONS.nuke.explosionRadius).toBeGreaterThanOrEqual(3 * WEAPONS.missile.explosionRadius);
    expect(WEAPONS.nuke.craterRadius).toBeGreaterThanOrEqual(3 * WEAPONS.missile.craterRadius);
  });

  it("no prende fuego y no rueda", () => {
    const { state, fire, shot } = resolveTurn(duel(), NUKE);
    expect(fire).toBeNull();
    expect(state.fires ?? []).toEqual([]);
    expect(shot.landed).toBeUndefined();
    expect(WEAPONS.nuke.burn).toBeUndefined();
    expect(WEAPONS.nuke.roll).toBeUndefined();
    // Vuela igual que un Missile: mismo punto de impacto.
    const missile = resolveTurn(duel(), MISSILE).shot;
    expect([shot.x, shot.y, shot.z]).toEqual([missile.x, missile.y, missile.z]);
  });

  it("en la tienda: de a uno y es el ítem más caro", () => {
    expect(isPlayable("nuke")).toBe(true);
    expect(SHOP_ITEMS.nuke.pack).toBe(1);
    for (const it of Object.values(SHOP_ITEMS)) if (it.id !== "nuke") expect(it.price).toBeLessThan(SHOP_ITEMS.nuke.price);
    const a = buyItem(fresh("A"), "nuke");
    expect(a.inventory.nuke).toBe(1);
    expect(a.money).toBe(MONEY_START - SHOP_ITEMS.nuke.price);
  });

  it("sin Nuke no se puede tirar", () => {
    expect(() => resolveTurn(duel(fresh("B"), fresh("A")), NUKE)).toThrow();
  });
});
