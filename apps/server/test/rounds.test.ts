import { describe, expect, it } from "vitest";
import {
  createFlatTerrain,
  FUEL_MOVE_RANGE,
  INTEREST_RATE,
  MONEY_START,
  ROUND_MAX_TURNS,
  SCORE_PER_KILL,
  SHOP_ITEMS,
  SURVIVOR_BONUS,
  terrainHeightAt,
  WEAPONS,
} from "@pegaycobra/sim";
import { Game, parseBuyMessage, parseMoveMessage, SHOP_SECONDS } from "../src/game";
import { changedRect } from "../src/terrain-net";

function started(seed = 11, ids = ["A", "B"]) {
  const g = new Game(30, SHOP_SECONDS);
  for (const id of ids) g.addPlayer(id, id);
  g.start(ids[0]!, seed);
  return g;
}

/** Mata a `id` a mano y deja vencer el turno: así termina la ronda sin depender de la puntería. */
function killAndPass(g: Game, id: string) {
  g.match = { ...g.match!, tanks: g.match!.tanks.map((t) => (t.id === id ? { ...t, life: 0 } : t)) };
  for (let i = 0; i < 30 && g.phase === "aiming"; i++) g.tickSecond();
}

const money = (g: Game, id: string) => g.playerOf(id)!.money;
const inv = (g: Game, id: string) => g.playerOf(id)!.inventory;

describe("rondas", () => {
  it("arranca en la ronda 1 de 5, sin tienda", () => {
    const g = started();
    expect(g.round).toBe(1);
    expect(g.rounds).toBe(5);
    expect(g.phase).toBe("aiming");
    expect(g.buy("A", { item: "missile" })).toBe(false); // la tienda abre entre rondas
  });

  it("al quedar uno vivo termina la ronda: cobra el que sobrevivió, todos cobran interés, abre la tienda", () => {
    const g = started();
    killAndPass(g, "B");
    expect(g.phase).toBe("shop");
    expect(g.timeLeft).toBe(SHOP_SECONDS);
    expect(g.lastRound!.round).toBe(1);
    expect(g.lastRound!.survivors).toEqual(["A"]);
    expect(money(g, "A")).toBe(Math.trunc((MONEY_START + SURVIVOR_BONUS) * (1 + INTEREST_RATE)));
    expect(money(g, "B")).toBe(Math.trunc(MONEY_START * (1 + INTEREST_RATE)));
  });

  it("si nadie muere, la ronda corta a los 15 tiros por jugador (MaxNumberOfRoundTurns)", () => {
    const g = started();
    let ticks = 0;
    while (g.phase === "aiming" && ticks < 10_000) {
      g.tickSecond();
      ticks++;
    }
    expect(g.phase).toBe("shop");
    expect(ticks).toBe(30 * ROUND_MAX_TURNS * 2);
    expect(g.lastRound!.survivors.sort()).toEqual(["A", "B"]); // los dos cobran por sobrevivir
  });

  it("la ronda siguiente tiene viento sorteado de nuevo, terreno nuevo y vida llena", () => {
    const g = started(5);
    const wind1 = g.match!.wind;
    const terrain1 = g.match!.terrain;
    const winds = [`${wind1.x},${wind1.z}`];
    for (let r = 2; r <= 5; r++) {
      killAndPass(g, "B");
      g.setReady("A");
      g.setReady("B");
      expect(g.round).toBe(r);
      expect(g.phase).toBe("aiming");
      expect(g.match!.terrain).not.toBe(terrain1);
      expect(g.match!.tanks.every((t) => t.life === 100)).toBe(true);
      winds.push(`${g.match!.wind.x},${g.match!.wind.z}`);
    }
    expect(new Set(winds).size).toBeGreaterThan(1);
  });

  it("la tienda dura 20 s; al vencer empieza la ronda siguiente", () => {
    const g = started();
    killAndPass(g, "B");
    for (let i = 0; i < SHOP_SECONDS - 1; i++) g.tickSecond();
    expect(g.phase).toBe("shop");
    g.tickSecond();
    expect(g.phase).toBe("aiming");
    expect(g.round).toBe(2);
  });

  it("empieza un jugador distinto cada ronda", () => {
    const g = started();
    const first1 = g.turnId;
    killAndPass(g, "B");
    g.setReady("A");
    g.setReady("B");
    expect(g.turnId).not.toBe(first1);
  });
});

