import { describe, expect, it } from "vitest";
import {
  createFlatTerrain,
  FREE_STEP_RANGE,
  FUEL_MOVE_RANGE,
  INTEREST_RATE,
  launchPower,
  MONEY_PER_ROUND,
  MONEY_START,
  ROUND_MAX_TURNS,
  SCORE_PER_KILL,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  startingInventory,
  SURVIVOR_BONUS,
  terrainHeightAt,
  validateMove,
  WEAPONS,
  type WeaponId,
} from "@pegaycobra/sim";
import { Game, parseBuyMessage, parseMoveMessage, SHOP_SECONDS, shotDurationMs, TURN_SECONDS } from "../src/game";
import { changedRect } from "../src/terrain-net";

function started(seed = 11, ids = ["A", "B"]) {
  const g = new Game(TURN_SECONDS, SHOP_SECONDS);
  for (const id of ids) g.addPlayer(id, id);
  g.start(ids[0]!, seed);
  return g;
}

/** Mata a `id` a mano y deja vencer el turno: así termina la ronda sin depender de la puntería. */
function killAndPass(g: Game, id: string) {
  g.match = { ...g.match!, tanks: g.match!.tanks.map((t) => (t.id === id ? { ...t, life: 0 } : t)) };
  for (let i = 0; i < TURN_SECONDS && g.phase === "aiming"; i++) g.tickSecond();
}

/**
 * La potencia que hay que apuntar con `weapon` para que el tiro salga del cañón con `launch` (la
 * inversa de launchPower): los escenarios ponen a B a 93 celdas, donde cae un tiro a 45° que sale con 600.
 */
const dial = (weapon: WeaponId, launch: number) => launch / launchPower(WEAPONS[weapon], 1);

