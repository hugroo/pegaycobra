import { describe, expect, it } from "vitest";
import {
  consumeAmmo,
  createFlatHeightmap,
  endOfRoundMoney,
  INFINITE_AMMO,
  INTEREST_RATE,
  MONEY_MAX,
  MONEY_PER_HIT_POINT,
  MONEY_PER_KILL_POINT,
  MONEY_PER_ROUND,
  MONEY_START,
  moneyForDamage,
  resolveTurn,
  simulateShot,
  startingInventory,
  TANK_MAX_LIFE,
  WEAPONS,
  type MatchState,
} from "../src";

const FLAT = createFlatHeightmap(257, 10);
const SHOT = { angleDeg: 45, power: 600 } as const;

function match(victimX: number): MatchState {
  return {
    heights: FLAT,
    wind: 0,
    tanks: [
      { id: "A", x: 40, y: 10, life: TANK_MAX_LIFE },
      { id: "B", x: victimX, y: 10, life: TANK_MAX_LIFE },
    ],
    players: [
      { id: "A", money: MONEY_START, inventory: startingInventory() },
      { id: "B", money: MONEY_START, inventory: startingInventory() },
    ],
  };
}

// Dónde cae el tiro de referencia si no hay nadie en el camino (~133.27).
const impactX = simulateShot(FLAT, { originX: 40, originY: 10, ...SHOT, wind: 0 }).x;

describe("5. matar paga plata; el misil básico no se gasta", () => {
  it("impacto directo: B muere y A cobra MoneyWonPerKillPoint · armslevel", () => {
    const { state, shot, damage } = resolveTurn(match(Math.round(impactX)), { playerId: "A", ...SHOT });

    expect(shot.outcome).toBe("tank");
    expect(shot.tankId).toBe("B");

    const b = state.tanks.find((t) => t.id === "B")!;
    expect(b.life).toBe(0);

    const kill = damage.find((d) => d.targetId === "B" && d.killed);
    expect(kill).toBeDefined();
    // MoneyWonPerKillPoint 300 · armslevel 10 · (100 hp / 100) = 3000
    expect(kill!.money).toBe(MONEY_PER_KILL_POINT * WEAPONS.babyMissile.armsLevel);
    expect(kill!.money).toBe(3000);

    const a = state.players.find((p) => p.id === "A")!;
    expect(a.money).toBe(MONEY_START + 3000);
  });

  it("la Baby Missile es infinita: después de disparar sigue en -1", () => {
    const { state } = resolveTurn(match(200), { playerId: "A", ...SHOT });
    const a = state.players.find((p) => p.id === "A")!;
    expect(startingInventory().babyMissile).toBe(INFINITE_AMMO);
    expect(a.inventory.babyMissile).toBe(INFINITE_AMMO);
  });

  it("pasa lo mismo después de muchos disparos", () => {
    let s = match(200);
    for (let i = 0; i < 25; i++) s = resolveTurn(s, { playerId: "A", ...SHOT }).state;
    expect(s.players[0]!.inventory.babyMissile).toBe(INFINITE_AMMO);
  });

  it("errar no paga", () => {
    const { state, damage } = resolveTurn(match(200), { playerId: "A", ...SHOT });
    expect(damage).toHaveLength(0);
    expect(state.players[0]!.money).toBe(MONEY_START);
  });

  it("explosión cercana + caída: daña a B, B cae, y las dos cosas pagan", () => {
    // B justo después del punto de impacto: no lo toca el proyectil, sí la explosión y el cráter.
    const { state, damage, falls } = resolveTurn(match(impactX + 3), { playerId: "A", ...SHOT });
    const b = state.tanks.find((t) => t.id === "B")!;

    expect(damage.some((d) => d.targetId === "B" && d.cause === "explosion")).toBe(true);
    expect(falls.some((f) => f.tankId === "B" && f.distance > 0)).toBe(true);
    expect(damage.some((d) => d.targetId === "B" && d.cause === "fall")).toBe(true);
    expect(b.life).toBeGreaterThan(0);
    expect(b.life).toBeLessThan(TANK_MAX_LIFE);

    const paid = damage.reduce((sum, d) => sum + d.money, 0);
    expect(paid).toBeGreaterThan(0);
    expect(state.players[0]!.money).toBe(MONEY_START + paid);
  });

  it("no deja disparar armas fuera del MVP", () => {
    expect(() => resolveTurn(match(200), { playerId: "A", ...SHOT, weaponId: "babyNuke" })).toThrow();
  });
});

describe("reglas de plata sueltas", () => {
  it("premio por daño sin kill: MoneyWonPerHitPoint · armslevel · daño/100", () => {
    expect(MONEY_PER_HIT_POINT).toBe(100);
    expect(moneyForDamage({ damage: 50, killed: false, armsLevel: 10, friendly: false })).toBe(500);
    expect(moneyForDamage({ damage: 50.9, killed: false, armsLevel: 10, friendly: false })).toBe(500);
  });

  it("dañarse a uno mismo resta", () => {
    expect(moneyForDamage({ damage: 40, killed: false, armsLevel: 10, friendly: true })).toBe(-400);
  });

  it("al final de la ronda: interés del 15% sobre lo no gastado, más el fijo", () => {
    expect(INTEREST_RATE).toBe(0.15);
    expect(endOfRoundMoney(10_000)).toBe(11_500 + MONEY_PER_ROUND);
    expect(endOfRoundMoney(333)).toBe(382 + MONEY_PER_ROUND); // 333 + trunc(49.95)
    expect(endOfRoundMoney(0)).toBe(MONEY_PER_ROUND); // el que quedó seco igual cobra el fijo
    expect(endOfRoundMoney(MONEY_MAX)).toBe(MONEY_MAX);
  });

  it("las armas finitas sí se gastan", () => {
    const inv = { ...startingInventory(), missile: WEAPONS.missile.bundleSize };
    expect(consumeAmmo(inv, "missile").missile).toBe(4);
    expect(() => consumeAmmo({ missile: 0 }, "missile")).toThrow();
  });
});
