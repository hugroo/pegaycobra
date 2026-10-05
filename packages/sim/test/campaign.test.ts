import { describe, expect, it } from "vitest";
import {
  applyCraterTerrain,
  buyItem,
  cannotBuy,
  cannotSell,
  createFlatTerrain,
  createRng,
  endRoundPayouts,
  FUEL_MOVE_RANGE,
  INFINITE_AMMO,
  INTEREST_RATE,
  isDug,
  MAP_IDS,
  matchWinners,
  MONEY_PER_ROUND,
  MONEY_START,
  moveTank,
  nextRound3D,
  placeTanks3D,
  resolveTurn,
  ROUNDS_PER_MATCH,
  roundOver,
  scoreTurn,
  sellItem,
  sellValue,
  emptyScoreboard,
  SCORE_PER_KILL,
  SHOP_ITEMS,
  standings,
  startingInventory,
  startRound3D,
  SURVIVOR_BONUS,
  TANK_MAX_LIFE,
  TANK_MIN_SEPARATION_3D,
  tanks3DAt,
  terrainHeightAt,
  validateMove,
  WATER_LEVEL,
  WEAPONS,
  type MatchState3D,
  type Player,
  type Terrain,
} from "../src";
import { dial } from "./aim";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });

/** Terreno plano a 10, A en el centro y B a 93 wu en +Z (donde cae yaw 90 / pitch 45 si sale con potencia 600). */
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

  it("la ronda siguiente se juega sobre el mismo piso: viento sorteado, vida llena, plata e inventario tal cual, sin fuego", () => {
    const first = startRound3D(7, [buyItem(fresh("A"), "missile"), fresh("B"), fresh("C")]);
    // Así termina la ronda 1: un hoyo de Bombazo en el medio, poca vida y un fuego prendido.
    const played: MatchState3D = {
      ...first,
      terrain: applyCraterTerrain(first.terrain, 128, terrainHeightAt(first.terrain, 128, 128), 128, WEAPONS.nuke.craterRadius),
      tanks: first.tanks.map((t) => ({ ...t, life: 12 })),
      fires: [{ x: 100, z: 100, radius: 9, damagePerTurn: 20, ownerId: "A", weaponId: "napalm" }],
    };
    const second = nextRound3D(8, played, first.terrain, new Set(["C"]));
    expect(second.terrain).toBe(played.terrain); // el mismo heightmap, con el hoyo
    expect(isDug(second.terrain, first.terrain, 128, 128)).toBe(true);
    expect(second.players).toEqual(played.players);
    expect(second.fires).toBeUndefined();
    expect(second.tanks.map((t) => t.life)).toEqual([TANK_MAX_LIFE, TANK_MAX_LIFE, 0]);
    for (const t of second.tanks) expect(t.y).toBe(terrainHeightAt(played.terrain, t.x, t.z));
    // El viento es el sorteo de siempre para esa semilla, no el que quedó.
    expect(second.wind).toEqual(startRound3D(8, played.players).wind);
    expect(second.wind).not.toEqual(first.wind);
  });
});