const money = (g: Game, id: string) => g.playerOf(id)!.money;
const inv = (g: Game, id: string) => g.playerOf(id)!.inventory;
/** Lo que queda al terminar la ronda: la plata, su interés y el fijo. */
const afterRound = (m: number) => m + Math.trunc(m * INTEREST_RATE) + MONEY_PER_ROUND;

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
    expect(money(g, "A")).toBe(afterRound(MONEY_START + SURVIVOR_BONUS));
    expect(money(g, "B")).toBe(afterRound(MONEY_START));
  });

  it("si nadie muere, la ronda corta a los 15 tiros por jugador (MaxNumberOfRoundTurns)", () => {
    const g = started();
    let ticks = 0;
    while (g.phase === "aiming" && ticks < 10_000) {
      g.tickSecond();
      ticks++;
    }
    expect(g.phase).toBe("shop");
    expect(ticks).toBe(TURN_SECONDS * ROUND_MAX_TURNS * 2);
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

  it("la tienda dura 30 s; al vencer empieza la ronda siguiente", () => {
    const g = started();
    killAndPass(g, "B");
    for (let i = 0; i < SHOP_SECONDS - 1; i++) g.tickSecond();
    expect(g.phase).toBe("shop");
    g.tickSecond();
    expect(g.phase).toBe("aiming");
    expect(g.round).toBe(2);
  });

  it("a los 20 s sin tirar, el turno pasa; la tienda no cierra antes de los 30; el que abre la ronda tiene los mismos 20", () => {
    const g = new Game(); // los relojes de la sala, sin pisar
    g.addPlayer("A", "A");
    g.addPlayer("B", "B");
    g.start("A", 11);
    expect(g.timeLeft).toBe(20);
    for (let i = 0; i < 19; i++) expect(g.tickSecond()).toBe(false);
    expect(g.turnId).toBe("A");
    expect(g.tickSecond()).toBe(true);
    expect(g.turnId).toBe("B");
    expect(g.timeLeft).toBe(20);

    killAndPass(g, "A");
    expect(g.phase).toBe("shop");
    expect(g.timeLeft).toBe(30);
    for (let i = 0; i < 29; i++) g.tickSecond();
    expect(g.phase).toBe("shop");
    expect(g.buy("B", { item: "missile" })).toBe(true); // en el segundo 29 todavía se compra
    g.tickSecond();
    expect(g.phase).toBe("aiming");
    expect(g.round).toBe(2);
    expect(g.timeLeft).toBe(20); // el primer turno de la ronda, igual que los demás
  });

  it("reloj escrito por el anfitrión: turno de 12, tienda de 15 y 2 rondas; la partida termina en la segunda", () => {
    const g = new Game();
    g.addPlayer("A", "A");
    g.addPlayer("B", "B");
    expect(g.setClock("B", { turn: 12, shop: 15, rounds: 2 })).toBe(false); // solo el anfitrión
    expect(g.setClock("A", { turn: 12, shop: 15, rounds: 2 })).toBe(true);
    g.start("A", 11);
    expect(g.setClock("A", { turn: 30, shop: 30, rounds: 5 })).toBe(false); // arrancada, queda fijo
    expect(g.timeLeft).toBe(12);
    for (let i = 0; i < 11; i++) expect(g.tickSecond()).toBe(false);
    expect(g.tickSecond()).toBe(true);
    expect(g.turnId).toBe("B");

    killAndPass(g, "A");
    expect(g.phase).toBe("shop");
    expect(g.timeLeft).toBe(15);
    for (let i = 0; i < 14; i++) g.tickSecond();
    expect(g.phase).toBe("shop");
    g.tickSecond();
    expect([g.phase, g.round, g.timeLeft]).toEqual(["aiming", 2, 12]);

    killAndPass(g, "A");
    expect(g.phase).toBe("ended"); // dos rondas y listo: sin tercera ni tienda
    expect(g.endReason).toBe("rounds");
    expect(g.setClock("A", { turn: 30, shop: 30, rounds: 5 })).toBe(false); // terminada, tampoco
    expect(g.rematch("A", 12)).toBe(true);
    expect([g.rounds, g.timeLeft]).toEqual([2, 12]); // la revancha, con los mismos
  });

  it("reloj: los bordes entran; vacío, afuera, con coma o texto vuelve al de siempre, campo por campo", () => {
    const g = new Game();
    g.addPlayer("A", "A");
    const clock = () => [g.turnSeconds, g.shopSeconds, g.rounds];
    g.setClock("A", { turn: 10, shop: 10, rounds: 1 });
    expect(clock()).toEqual([10, 10, 1]);
    g.setClock("A", { turn: 60, shop: 90, rounds: 9 });
    expect(clock()).toEqual([60, 90, 9]);
    g.setClock("A", { turn: 61, shop: 45, rounds: 10 });
    expect(clock()).toEqual([20, 45, 5]); // el que está bien se queda
    g.setClock("A", { turn: 9, shop: 91, rounds: 0 });
    expect(clock()).toEqual([20, 30, 5]);
    for (const bad of [null, "12", 12.5, NaN, Infinity, -12, {}, [12]]) {
      g.setClock("A", { turn: 12, shop: 40, rounds: 2 });
      g.setClock("A", { turn: bad, shop: bad, rounds: bad });
      expect(clock(), String(bad)).toEqual([20, 30, 5]);
    }
    g.setClock("A", { turn: 12, shop: 40, rounds: 2 });
    g.setClock("A", {});
    expect(clock()).toEqual([20, 30, 5]);
    for (const junk of [null, undefined, "x", 12]) expect(g.setClock("A", junk)).toBe(false);
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
    const before = money(g, "B"); // 6100
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

  it("vender devuelve la mitad; no se vende la Chispa, ni el Escudo puesto, ni fuera de la tienda", () => {
    const g = started();
    expect(g.sell("A", { item: "missile" })).toBe(false); // la tienda abre entre rondas
    killAndPass(g, "B");
    const before = money(g, "B");
    expect(g.sell("B", { item: "missile" })).toBe(false); // no tiene
    expect(g.buy("B", { item: "missile" })).toBe(true);
    expect(g.sell("B", { item: "missile" })).toBe(true);
    expect(money(g, "B")).toBe(before - SHOP_ITEMS.missile.price / 2);
    expect(inv(g, "B").missile).toBe(0);
    expect(money(g, "A")).toBe(afterRound(MONEY_START + SURVIVOR_BONUS)); // al otro no le toca nada

    expect(g.buy("B", { item: "fuel" })).toBe(true);
    expect(g.buy("B", { item: "shield" })).toBe(true);
    const mid = money(g, "B");
    expect(g.sell("B", { item: "shield" })).toBe(false); // ya está puesto
    expect(g.sell("B", { item: "babyMissile" })).toBe(false);
    expect(g.sell("B", { item: "babyNuke" })).toBe(false);
    expect(g.sell("B", {})).toBe(false);
    expect(g.sell("nadie", { item: "fuel" })).toBe(false);
    expect(money(g, "B")).toBe(mid);
    expect(inv(g, "B")).toMatchObject({ shield: 1, fuel: 1, babyMissile: -1 });
    expect(g.sell("B", { item: "fuel" })).toBe(true); // la Nafta sin usar, sí
    expect(money(g, "B")).toBe(mid + SHOP_ITEMS.fuel.price / 2);
    expect(inv(g, "B").fuel).toBe(0);
  });

  it("un tiro que ya salió no se vende: mientras vuela no hay venta, y en la tienda vuelve solo lo que quedó", () => {
    const g = started();
    const shooter = g.turnId!;
    const other = shooter === "A" ? "B" : "A";
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === shooter ? { ...p, inventory: { ...p.inventory, missile: 3 } } : p)) };
    expect(g.fire(shooter, { yaw: g.aims.get(shooter)!.yaw + 180, pitch: 60, power: 250, weapon: "missile" })).not.toBeNull();
    expect(g.phase).toBe("animating");
    expect(g.sell(shooter, { item: "missile" })).toBe(false);
    g.finishShot();
    expect(g.sell(shooter, { item: "missile" })).toBe(false); // sigue la ronda
    killAndPass(g, other);
    expect(g.phase).toBe("shop");
    const before = money(g, shooter);
    expect(g.sell(shooter, { item: "missile" })).toBe(true);
    expect(inv(g, shooter).missile).toBe(0);
    expect(money(g, shooter)).toBe(before + 2 * (SHOP_ITEMS.missile.price / 3 / 2)); // dos Misiles, no tres
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
    // Piso plano, A en el centro y B donde cae yaw 90 / pitch 45 si sale con potencia 600.
    const terrain = createFlatTerrain(257, 257, 10);
    const at = (id: string, z: number) => ({ ...g.match!.tanks.find((t) => t.id === id)!, x: 128, y: 10, z });
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: [at("A", 128), at("B", 128 + 93)] };
    give(g, "A", { missile: 3 });
    give(g, "B", { shield: 1 });
    const hit = { yaw: 90, pitch: 45, power: dial("missile", 600), weapon: "missile" };

    const first = g.fire("A", hit)!;
    expect(first.result.blocked).toEqual(["B"]);
    expect(inv(g, "B").shield).toBe(1); // todavía vuela
    g.finishShot();
    expect(inv(g, "B").shield).toBe(0);
    expect(g.match!.tanks.find((t) => t.id === "B")!.life).toBe(100);
    expect(g.board.A!.points).toBe(0);
    expect(g.phase).toBe("aiming");

    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond(); // B deja pasar su turno
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
    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond();
  };

  /** Piso plano, A en el centro, B donde cae yaw 90 / pitch 45 si sale con potencia 600 y C lejos. Le toca a A, que tiene un Napalm. */
  const SPOTS: Record<string, { x: number; z: number }> = { A: { x: 128, z: 128 }, B: { x: 128, z: 128 + 93 }, C: { x: 30, z: 30 } };
  function flat(ids = ["A", "B"]) {
    const g = started(11, ids);
    const terrain = createFlatTerrain(257, 257, 10);
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: g.match!.tanks.map((t) => ({ ...t, ...SPOTS[t.id]!, y: 10 })) };
    give(g, "A", { napalm: 1 });
    expect(g.turnId).toBe("A");
    return g;
  }
  const NAPALM = { yaw: 90, pitch: 45, power: dial("napalm", 600), weapon: "napalm" };

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
    // La cuenta de la ronda: el que murió quemado es un kill común de A, y lo anotado es justo lo que A juntó pegando.
    const earned = g.lastRound!.earned;
    expect(earned.A!.kill).toBeGreaterThan(0);
    expect(earned.A!.water).toBe(0);
    expect(earned.A!.damage + earned.A!.kill).toBe(g.lastRound!.payouts.find((p) => p.id === "A")!.before - MONEY_START);
    expect(earned.B).toBeUndefined();
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

  /** Piso plano a 10, A en el centro y B donde cae yaw 90 / pitch 45 si sale con potencia 600. Le toca a A, que tiene una Tierra. */
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
  const DIRT = { yaw: 90, pitch: 45, power: dial("dirt", 600), weapon: "dirt" };

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

