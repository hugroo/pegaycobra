import { describe, expect, it } from "vitest";
import {
  buyItem,
  cannotBuy,
  createFlatTerrain,
  endRoundPayouts,
  FUEL_MOVE_RANGE,
  INFINITE_AMMO,
  INTEREST_RATE,
  matchWinners,
  MONEY_START,
  moveTank,
  resolveTurn,
  ROUNDS_PER_MATCH,
  roundOver,
  scoreTurn,
  emptyScoreboard,
  SCORE_PER_KILL,
  SHOP_ITEMS,
  standings,
  startingInventory,
  startRound3D,
  SURVIVOR_BONUS,
  TANK_MAX_LIFE,
  tanks3DAt,
  terrainHeightAt,
  validateMove,
  type MatchState3D,
  type Player,
} from "../src";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });

/** Terreno plano a 10, A en el centro y B a 93 wu en +Z (donde cae yaw 90 / pitch 45 / power 600). */
function duel(bz = 128 + 93, players: Player[] = [fresh("A"), fresh("B")]): MatchState3D {
  const terrain = createFlatTerrain(257, 257, 10);
  return {
    terrain,
    wind: { x: 0, z: 0 },
    tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 128, z: 128 }, { x: 128, z: bz }], TANK_MAX_LIFE),
    players,
  };
}

describe("rondas", () => {
  it("una partida son 5 rondas (OptionsGame NumberOfRounds)", () => {
    expect(ROUNDS_PER_MATCH).toBe(5);
  });

  it("cada ronda sortea el viento de nuevo, reubica y resetea la vida, pero conserva plata e inventario", () => {
    const players = [buyItem(fresh("A"), "missile"), fresh("B")];
    const winds = new Set<string>();
    for (let r = 1; r <= 5; r++) {
      const s = startRound3D(1000 + r, players);
      winds.add(`${s.wind.x.toFixed(3)},${s.wind.z.toFixed(3)}`);
      expect(s.tanks.every((t) => t.life === TANK_MAX_LIFE)).toBe(true);
      expect(s.players[0]!.money).toBe(MONEY_START - SHOP_ITEMS.missile.price);
      expect(s.players[0]!.inventory.missile).toBe(3);
    }
    expect(winds.size).toBeGreaterThan(1);
  });

  it("el que se fue arranca la ronda muerto", () => {
    const s = startRound3D(7, [fresh("A"), fresh("B"), fresh("C")], new Set(["B"]));
    expect(s.tanks.find((t) => t.id === "B")!.life).toBe(0);
    expect(roundOver(s)).toBe(false);
  });
});

describe("plata de fin de ronda", () => {
  it("el que sobrevive cobra MoneyWonForRound + MoneyWonForLives, y después todos cobran interés", () => {
    const { players, payouts } = endRoundPayouts([fresh("A"), fresh("B")], new Set(["A"]));
    expect(SURVIVOR_BONUS).toBe(10_000);
    expect(payouts[0]).toEqual({ id: "A", before: 10_000, survivor: 10_000, interest: 3_000, after: 23_000 });
    expect(payouts[1]).toEqual({ id: "B", before: 10_000, survivor: 0, interest: 1_500, after: 11_500 });
    expect(players.map((p) => p.money)).toEqual([23_000, 11_500]);
  });

  it("el interés no se aplica a lo gastado", () => {
    const spender = buyItem(fresh("A"), "missile"); // gasta 1200
    const saver = fresh("B");
    const { payouts } = endRoundPayouts([spender, saver], new Set());
    expect(payouts[0]!.before).toBe(MONEY_START - 1200);
    expect(payouts[0]!.interest).toBe(Math.trunc((MONEY_START - 1200) * INTEREST_RATE)); // 1320, no 1500
    expect(payouts[1]!.interest).toBe(Math.trunc(MONEY_START * INTEREST_RATE));
  });

  it("el paracaídas vence al terminar la ronda", () => {
    const withChute = buyItem(fresh("A"), "parachute");
    expect(withChute.inventory.parachute).toBe(1);
    expect(endRoundPayouts([withChute], new Set()).players[0]!.inventory.parachute).toBe(0);
  });
});