describe("ronda siguiente: nadie nace en un hoyo", () => {
  const GROUND = 10;
  const separated = (spots: readonly { x: number; z: number }[]) => {
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z)).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
      }
    }
  };
  /** Piso plano a 10 con una corona (de `inner` a `outer` celdas del centro) a la altura `h`. */
  function crown(h: number, inner: number, outer: number): Terrain {
    const t = createFlatTerrain(257, 257, GROUND);
    for (let z = 0; z < t.depth; z++) {
      for (let x = 0; x < t.width; x++) {
        const d = Math.hypot(x - 128, z - 128);
        if (d >= inner && d <= outer) t.heights[x + z * t.width] = h;
      }
    }
    return t;
  }

  it("si todo el anillo del sorteo quedó cavado, cada tanque se corre al piso sin tocar más cercano y siguen separados", () => {
    // El sorteo cae entre 78 y 102 celdas del centro: una corona de 70 a 115 lo tapa entero. Bajó 3: sigue
    // seca y con altura de arranque, así que lo único que los saca de ahí es que es un hoyo.
    const pristine = createFlatTerrain(257, 257, GROUND);
    const dug = crown(GROUND - 3, 70, 115);
    for (let seed = 1; seed <= 40; seed++) {
      for (const n of [2, 3, 4]) {
        // Sin el terreno original, el mismo sorteo los deja adentro de la corona.
        for (const s of placeTanks3D(dug, n, createRng(seed * 7 + n))) expect(isDug(dug, pristine, s.x, s.z)).toBe(true);

        const spots = placeTanks3D(dug, n, createRng(seed * 7 + n), undefined, pristine);
        for (const s of spots) {
          expect(isDug(dug, pristine, s.x, s.z)).toBe(false);
          expect(terrainHeightAt(dug, s.x, s.z)).toBe(GROUND);
          // El borde de adentro o el de afuera, el que quede a mano: no cruza el mapa.
          const d = Math.hypot(s.x - 128, s.z - 128);
          expect(d).toBeGreaterThan(60);
          expect(d).toBeLessThan(125);
        }
        separated(spots);
      }
    }
  });

  it("una loma no es hoyo: se nace arriba como en cualquier piso", () => {
    const pristine = createFlatTerrain(257, 257, GROUND);
    const raised = crown(GROUND + 6, 70, 115);
    for (const n of [2, 3, 4]) {
      // El mismo sorteo, con y sin el terreno original: nadie se corre.
      expect(placeTanks3D(raised, n, createRng(n), undefined, pristine)).toEqual(placeTanks3D(raised, n, createRng(n)));
    }
  });

  it("si no queda piso sin cavar, nacen igual en firme y separados", () => {
    const pristine = createFlatTerrain(257, 257, GROUND);
    const dug = createFlatTerrain(257, 257, GROUND - 3);
    for (const n of [2, 3, 4]) {
      const spots = placeTanks3D(dug, n, createRng(n), undefined, pristine);
      for (const s of spots) expect(terrainHeightAt(dug, s.x, s.z)).toBeGreaterThan(WATER_LEVEL);
      separated(spots);
    }
  });

  it("en los mapas del juego, con un Bombazo donde iba a nacer cada uno, nadie nace en el hoyo ni en el agua que dejó", () => {
    const R = WEAPONS.nuke.craterRadius;
    for (const map of MAP_IDS) {
      for (let seed = 1; seed <= 12; seed++) {
        for (const n of [2, 3, 4]) {
          const players = Array.from({ length: n }, (_, i) => fresh(`P${i}`));
          const first = startRound3D(seed * 31 + n, players, new Set(), map);
          // Dónde nacerían en la ronda 2 con el piso sano: ahí, y donde nacieron en la 1, cae un Bombazo.
          const untouched = nextRound3D(seed * 37 + n, first, first.terrain, new Set(), map);
          let terrain = first.terrain;
          for (const t of [...first.tanks, ...untouched.tanks]) terrain = applyCraterTerrain(terrain, t.x, t.y, t.z, R);
          for (const t of untouched.tanks) expect(isDug(terrain, first.terrain, t.x, t.z)).toBe(true);

          const second = nextRound3D(seed * 37 + n, { ...first, terrain }, first.terrain, new Set(), map);
          expect(second.terrain).toBe(terrain);
          for (const t of second.tanks) {
            expect(isDug(terrain, first.terrain, t.x, t.z)).toBe(false);
            expect(t.y).toBeGreaterThan(WATER_LEVEL);
          }
          separated(second.tanks);
        }
      }
    }
  }, 30_000);
});