describe("Racimo en partida", () => {
  const give = (g: Game, id: string, items: object) => {
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, ...items } } : p)) };
  };
  const tank = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;
  const MIRV = { yaw: 90, pitch: 45, power: 600, weapon: "mirv" };

  /** Piso plano a 10, A en el centro y B donde diga el test. Le toca a A, que tiene un Racimo. */
  function flat(b: { x: number; z: number }) {
    const g = started();
    const terrain = createFlatTerrain(257, 257, 10);
    const at = (id: string, x: number, z: number) => ({ ...g.match!.tanks.find((t) => t.id === id)!, x, y: 10, z });
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: [at("A", 128, 128), at("B", b.x, b.z)] };
    give(g, "A", { mirv: 1 });
    expect(g.turnId).toBe("A");
    return g;
  }
  /** Dónde cae cada cabeza de ese tiro, con nadie en el camino. */
  const landings = () =>
    simulateWeaponShot3D(createFlatTerrain(257, 257, 10), WEAPONS.mirv, { originX: 128, originY: 10, originZ: 128, ...MIRV, wind: { x: 0, z: 0 } }).split!.heads;

  it("la tienda lo vende de a 1", () => {
    const g = started();
    killAndPass(g, "B");
    const before = money(g, "B");
    expect(g.buy("B", { item: "mirv" })).toBe(true);
    expect(inv(g, "B").mirv).toBe(1);
    expect(money(g, "B")).toBe(before - SHOP_ITEMS.mirv.price);
  });

  it("sin Racimo el tiro se ignora", () => {
    const g = flat({ x: 30, z: 30 });
    give(g, "A", { mirv: 0 });
    expect(g.fire("A", MIRV)).toBeNull();
    expect(g.phase).toBe("aiming");
  });

  it("el server resuelve las 5 cabezas: cinco hoyos en un solo parche, y la animación dura hasta la última", () => {
    const g = flat({ x: 30, z: 30 });
    const before = g.match!.terrain;

    const shot = g.fire("A", MIRV)!;
    const heads = shot.result.shot.split!.heads;
    expect(shot.weapon).toBe("mirv");
    expect(heads).toHaveLength(5);
    expect(heads).toEqual(landings().map((h) => expect.objectContaining({ x: h.x, z: h.z, outcome: "ground" })));
    expect(inv(g, "A").mirv).toBe(0); // gastado mientras vuela
    expect(g.match!.terrain).toBe(before); // todavía no cayó ninguna
    expect(shot.durationMs).toBe(shotDurationMs(Math.max(...heads.map((h) => h.ticks))));
    g.finishShot();

    // El parche que viaja a los clientes cubre los cinco hoyos, y adentro nada subió.
    const after = g.match!.terrain;
    const rect = changedRect(before, after)!;
    for (const h of heads) {
      const [x, z] = [Math.trunc(h.x), Math.trunc(h.z)];
      expect(terrainHeightAt(after, x, z)).toBeLessThan(10 - 2);
      expect(x).toBeGreaterThanOrEqual(rect.x0);
      expect(x).toBeLessThan(rect.x0 + rect.w);
      expect(z).toBeGreaterThanOrEqual(rect.z0);
      expect(z).toBeLessThan(rect.z0 + rect.d);
    }
    expect(after.heights.every((h, i) => h <= before.heights[i]!)).toBe(true);
    // Hoyos chicos: el parche es mucho más chico que el cráter de un Bombazo (37 de lado).
    expect(Math.max(rect.w, rect.d)).toBeLessThan(2 * WEAPONS.nuke.craterRadius);
    expect(g.turnId).toBe("B");
  });

  it("el escudo come una cabeza y la otra le pega: el daño se suma y da puntos", () => {
    // B entre donde cae la del medio y una punta: lo alcanzan las dos.
    const [mid, tip] = landings();
    const g = flat({ x: (mid!.x + tip!.x) / 2, z: (mid!.z + tip!.z) / 2 });
    give(g, "B", { shield: 1 });

    const shot = g.fire("A", MIRV)!;
    expect(shot.result.blocked).toEqual(["B"]);
    expect(inv(g, "B").shield).toBe(1); // todavía vuela
    expect(tank(g, "B").life).toBe(100);
    g.finishShot();

    expect(inv(g, "B").shield).toBe(0);
    const dealt = shot.result.damage.reduce((sum, d) => sum + d.damage, 0);
    expect(shot.result.damage.filter((d) => d.cause === "explosion")).toHaveLength(1);
    expect(dealt).toBeGreaterThan(20);
    expect(tank(g, "B").life).toBeCloseTo(100 - dealt, 6);
    expect(g.board.A!.points).toBe(Math.round(dealt));
  });
});