describe("tienda", () => {
  it("vende Missile de a 3, paracaídas y nafta, y descuenta el precio", () => {
    let a = fresh("A");
    a = buyItem(a, "missile");
    a = buyItem(a, "fuel");
    a = buyItem(a, "parachute");
    expect(a.inventory.missile).toBe(3);
    expect(a.inventory.fuel).toBe(1);
    expect(a.inventory.parachute).toBe(1);
    expect(a.money).toBe(MONEY_START - SHOP_ITEMS.missile.price - SHOP_ITEMS.fuel.price - SHOP_ITEMS.parachute.price);
  });

  it("no se puede comprar de más", () => {
    const broke: Player = { ...fresh("A"), money: SHOP_ITEMS.missile.price - 1 };
    expect(cannotBuy(broke, "missile")).not.toBeNull();
    expect(() => buyItem(broke, "missile")).toThrow();
    let a = fresh("A");
    for (let i = 0; i < 8; i++) a = buyItem(a, "missile"); // 9600
    expect(() => buyItem(a, "missile")).toThrow(); // le quedan 400
    expect(a.money).toBe(MONEY_START - 8 * SHOP_ITEMS.missile.price);
    expect(() => buyItem(buyItem(fresh("B"), "parachute"), "parachute")).toThrow(); // uno por ronda
  });

  it("la Baby Missile no se vende", () => {
    expect(Object.keys(SHOP_ITEMS)).not.toContain("babyMissile");
  });
});

describe("armas: el Missile se gasta, la Baby no", () => {
  it("disparar un Missile descuenta uno; la Baby sigue infinita", () => {
    const armed = duel(128 + 200, [buyItem(fresh("A"), "missile"), fresh("B")]);
    const r1 = resolveTurn(armed, { playerId: "A", yaw: 0, pitch: 45, power: 400, weaponId: "missile" });
    expect(r1.state.players[0]!.inventory.missile).toBe(2);
    const r2 = resolveTurn(r1.state, { playerId: "A", yaw: 0, pitch: 45, power: 400 });
    expect(r2.state.players[0]!.inventory.babyMissile).toBe(INFINITE_AMMO);
    expect(r2.state.players[0]!.inventory.missile).toBe(2);
  });

  it("sin Missiles no se puede disparar un Missile", () => {
    expect(() => resolveTurn(duel(), { playerId: "A", yaw: 0, pitch: 45, power: 400, weaponId: "missile" })).toThrow();
  });

  it("el Missile hace daño de verdad: a la misma distancia lastima más que la Baby", () => {
    // B a 5 wu del punto de impacto (cae en z ≈ 221.27): la Baby (r 3.5) no llega, el Missile (r 6) sí.
    const far = 128 + 93.27 + 5;
    const baby = resolveTurn(duel(far), { playerId: "A", yaw: 90, pitch: 45, power: 600 });
    const armed = duel(far, [buyItem(fresh("A"), "missile"), fresh("B")]);
    const big = resolveTurn(armed, { playerId: "A", yaw: 90, pitch: 45, power: 600, weaponId: "missile" });
    const lifeB = (s: MatchState3D) => s.tanks.find((t) => t.id === "B")!.life;
    expect(lifeB(big.state)).toBeLessThan(lifeB(baby.state));
  });
});

describe("paracaídas", () => {
  // B justo después del impacto: no lo toca el proyectil, sí el cráter (cae ~1.2 wu).
  const nearB = 128 + 93.27 + 3;
  const shot = { playerId: "A", yaw: 90, pitch: 45, power: 600 } as const;

  it("sin paracaídas, la caída hace daño", () => {
    const { falls, damage } = resolveTurn(duel(nearB), shot);
    expect(falls.find((f) => f.tankId === "B")?.parachute).toBe(false);
    expect(damage.some((d) => d.targetId === "B" && d.cause === "fall" && d.damage > 0)).toBe(true);
  });

  it("con paracaídas, cae igual pero sin daño de caída", () => {
    const withChute = duel(nearB, [fresh("A"), buyItem(fresh("B"), "parachute")]);
    const { falls, damage, state } = resolveTurn(withChute, shot);
    expect(falls.find((f) => f.tankId === "B")?.parachute).toBe(true);
    expect(damage.some((d) => d.targetId === "B" && d.cause === "fall")).toBe(false);
    const without = resolveTurn(duel(nearB), shot).state;
    expect(state.tanks.find((t) => t.id === "B")!.life).toBeGreaterThan(without.tanks.find((t) => t.id === "B")!.life);
  });
});