describe("plata de fin de ronda", () => {
  it("el que sobrevive cobra MoneyWonForRound + MoneyWonForLives, y después todos cobran interés y el fijo", () => {
    const { players, payouts } = endRoundPayouts([fresh("A"), fresh("B")], new Set(["A"]));
    expect([MONEY_START, SURVIVOR_BONUS, MONEY_PER_ROUND]).toEqual([4_000, 2_000, 1_500]);
    expect(payouts[0]).toEqual({ id: "A", before: 4_000, survivor: 2_000, interest: 900 + 1_500, after: 8_400 });
    expect(payouts[1]).toEqual({ id: "B", before: 4_000, survivor: 0, interest: 600 + 1_500, after: 6_100 });
    expect(players.map((p) => p.money)).toEqual([8_400, 6_100]);
  });

  it("la plata no alcanza para todo: ni el que ganó la primera ronda con un kill compra la tienda entera", () => {
    // Lo más que se junta en la ronda 1: un kill de lleno con la Chispa (3000) y sobrevivir.
    const { players } = endRoundPayouts([{ ...fresh("A"), money: MONEY_START + 3_000 }, fresh("B")], new Set(["A"]));
    const all = Object.values(SHOP_ITEMS).reduce((sum, it) => sum + it.price, 0);
    expect(players[0]!.money).toBeLessThan(all);
    expect(players[0]!.money).toBeGreaterThanOrEqual(SHOP_ITEMS.nuke.price); // pero un Bombazo sí
    // Y el que perdió no queda afuera: le alcanza para un arma y una defensa.
    expect(players[1]!.money).toBeGreaterThanOrEqual(SHOP_ITEMS.mirv.price + SHOP_ITEMS.shield.price);
    expect(players[0]!.money / players[1]!.money).toBeLessThan(2);
  });

  it("el interés no se aplica a lo gastado", () => {
    const spender = buyItem(fresh("A"), "missile"); // gasta 1200
    const saver = fresh("B");
    const { payouts } = endRoundPayouts([spender, saver], new Set());
    expect(payouts[0]!.before).toBe(MONEY_START - 1200);
    expect(payouts[0]!.interest).toBe(Math.trunc((MONEY_START - 1200) * INTEREST_RATE) + MONEY_PER_ROUND); // 420 de interés, no 600
    expect(payouts[1]!.interest).toBe(Math.trunc(MONEY_START * INTEREST_RATE) + MONEY_PER_ROUND);
  });

  it("el paracaídas vence al terminar la ronda", () => {
    const withChute = buyItem(fresh("A"), "parachute");
    expect(withChute.inventory.parachute).toBe(1);
    expect(endRoundPayouts([withChute], new Set()).players[0]!.inventory.parachute).toBe(0);
  });
});

describe("tienda", () => {
  it("vende Missile de a 3, paracaídas y nafta, y descuenta el precio", () => {
    const wallet = 10_000; // con la plata del arranque no alcanza para los tres
    let a: Player = { ...fresh("A"), money: wallet };
    a = buyItem(a, "missile");
    a = buyItem(a, "fuel");
    a = buyItem(a, "parachute");
    expect(a.inventory.missile).toBe(3);
    expect(a.inventory.fuel).toBe(1);
    expect(a.inventory.parachute).toBe(1);
    expect(a.money).toBe(wallet - SHOP_ITEMS.missile.price - SHOP_ITEMS.fuel.price - SHOP_ITEMS.parachute.price);
  });

  it("no se puede comprar de más", () => {
    const broke: Player = { ...fresh("A"), money: SHOP_ITEMS.missile.price - 1 };
    expect(cannotBuy(broke, "missile")).not.toBeNull();
    expect(() => buyItem(broke, "missile")).toThrow();
    let a = fresh("A");
    for (let i = 0; i < 3; i++) a = buyItem(a, "missile"); // 3600
    expect(() => buyItem(a, "missile")).toThrow(); // le quedan 400
    expect(a.money).toBe(MONEY_START - 3 * SHOP_ITEMS.missile.price);
    expect(() => buyItem(buyItem(fresh("B"), "parachute"), "parachute")).toThrow(); // uno por ronda
  });

  it("la Baby Missile no se vende", () => {
    expect(Object.keys(SHOP_ITEMS)).not.toContain("babyMissile");
  });
});