describe("Rebote en partida", () => {
  const give = (g: Game, id: string, items: object) => {
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, ...items } } : p)) };
  };
  const BOUNCE = { yaw: 90, pitch: 45, power: 600, weapon: "leapfrog" };

  /** Piso plano a 10, A en el centro y B lejos. Le toca a A, que tiene un pack de Rebote. */
  function flat() {
    const g = started();
    const terrain = createFlatTerrain(257, 257, 10);
    const at = (id: string, x: number, z: number) => ({ ...g.match!.tanks.find((t) => t.id === id)!, x, y: 10, z });
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: [at("A", 128, 128), at("B", 30, 30)] };
    give(g, "A", { leapfrog: 2 });
    expect(g.turnId).toBe("A");
    return g;
  }

  it("la tienda lo vende de a 2", () => {
    const g = started();
    killAndPass(g, "B");
    const before = money(g, "B");
    expect(g.buy("B", { item: "leapfrog" })).toBe(true);
    expect(inv(g, "B").leapfrog).toBe(2);
    expect(money(g, "B")).toBe(before - SHOP_ITEMS.leapfrog.price);
  });

  it("sin Rebote el tiro se ignora", () => {
    const g = flat();
    give(g, "A", { leapfrog: 0 });
    expect(g.fire("A", BOUNCE)).toBeNull();
    expect(g.phase).toBe("aiming");
  });

  it("el server resuelve el pique: la animación dura los dos tramos y el hoyo queda en el segundo golpe", () => {
    const g = flat();
    const before = g.match!.terrain;

    const shot = g.fire("A", BOUNCE)!;
    const r = shot.result.shot;
    const first = r.bounce!;
    expect(shot.weapon).toBe("leapfrog");
    // Es la cuenta del sim, la misma que hace la fantasma.
    expect(r).toEqual(
      simulateWeaponShot3D(before, WEAPONS.leapfrog, { originX: 128, originY: 10, originZ: 128, ...BOUNCE, wind: { x: 0, z: 0 }, shooterId: "A" }, g.match!.tanks, { recordPath: true }),
    );
    expect(r.outcome).toBe("ground");
    expect(r.z).toBeGreaterThan(first.z + 15);
    expect(r.ticks).toBeGreaterThan(first.tick);
    expect(shot.durationMs).toBe(shotDurationMs(r.ticks));
    expect(inv(g, "A").leapfrog).toBe(1); // gastado mientras vuela
    expect(g.match!.terrain).toBe(before); // todavía no cayó
    g.finishShot();

    // Un solo hoyo, y el parche que viaja a los clientes no llega hasta donde picó.
    const after = g.match!.terrain;
    const rect = changedRect(before, after)!;
    expect(terrainHeightAt(after, Math.round(r.x), Math.round(r.z))).toBeLessThan(10 - 3);
    expect(terrainHeightAt(after, Math.round(first.x), Math.round(first.z))).toBe(10);
    expect(Math.round(first.z)).toBeLessThan(rect.z0);
    expect(Math.max(rect.w, rect.d)).toBeLessThanOrEqual(2 * WEAPONS.leapfrog.craterRadius + 3);
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

describe("paso gratis", () => {
  /** Piso plano a 10, A en (100, 128) y B en (200, 128), y un charco pegado a A, del lado de las x: de 108 a 112. */
  function flat() {
    const g = started();
    const terrain = createFlatTerrain(257, 257, 10);
    for (let z = 120; z <= 136; z++) for (let x = 108; x <= 112; x++) terrain.heights[x + z * 257] = 0;
    g.match = { ...g.match!, terrain, tanks: g.match!.tanks.map((t) => ({ ...t, x: t.id === "A" ? 100 : 200, y: 10, z: 128 })) };
    return g;
  }
  const at = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;
  const SHOT = { yaw: 90, pitch: 60, power: 200 }; // corto y para el costado: no le pega a nadie

  it("no pasa de 15, no entra al agua, no gasta nada, y en el segundo turno de la ronda ya no está", () => {
    const g = flat();
    expect(FREE_STEP_RANGE).toBe(15);
    expect(g.turnId).toBe("A");
    expect(g.stepLeft).toBe(true);
    const before = { money: money(g, "A"), inventory: inv(g, "A") };

    expect(g.step("B", { moveTo: { x: 190, z: 128 } })).toBeNull(); // no es su turno
    expect(g.step("A", { moveTo: { x: 100, z: 128 + FREE_STEP_RANGE + 0.5 } })).toBeNull(); // más de 15
    expect(g.step("A", { moveTo: { x: 110, z: 128 } })).toBeNull(); // agua, a 10
    expect(g.step("A", { moveTo: { x: 100 }, x: 100, z: 120 })).toBeNull(); // mensaje roto
    expect(at(g, "A")).toMatchObject({ x: 100, z: 128 });
    expect(g.stepLeft).toBe(true); // un destino rechazado no gasta el paso

    expect(g.step("A", { moveTo: { x: 100, z: 128 - FREE_STEP_RANGE } })).toEqual({ x: 100, y: 10, z: 113 }); // 15 justos
    expect(at(g, "A")).toMatchObject({ x: 100, y: 10, z: 113 });
    expect({ money: money(g, "A"), inventory: inv(g, "A") }).toEqual(before); // ni plata ni nafta
    expect(g.stepLeft).toBe(false);
    expect(g.step("A", { moveTo: { x: 100, z: 120 } })).toBeNull(); // una sola vez
    expect(g.move("A", { moveTo: { x: 100, z: 120 } })).toBeNull(); // y no regala nafta
    expect(g.phase).toBe("aiming"); // el turno sigue con el tiro
    expect(g.fire("A", SHOT)).not.toBeNull();
    g.finishShot();

    // B tiene el suyo en su primer turno; lo deja pasar y tira igual.
    expect(g.turnId).toBe("B");
    expect(g.stepLeft).toBe(true);
    expect(g.fire("B", SHOT)).not.toBeNull();
    g.finishShot();

    // Segundo turno de cada uno: ya no está, ni para el que lo usó ni para el que no (no se guarda).
    for (const id of ["A", "B"]) {
      expect(g.turnId).toBe(id);
      expect(g.stepLeft).toBe(false);
      const { x, z } = at(g, id);
      expect(g.step(id, { moveTo: { x, z: z + 5 } })).toBeNull();
      expect(at(g, id)).toMatchObject({ x, z });
      expect(g.fire(id, SHOT)).not.toBeNull();
      g.finishShot();
    }
  });

  it("vuelve con cada ronda, y al que se le va el reloj en su primer turno lo pierde", () => {
    const g = flat();
    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond(); // A se cuelga sin usarlo
    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond(); // B también
    expect(g.turnId).toBe("A");
    expect(g.stepLeft).toBe(false);
    killAndPass(g, "B");
    g.setReady("A");
    g.setReady("B");
    expect(g.round).toBe(2);
    expect(g.stepLeft).toBe(true);
    const t = at(g, g.turnId!);
    expect(validateMove(g.match!, t.id, { x: t.x, z: t.z }, true).ok).toBe(true);
  });
});

describe("Nafta de la vuelta sin daño", () => {
  const give = (g: Game, id: string, items: object) => {
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, ...items } } : p)) };
  };
  const at = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;
  const fuel = (g: Game) => ["A", "B"].map((id) => inv(g, id).fuel ?? 0);
  /** El del turno lo deja vencer: no tira nadie. */
  const pass = (g: Game) => {
    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond();
  };

  /** Piso plano a 10, sin viento, A en el centro y B donde cae yaw 90 / pitch 45 si sale con potencia 600. Le toca a A. */
  function flat() {
    const g = started();
    const terrain = createFlatTerrain(257, 257, 10);
    g.match = { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: g.match!.tanks.map((t) => ({ ...t, x: 128, y: 10, z: t.id === "A" ? 128 : 128 + 93 })) };
    expect(g.turnId).toBe("A");
    return g;
  }

  it("tras una vuelta sin daño cada tanque vivo tiene una, y se gasta como la de la tienda", () => {
    const g = flat();
    pass(g); // A
    expect(fuel(g)).toEqual([0, 0]); // media vuelta todavía no es una vuelta
    expect(g.takeRefuel()).toEqual([]);
    pass(g); // B
    expect(fuel(g)).toEqual([1, 1]);
    expect(g.takeRefuel().sort()).toEqual(["A", "B"]);
    expect(g.takeRefuel()).toEqual([]); // la sala lo avisa una sola vez
    expect(g.stepLeft).toBe(false); // el paso de 15 no vuelve a mitad de ronda

    expect(g.turnId).toBe("A");
    expect(g.move("B", { moveTo: { x: 128, z: 128 + 80 } })).toBeNull(); // no es su turno
    expect(g.move("A", { moveTo: { x: 128 + FUEL_MOVE_RANGE + 1, z: 128 } })).toBeNull(); // más de 20
    expect(g.move("A", { moveTo: { x: 128 + FUEL_MOVE_RANGE, z: 128 } })).not.toBeNull();
    expect(at(g, "A").x).toBe(128 + FUEL_MOVE_RANGE);
    expect(fuel(g)).toEqual([0, 1]);
    expect(g.move("A", { moveTo: { x: 128, z: 128 } })).toBeNull(); // era una sola
  });

  it("tras una vuelta con daño no hay Nafta; la siguiente, si es quieta, sí", () => {
    const g = flat();
    // La Chispa cae a 3 celdas de B: lo raspa, no lo mata.
    g.match = { ...g.match!, tanks: g.match!.tanks.map((t) => (t.id === "B" ? { ...t, z: t.z + 3 } : t)) };
    expect(g.fire("A", { yaw: 90, pitch: 45, power: dial("babyMissile", 600), weapon: "babyMissile" })).not.toBeNull();
    g.finishShot();
    expect(at(g, "B").life).toBeGreaterThan(0);
    expect(at(g, "B").life).toBeLessThan(100);
    pass(g); // B
    expect(g.turnId).toBe("A"); // vuelta cerrada
    expect(fuel(g)).toEqual([0, 0]);
    expect(g.takeRefuel()).toEqual([]);

    pass(g);
    pass(g);
    expect(fuel(g)).toEqual([1, 1]);
  });

  it("dos vueltas quietas no dejan dos; la que se gastó vuelve, y la que sobró no llega a la tienda", () => {
    const g = flat();
    give(g, "B", { fuel: 1 }); // B ya tenía una comprada
    for (let i = 0; i < 4; i++) pass(g);
    expect(fuel(g)).toEqual([1, 2]); // una regalada cada uno, no dos
    expect(g.takeRefuel().sort()).toEqual(["A", "B"]);

    // A la gasta y la vuelta sigue quieta: a A le vuelve, B se queda con la que tenía.
    expect(g.move("A", { moveTo: { x: 128 + 10, z: 128 } })).not.toBeNull();
    pass(g);
    pass(g);
    expect(fuel(g)).toEqual([1, 2]);
    expect(g.takeRefuel()).toEqual(["A"]);

    killAndPass(g, "A");
    expect(g.phase).toBe("shop");
    expect(fuel(g)).toEqual([0, 1]); // queda la comprada
    expect(g.sell("A", { item: "fuel" })).toBe(false);
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

  /** Juega las 5 rondas: en todas queda vivo solo A. */
  function playedOut(ids = ["A", "B"]) {
    const g = started(11, ids);
    for (let r = 1; r <= 5; r++) {
      if (r > 1) for (const id of ids) g.setReady(id);
      for (const id of ids.slice(1)) killAndPass(g, id);
    }
    expect(g.phase).toBe("ended");
    return g;
  }

  it("revancha: los dos siguen siendo los mismos y todo vuelve al arranque, con terreno nuevo", () => {
    const g = playedOut();
    const seats = g.seats.map((s) => ({ ...s }));
    const terrain = g.match!.terrain;
    expect(money(g, "A")).toBeGreaterThan(MONEY_START);
    g.match = { ...g.match!, players: g.match!.players.map((p) => ({ ...p, inventory: { ...p.inventory, missile: 3, shield: 1 } })) };
    g.board = { ...g.board, A: { points: 80, kills: 1, damage: 30 } };

    expect(g.rematch("B", 99)).toBe(false); // solo el anfitrión
    expect(g.phase).toBe("ended");
    expect(g.rematch("A", 99)).toBe(true);

    expect(g.seats).toEqual(seats); // mismos ids, nombres y colores, en el mismo orden
    expect(g.hostId).toBe("A");
    expect(g.phase).toBe("aiming");
    expect(g.round).toBe(1);
    for (const id of ["A", "B"]) {
      expect(money(g, id)).toBe(MONEY_START);
      expect(inv(g, id)).toEqual(startingInventory());
      expect(g.board[id]).toEqual({ points: 0, kills: 0, damage: 0 });
    }
    expect(g.match!.tanks.every((t) => t.life === 100)).toBe(true);
    expect(g.match!.terrain.heights).not.toEqual(terrain.heights);
    expect(g.winners).toEqual([]);
    expect(g.winnerId).toBeNull();
    expect(g.endReason).toBeNull();
    expect(g.lastRound).toBeNull();
    expect(g.rematch("A", 100)).toBe(false); // ya está en juego
  });

  it("revancha: si alguien se fue, no arranca hasta que haya 2; el asiento del que se fue se suelta", () => {
    const g = playedOut();
    g.removePlayer("B");
    expect(g.rematch("A", 99)).toBe(false);
    expect(g.phase).toBe("ended");
    g.addPlayer("C", "C"); // entra otro con el código
    expect(g.rematch("A", 99)).toBe(true);
    expect(g.seats.map((s) => s.id)).toEqual(["A", "C"]);
    expect(g.match!.tanks.map((t) => t.id).sort()).toEqual(["A", "C"]);
    expect(money(g, "C")).toBe(MONEY_START);

    // De 3, se va uno: quedan 2 y arranca sin él.
    const h = playedOut(["A", "B", "C"]);
    h.removePlayer("C");
    expect(h.rematch("A", 99)).toBe(true);
    expect(h.seats.map((s) => s.id)).toEqual(["A", "B"]);
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