describe("tienda", () => {
  it("compra con la plata de cada uno y no deja comprar de más", () => {
    const g = started();
    killAndPass(g, "B");
    const before = money(g, "B"); // 11500
    expect(g.buy("B", { item: "missile" })).toBe(true);
    expect(money(g, "B")).toBe(before - SHOP_ITEMS.missile.price);
    expect(inv(g, "B").missile).toBe(3);
    let bought = 1;
    while (g.buy("B", { item: "missile" })) bought++;
    expect(money(g, "B")).toBeGreaterThanOrEqual(0);
    expect(money(g, "B")).toBeLessThan(SHOP_ITEMS.missile.price);
    expect(bought).toBe(Math.floor(before / SHOP_ITEMS.missile.price));
    expect(g.buy("B", { item: "babyNuke" })).toBe(false);
    expect(parseBuyMessage({ item: "babyMissile" })).toBeNull();
  });

  it("si todos tocan listo, la tienda cierra antes", () => {
    const g = started();
    killAndPass(g, "B");
    g.setReady("A");
    expect(g.phase).toBe("shop");
    g.setReady("B");
    expect(g.phase).toBe("aiming");
  });
});

describe("Missile en partida", () => {
  it("sin Missiles el tiro se ignora; con Missiles se gasta uno y la Baby no se gasta", () => {
    const g = started();
    const shooter = g.turnId!;
    expect(g.fire(shooter, { yaw: 0, pitch: 60, power: 300, weapon: "missile" })).toBeNull();
    // le damos Missiles a mano (como si los hubiera comprado)
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === shooter ? { ...p, inventory: { ...p.inventory, missile: 3 } } : p)) };
    const shot = g.fire(shooter, { yaw: g.aims.get(shooter)!.yaw, pitch: 60, power: 300, weapon: "missile" });
    expect(shot?.weapon).toBe("missile");
    expect(inv(g, shooter).missile).toBe(2); // ya se ve gastado mientras vuela
    g.finishShot();
    expect(inv(g, shooter).missile).toBe(2);
    expect(inv(g, shooter).babyMissile).toBe(-1);
  });
});

describe("Roller y Escudo en partida", () => {
  const give = (g: Game, id: string, items: object) => {
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, ...items } } : p)) };
  };

  it("la tienda vende Roller de a 2 y un solo Escudo", () => {
    const g = started();
    killAndPass(g, "B");
    const before = money(g, "B");
    expect(g.buy("B", { item: "roller" })).toBe(true);
    expect(inv(g, "B").roller).toBe(2);
    expect(g.buy("B", { item: "shield" })).toBe(true);
    expect(g.buy("B", { item: "shield" })).toBe(false); // ya tiene uno
    expect(inv(g, "B").shield).toBe(1);
    expect(money(g, "B")).toBe(before - SHOP_ITEMS.roller.price - SHOP_ITEMS.shield.price);
  });

  it("sin Rollers el tiro se ignora; con Rollers se gasta uno y el tiro incluye la rodada", () => {
    const g = started();
    const shooter = g.turnId!;
    const aim = { yaw: g.aims.get(shooter)!.yaw, pitch: 60, power: 500, weapon: "roller" };
    expect(g.fire(shooter, aim)).toBeNull();
    give(g, shooter, { roller: 2 });
    const shot = g.fire(shooter, aim)!;
    expect(shot.weapon).toBe("roller");
    expect(inv(g, shooter).roller).toBe(1);
    const r = shot.result.shot;
    expect(r.landed).toBeDefined();
    expect(r.y).toBeLessThanOrEqual(r.landed!.y);
    expect(r.path!.length / 3).toBe(r.ticks + 1); // un punto por tick: la animación dura vuelo + rodada
  });

  it("el escudo se ve puesto hasta que llega el tiro; ahí lo come, se gasta y no hay daño ni puntos", () => {
    const g = started();
    // Piso plano, A en el centro y B donde cae yaw 90 / pitch 45 / power 600.
    const terrain = createFlatTerrain(257, 257, 10);
    const at = (id: string, z: number) => ({ ...g.match!.tanks.find((t) => t.id === id)!, x: 128, y: 10, z });
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: [at("A", 128), at("B", 128 + 93)] };
    give(g, "A", { missile: 3 });
    give(g, "B", { shield: 1 });
    const hit = { yaw: 90, pitch: 45, power: 600, weapon: "missile" };

    const first = g.fire("A", hit)!;
    expect(first.result.blocked).toEqual(["B"]);
    expect(inv(g, "B").shield).toBe(1); // todavía vuela
    g.finishShot();
    expect(inv(g, "B").shield).toBe(0);
    expect(g.match!.tanks.find((t) => t.id === "B")!.life).toBe(100);
    expect(g.board.A!.points).toBe(0);
    expect(g.phase).toBe("aiming");

    for (let i = 0; i < 30; i++) g.tickSecond(); // B deja pasar su turno
    const second = g.fire("A", hit)!;
    expect(second.result.blocked).toEqual([]);
    g.finishShot();
    expect(g.match!.tanks.find((t) => t.id === "B")!.life).toBeLessThan(100);
    expect(g.board.A!.points).toBeGreaterThan(0);
  });
});