describe("vender en la tienda", () => {
  it("comprás un Misil y lo vendés: vuelve la mitad y el inventario queda como antes", () => {
    const bought = buyItem(fresh("A"), "missile");
    expect(sellValue(bought, "missile")).toBe(SHOP_ITEMS.missile.price / 2);
    const sold = sellItem(bought, "missile");
    expect(sold.money).toBe(MONEY_START - SHOP_ITEMS.missile.price / 2);
    expect(sold.inventory.missile).toBe(0);
    expect(() => sellItem(sold, "missile")).toThrow(); // no queda nada
  });

  it("cada carta vuelve a la mitad de su precio", () => {
    for (const id of ["missile", "roller", "napalm", "nuke", "dirt", "mirv", "leapfrog", "parachute", "fuel"] as const) {
      const rich: Player = { ...fresh("A"), money: 50_000 };
      const sold = sellItem(buyItem(rich, id), id);
      expect(sold.money, id).toBe(50_000 - SHOP_ITEMS[id].price / 2);
      expect(sold.inventory[id], id).toBe(0);
    }
  });

  it("un tiro que ya salió no vuelve: del pack empezado se vende lo que queda", () => {
    const armed = duel(128 + 200, [buyItem(fresh("A"), "missile"), fresh("B")]);
    const a = resolveTurn(armed, { playerId: "A", yaw: 0, pitch: 45, power: 400, weaponId: "missile" }).state.players[0]!;
    expect(a.inventory.missile).toBe(2);
    expect(sellValue(a, "missile")).toBe(2 * 200); // 400 c/u, a la mitad
    const sold = sellItem(a, "missile");
    expect(sold.money).toBe(a.money + 400);
    expect(sold.inventory.missile).toBe(0);
  });

  it("con más de un pack, vende de a uno", () => {
    const two = buyItem(buyItem(fresh("A"), "roller"), "roller");
    const sold = sellItem(two, "roller");
    expect(sold.inventory.roller).toBe(2);
    expect(sold.money).toBe(two.money + SHOP_ITEMS.roller.price / 2);
  });

  it("la Nafta sin usar se vende; el Escudo puesto y la Chispa, no", () => {
    const a = buyItem(buyItem({ ...fresh("A"), money: 10_000 }, "fuel"), "shield");
    expect(cannotSell(a, "fuel")).toBeNull();
    expect(sellItem(a, "fuel").inventory.fuel).toBe(0);
    expect(cannotSell(a, "shield")).not.toBeNull();
    expect(() => sellItem(a, "shield")).toThrow();
    expect(cannotSell(a, "babyMissile" as never)).not.toBeNull();
    expect(a.inventory.babyMissile).toBe(INFINITE_AMMO);
    expect(cannotSell(fresh("B"), "fuel")).not.toBeNull(); // no tiene
  });

  it("comprar y vender en ronda no da plata", () => {
    let a = fresh("A");
    for (let i = 0; i < 5; i++) a = sellItem(buyItem(a, "missile"), "missile");
    expect(a.money).toBe(MONEY_START - 5 * (SHOP_ITEMS.missile.price / 2));
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
    const baby = resolveTurn(duel(far), { playerId: "A", yaw: 90, pitch: 45, power: dial("babyMissile", 600) });
    const armed = duel(far, [buyItem(fresh("A"), "missile"), fresh("B")]);
    const big = resolveTurn(armed, { playerId: "A", yaw: 90, pitch: 45, power: dial("missile", 600), weaponId: "missile" });
    const lifeB = (s: MatchState3D) => s.tanks.find((t) => t.id === "B")!.life;
    expect(lifeB(big.state)).toBeLessThan(lifeB(baby.state));
  });
});

describe("paracaídas", () => {
  // B justo después del impacto: no lo toca el proyectil, sí el cráter (cae ~1.2 wu).
  const nearB = 128 + 93.27 + 3;
  const shot = { playerId: "A", yaw: 90, pitch: 45, power: dial("babyMissile", 600) } as const;

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
    board = scoreTurn(board, "A", [{ targetId: "B", cause: "explosion", damage: 55.3, killed: false, money: 550 }]);
    board = scoreTurn(board, "A", [{ targetId: "B", cause: "explosion", damage: 44.7, killed: true, money: 3000 }]);
    expect(board.A).toEqual({ points: 55 + 45 + SCORE_PER_KILL, kills: 1, damage: 100 });
    expect(board.B).toEqual({ points: 0, kills: 0, damage: 0 });
  });

  it("el daño propio no suma y matarse resta un kill", () => {
    const board = scoreTurn(emptyScoreboard(["A"]), "A", [{ targetId: "A", cause: "explosion", damage: 100, killed: true, money: -3000 }]);
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