describe("nafta", () => {
  const fueled = () => duel(128 + 93, [buyItem(fresh("A"), "fuel"), fresh("B")]);

  it("mueve el tanque hasta N celdas, lo apoya en el suelo y gasta la carga", () => {
    const s = moveTank(fueled(), "A", { x: 128 + 12, z: 128 + 16 }); // 20 justos
    const a = s.tanks.find((t) => t.id === "A")!;
    expect(a.x).toBe(140);
    expect(a.z).toBe(144);
    expect(a.y).toBe(terrainHeightAt(s.terrain, 140, 144));
    expect(s.players[0]!.inventory.fuel).toBe(0);
  });

  it("no teletransporta más lejos de N", () => {
    const check = validateMove(fueled(), "A", { x: 128 + FUEL_MOVE_RANGE + 0.01, z: 128 });
    expect(check.ok).toBe(false);
    expect(() => moveTank(fueled(), "A", { x: 128, z: 128 + 60 })).toThrow();
    expect(() => moveTank(fueled(), "A", { x: 128 + 15, z: 128 + 15 })).toThrow(); // 21.2 en diagonal
  });

  it("no deja salir del mapa, pegarse a otro tanque ni moverse sin nafta", () => {
    const s = fueled();
    expect(validateMove(s, "A", { x: 128, z: 128 + 93 - 2 }).ok).toBe(false); // N = 20, igual muy lejos
    const close = duel(128 + 18, [buyItem(fresh("A"), "fuel"), fresh("B")]);
    expect(validateMove(close, "A", { x: 128, z: 128 + 16 }).ok).toBe(false); // a 2 de B
    expect(validateMove(duel(), "A", { x: 130, z: 130 }).ok).toBe(false); // sin nafta
    const edge = { ...s, tanks: s.tanks.map((t) => (t.id === "A" ? { ...t, x: 5, z: 5 } : t)) };
    expect(validateMove(edge, "A", { x: -3, z: 5 }).ok).toBe(false);
  });
});

describe("puntaje", () => {
  it("es daño a otros + kills; la plata no suma", () => {
    let board = emptyScoreboard(["A", "B"]);
    board = scoreTurn(board, "A", [{ targetId: "B", cause: "explosion", damage: 55.3, killed: false, money: 1375 }]);
    board = scoreTurn(board, "A", [{ targetId: "B", cause: "explosion", damage: 44.7, killed: true, money: 7500 }]);
    expect(board.A).toEqual({ points: 55 + 45 + SCORE_PER_KILL, kills: 1, damage: 100 });
    expect(board.B).toEqual({ points: 0, kills: 0, damage: 0 });
  });

  it("el daño propio no suma y matarse resta un kill", () => {
    const board = scoreTurn(emptyScoreboard(["A"]), "A", [{ targetId: "A", cause: "explosion", damage: 100, killed: true, money: -7500 }]);
    expect(board.A).toEqual({ points: -SCORE_PER_KILL, kills: -1, damage: 0 });
  });

  it("gana el de más puntos; desempatan kills y daño", () => {
    const board = {
      A: { points: 120, kills: 1, damage: 110 },
      B: { points: 150, kills: 0, damage: 150 },
      C: { points: 120, kills: 2, damage: 100 },
    };
    expect(standings(board, ["A", "B", "C"]).map((s) => [s.id, s.rank])).toEqual([
      ["B", 1],
      ["C", 2],
      ["A", 3],
    ]);
    expect(matchWinners(board, ["A", "B", "C"])).toEqual(["B"]);
    expect(matchWinners({ A: { points: 5, kills: 0, damage: 5 }, B: { points: 5, kills: 0, damage: 5 } }, ["A", "B"])).toEqual(["A", "B"]);
  });
});