describe("Napalm en partida", () => {
  const BURN = WEAPONS.napalm.burn!.damagePerTurn;
  const give = (g: Game, id: string, items: object) => {
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, ...items } } : p)) };
  };
  const life = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!.life;
  const setLife = (g: Game, id: string, hp: number) => {
    g.match = { ...g.match!, tanks: g.match!.tanks.map((t) => (t.id === id ? { ...t, life: hp } : t)) };
  };
  /** El del turno lo deja vencer: no tira nadie. */
  const pass = (g: Game) => {
    for (let i = 0; i < 30; i++) g.tickSecond();
  };

  /** Piso plano, A en el centro, B donde cae yaw 90 / pitch 45 / power 600 y C lejos. Le toca a A, que tiene un Napalm. */
  const SPOTS: Record<string, { x: number; z: number }> = { A: { x: 128, z: 128 }, B: { x: 128, z: 128 + 93 }, C: { x: 30, z: 30 } };
  function flat(ids = ["A", "B"]) {
    const g = started(11, ids);
    const terrain = createFlatTerrain(257, 257, 10);
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: g.match!.tanks.map((t) => ({ ...t, ...SPOTS[t.id]!, y: 10 })) };
    give(g, "A", { napalm: 1 });
    expect(g.turnId).toBe("A");
    return g;
  }
  const NAPALM = { yaw: 90, pitch: 45, power: 600, weapon: "napalm" };

  it("la tienda lo vende de a 1", () => {
    const g = started();
    killAndPass(g, "B");
    const before = money(g, "B");
    expect(g.buy("B", { item: "napalm" })).toBe(true);
    expect(inv(g, "B").napalm).toBe(1);
    expect(money(g, "B")).toBe(before - SHOP_ITEMS.napalm.price);
  });

  it("sin Napalm el tiro se ignora", () => {
    const g = flat();
    give(g, "A", { napalm: 0 });
    expect(g.fire("A", NAPALM)).toBeNull();
    expect(g.phase).toBe("aiming");
  });

  it("el fuego queda cuando cae el tiro, el terreno sigue igual, y el que está adentro pierde vida al empezar cada turno sin que le tiren de nuevo", () => {
    const g = flat();
    const terrain = g.match!.terrain;
    const heights = terrain.heights.slice();

    const shot = g.fire("A", NAPALM)!;
    expect(shot.weapon).toBe("napalm");
    expect(inv(g, "A").napalm).toBe(0); // gastado mientras vuela
    expect(g.match!.fires).toBeUndefined(); // todavía no cayó
    g.finishShot();
    expect(g.match!.fires).toHaveLength(1);
    expect(g.match!.terrain).toBe(terrain);
    expect(g.match!.terrain.heights).toEqual(heights);

    // El tiro no le sacó nada; lo que le saca es empezar su turno parado ahí.
    expect(shot.result.damage).toEqual([]);
    expect(g.turnId).toBe("B");
    expect(life(g, "B")).toBe(100 - BURN);
    expect(g.board.A!.points).toBe(BURN); // los puntos son del que prendió el fuego
    expect(g.takeBurns()).toMatchObject([{ targetId: "B", ownerId: "A", damage: BURN, killed: false }]);
    expect(g.takeBurns()).toEqual([]); // la sala lo avisa una sola vez

    pass(g); // B no tira
    expect(g.turnId).toBe("A");
    expect(life(g, "A")).toBe(100); // A está lejos del fuego
    expect(g.takeBurns()).toEqual([]);
    pass(g); // A tampoco: a B nadie le tiró de nuevo
    expect(g.turnId).toBe("B");
    expect(life(g, "B")).toBe(100 - 2 * BURN);
    expect(g.board.A!.points).toBe(2 * BURN);
    expect(g.match!.terrain.heights).toEqual(heights);
  });

  it("el que se mueve con nafta sale del fuego: en su turno siguiente no pierde vida", () => {
    const g = flat();
    give(g, "B", { fuel: 1 });
    g.fire("A", NAPALM);
    g.finishShot();
    expect(life(g, "B")).toBe(100 - BURN);
    expect(g.move("B", { moveTo: { x: SPOTS.B!.x - 12, z: SPOTS.B!.z } })).not.toBeNull();
    pass(g);
    pass(g);
    expect(g.turnId).toBe("B");
    expect(life(g, "B")).toBe(100 - BURN);
    expect(g.takeBurns()).toHaveLength(1); // solo la primera
    expect(g.match!.fires).toHaveLength(1); // el fuego sigue donde estaba
  });

  it("si el fuego mata al que le tocaba, juega el siguiente", () => {
    const g = flat(["A", "B", "C"]);
    setLife(g, "B", BURN - 5);
    g.fire("A", NAPALM);
    g.finishShot();
    expect(life(g, "B")).toBe(0);
    expect(g.phase).toBe("aiming");
    expect(g.turnId).toBe("C");
    expect(g.takeBurns()).toMatchObject([{ targetId: "B", ownerId: "A", killed: true }]);
    expect(g.board.A).toMatchObject({ kills: 1, points: BURN - 5 + SCORE_PER_KILL });
  });

  it("si lo mata y queda uno solo, termina la ronda; la siguiente arranca sin fuego", () => {
    const g = flat();
    setLife(g, "B", BURN - 5);
    g.fire("A", NAPALM);
    g.finishShot();
    expect(g.phase).toBe("shop");
    expect(g.lastRound!.survivors).toEqual(["A"]);
    expect(g.match!.fires).toHaveLength(1); // durante la tienda todavía es la ronda que terminó
    g.setReady("A");
    g.setReady("B");
    expect(g.round).toBe(2);
    expect(g.match!.fires).toBeUndefined();
    expect(g.takeBurns()).toHaveLength(1);
  });
});

describe("Tierra en partida", () => {
  const give = (g: Game, id: string, items: object) => {
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, ...items } } : p)) };
  };
  const tank = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;

  /** Piso plano a 10, A en el centro y B donde cae yaw 90 / pitch 45 / power 600. Le toca a A, que tiene una Tierra. */
  const B = { x: 128, z: 128 + 93 };
  function flat() {
    const g = started();
    const terrain = createFlatTerrain(257, 257, 10);
    const at = (id: string, z: number) => ({ ...g.match!.tanks.find((t) => t.id === id)!, x: 128, y: 10, z });
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: [at("A", 128), at("B", B.z)] };
    give(g, "A", { dirt: 1 });
    expect(g.turnId).toBe("A");
    return g;
  }
  const DIRT = { yaw: 90, pitch: 45, power: 600, weapon: "dirt" };

  it("la tienda la vende de a 1", () => {
    const g = started();
    killAndPass(g, "B");
    const before = money(g, "B");
    expect(g.buy("B", { item: "dirt" })).toBe(true);
    expect(inv(g, "B").dirt).toBe(1);
    expect(money(g, "B")).toBe(before - SHOP_ITEMS.dirt.price);
  });

  it("sin Tierra el tiro se ignora", () => {
    const g = flat();
    give(g, "A", { dirt: 0 });
    expect(g.fire("A", DIRT)).toBeNull();
    expect(g.phase).toBe("aiming");
  });

  it("la loma aparece cuando cae el tiro: el terreno sube, el de arriba sube con él y el escudo ni se entera", () => {
    const g = flat();
    give(g, "B", { shield: 1 });
    const before = g.match!.terrain;

    const shot = g.fire("A", DIRT)!;
    expect(shot.weapon).toBe("dirt");
    expect(inv(g, "A").dirt).toBe(0); // gastada mientras vuela
    expect(g.match!.terrain).toBe(before); // todavía no cayó
    expect(tank(g, "B").y).toBe(10);
    g.finishShot();

    // El parche que viaja a los clientes es el disco de la loma (centrado en la celda del impacto), y adentro nada bajó.
    const after = g.match!.terrain;
    const rect = changedRect(before, after)!;
    const r = Math.trunc(WEAPONS.dirt.mound!.radius) + 1;
    const hit = shot.result.shot;
    expect(rect).toEqual({ x0: Math.trunc(hit.x) - r + 1, z0: Math.trunc(hit.z) - r + 1, w: 2 * r - 1, d: 2 * r - 1 });
    expect(after.heights.every((h, i) => h >= before.heights[i]!)).toBe(true);
    expect(terrainHeightAt(after, B.x, B.z)).toBeGreaterThan(10 + r - 1);

    expect(tank(g, "B").y).toBe(terrainHeightAt(after, B.x, B.z));
    expect(tank(g, "B").life).toBe(100);
    expect(inv(g, "B").shield).toBe(1);
    expect(shot.result.blocked).toEqual([]);
    expect(shot.result.damage).toEqual([]);
    expect(g.board.A!.points).toBe(0);
    expect(g.turnId).toBe("B");
  });
});

describe("nafta", () => {
  function fueled() {
    const g = started();
    const id = g.turnId!;
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, fuel: 2 } } : p)) };
    const t = g.match!.tanks.find((tk) => tk.id === id)!;
    return { g, id, t };
  }

  it("mueve el tanque antes de tirar, una vez por turno, y gasta una carga", () => {
    const { g, id, t } = fueled();
    const to = { x: t.x + 10, z: t.z };
    const moved = g.move(id, { moveTo: to });
    expect(moved).not.toBeNull();
    expect(g.match!.tanks.find((tk) => tk.id === id)!.x).toBeCloseTo(t.x + 10, 5);
    expect(inv(g, id).fuel).toBe(1);
    expect(g.move(id, { moveTo: { x: t.x + 12, z: t.z } })).toBeNull(); // segunda vez en el turno
    expect(g.phase).toBe("aiming"); // sigue pudiendo tirar
    expect(g.fire(id, { yaw: 0, pitch: 60, power: 300 })).not.toBeNull();
  });

  it("el server rechaza destinos más lejos de N, sin nafta o de otro jugador", () => {
    const { g, id, t } = fueled();
    expect(g.move(id, { moveTo: { x: t.x + FUEL_MOVE_RANGE + 1, z: t.z } })).toBeNull();
    const other = g.seats.find((s) => s.id !== id)!.id;
    expect(g.move(other, { moveTo: { x: t.x, z: t.z } })).toBeNull(); // no es su turno
    expect(g.match!.tanks.find((tk) => tk.id === id)!.x).toBe(t.x);
    expect(parseMoveMessage({ moveTo: { x: "1", z: 2 } })).toBeNull();
    expect(parseMoveMessage({ x: 1, z: 2 })).toBeNull();
  });
});

describe("fin de partida", () => {
  it("después de la ronda 5 gana el de más puntos, no el de más plata", () => {
    const g = started();
    for (let r = 1; r <= 5; r++) {
      if (r > 1) {
        g.setReady("A");
        g.setReady("B");
      }
      // B junta puntos a mano; A sobrevive todas las rondas y junta más plata.
      g.board = { ...g.board, B: { points: g.board.B!.points + 30, kills: 0, damage: g.board.B!.damage + 30 } };
      killAndPass(g, "B");
    }
    expect(g.phase).toBe("ended");
    expect(g.endReason).toBe("rounds");
    expect(money(g, "A")).toBeGreaterThan(money(g, "B"));
    expect(g.winnerId).toBe("B");
    expect(g.winners).toEqual(["B"]);
  });

  it("empate en puntos: no hay ganador único", () => {
    const g = started();
    for (let r = 1; r <= 5; r++) {
      if (r > 1) {
        g.setReady("A");
        g.setReady("B");
      }
      killAndPass(g, "B");
    }
    expect(g.phase).toBe("ended");
    expect(g.winnerId).toBeNull();
    expect(g.winners.sort()).toEqual(["A", "B"]);
  });

  it("si se van todos menos uno, ese gana aunque sea en la tienda", () => {
    const g = started(3, ["A", "B", "C"]);
    killAndPass(g, "C");
    killAndPass(g, "B");
    expect(g.phase).toBe("shop");
    g.removePlayer("B");
    expect(g.phase).toBe("shop");
    g.removePlayer("C");
    expect(g.phase).toBe("ended");
    expect(g.endReason).toBe("forfeit");
    expect(g.winnerId).toBe("A");
  });
});
