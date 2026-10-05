import { describe, expect, it } from "vitest";
import {
  applyCraterTerrain,
  createFlatTerrain,
  FUEL_MOVE_RANGE,
  INTEREST_RATE,
  isDug,
  launchPower,
  leaveMound,
  MONEY_PER_ROUND,
  MONEY_START,
  MOUND_TANK_GAP,
  ROUND_MAX_TURNS,
  SCORE_PER_KILL,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  startingInventory,
  SURVIVOR_BONUS,
  TANK_MIN_SEPARATION_3D,
  TANK_START_HEIGHT_MIN,
  terrainHeightAt,
  validateMound,
  validateMove,
  validateSpawn,
  WATER_LEVEL,
  WEAPONS,
  type WeaponId,
} from "@pegaycobra/sim";
import { Game, parseBuyMessage, parseMoveMessage, parseSpawnMessage, SHOP_SECONDS, shotDurationMs, TURN_SECONDS } from "../src/game";
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

  it("la ronda siguiente tiene viento sorteado de nuevo y vida llena, sobre el mismo terreno", () => {
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
      expect(g.match!.terrain).toBe(terrain1); // nadie tiró: el piso es el de la ronda 1
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

describe("el terreno queda de una ronda a la otra", () => {
  // Con esta semilla, A nacería en la ronda 2 sobre un cerro de 40 de alto: el hoyo de un Bombazo ahí
  // no llega al agua y el fondo tiene altura de arranque. Lo único que lo saca es que es un hoyo.
  const SEED = 34;
  const toShop = (g: Game) => killAndPass(g, "B");
  const toNextRound = (g: Game) => {
    g.setReady("A");
    g.setReady("B");
  };
  const tank = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;

  /** Ronda 1: A se para a 40 celdas de `spot`, sin viento, y le tira un Bombazo. Queda en el turno de B. */
  function nukeAt(g: Game, spot: { x: number; z: number }) {
    const terrain = g.match!.terrain;
    const d = Math.hypot(128 - spot.x, 128 - spot.z);
    const from = { x: spot.x + ((128 - spot.x) / d) * 40, z: spot.z + ((128 - spot.z) / d) * 40 };
    g.match = {
      ...g.match!,
      wind: { x: 0, z: 0 },
      tanks: g.match!.tanks.map((t) => (t.id === "A" ? { ...t, ...from, y: terrainHeightAt(terrain, from.x, from.z) } : t)),
      players: g.match!.players.map((p) => (p.id === "A" ? { ...p, inventory: { ...p.inventory, nuke: 1 } } : p)),
    };
    const a = tank(g, "A");
    const yaw = (Math.atan2(spot.z - a.z, spot.x - a.x) * 180) / Math.PI;
    // La potencia la busca el sim, como en los demás tests: la que cae más cerca del punto.
    let best = { power: 0, miss: Infinity };
    for (let power = 100; power <= 1000; power += 5) {
      const r = simulateWeaponShot3D(terrain, WEAPONS.nuke, { originX: a.x, originY: a.y, originZ: a.z, yaw, pitch: 70, power, wind: { x: 0, z: 0 }, shooterId: "A" }, g.match!.tanks);
      const miss = Math.hypot(r.x - spot.x, r.z - spot.z);
      if (r.outcome === "ground" && miss < best.miss) best = { power, miss };
    }
    expect(best.miss).toBeLessThan(3);
    expect(g.turnId).toBe("A");
    expect(g.fire("A", { yaw, pitch: 70, power: best.power, weapon: "nuke" })).not.toBeNull();
    g.finishShot();
  }

  it("un Bombazo en la ronda 1 deja el hoyo, y en la ronda 2 ese hoyo sigue y nadie nace adentro", () => {
    // Dónde nacería A en la ronda 2 si nadie tocara el piso: la misma partida, sin el tiro.
    const untouched = started(SEED);
    toShop(untouched);
    toNextRound(untouched);
    const spot = tank(untouched, "A");

    const g = started(SEED);
    const pristine = g.match!.terrain;
    nukeAt(g, spot);
    const holed = g.match!.terrain;
    const heights = holed.heights.slice();
    const floor = terrainHeightAt(holed, spot.x, spot.z);
    expect(floor).toBeLessThan(terrainHeightAt(pristine, spot.x, spot.z) - 10); // el hoyo
    expect(floor).toBeGreaterThanOrEqual(TANK_START_HEIGHT_MIN);
    expect(isDug(holed, pristine, spot.x, spot.z)).toBe(true);

    toShop(g);
    expect(g.phase).toBe("shop");
    const players = g.match!.players;
    toNextRound(g);
    expect([g.round, g.phase]).toEqual([2, "aiming"]);

    // El mismo heightmap: el hoyo sigue donde estaba y nada más cambió.
    expect(g.match!.terrain).toBe(holed);
    expect(g.match!.terrain.heights).toEqual(heights);
    // La vida vuelve; la plata y el inventario, como salieron de la tienda, más la Nafta de la casa.
    expect(g.match!.tanks.every((t) => t.life === 100)).toBe(true);
    expect(g.match!.players).toEqual(players.map((p) => ({ ...p, inventory: { ...p.inventory, fuel: (p.inventory.fuel ?? 0) + 1 } })));
    // Nadie nace adentro: ni A, que iba ahí, ni B. Firme, apoyados y con la separación de siempre.
    for (const t of g.match!.tanks) {
      expect(isDug(holed, pristine, t.x, t.z)).toBe(false);
      expect(t.y).toBe(terrainHeightAt(holed, t.x, t.z));
      expect(t.y).toBeGreaterThan(WATER_LEVEL);
    }
    expect(Math.hypot(tank(g, "A").x - spot.x, tank(g, "A").z - spot.z)).toBeGreaterThan(WEAPONS.nuke.craterRadius);
    expect(Math.hypot(tank(g, "A").x - tank(g, "B").x, tank(g, "A").z - tank(g, "B").z)).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
  });

  it("la revancha sí genera terreno nuevo, y sus rondas se quedan con ese", () => {
    const g = new Game(TURN_SECONDS, SHOP_SECONDS);
    g.addPlayer("A", "A");
    g.addPlayer("B", "B");
    g.setClock("A", { turn: TURN_SECONDS, shop: SHOP_SECONDS, rounds: 2 });
    g.start("A", SEED);
    nukeAt(g, tank(g, "B")); // el hoyo, donde sea: acá le cae a B
    const holed = g.match!.terrain;
    if (g.phase === "aiming") toShop(g);
    toNextRound(g);
    expect(g.match!.terrain).toBe(holed);
    toShop(g);
    expect(g.phase).toBe("ended");

    expect(g.rematch("A", SEED + 1)).toBe(true);
    const fresh = g.match!.terrain;
    expect(fresh.heights).not.toEqual(holed.heights);
    expect(fresh.heights).toEqual(started(SEED + 1).match!.terrain.heights); // el de una partida recién arrancada
    // Los hoyos de la partida anterior no cuentan: nacen donde nacería cualquiera en ese cerro.
    expect(g.match!.tanks.map(({ x, z }) => ({ x, z }))).toEqual(started(SEED + 1).match!.tanks.map(({ x, z }) => ({ x, z })));
    toShop(g);
    toNextRound(g);
    expect(g.round).toBe(2);
    expect(g.match!.terrain).toBe(fresh);
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

describe("nacimiento elegido en la tienda", () => {
  const tank = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;
  const spot = (p: { x: number; z: number }) => ({ x: p.x, z: p.z });
  const far = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

  /** Una partida en la tienda de la ronda 1. `dig` cava un hoyo antes de que termine la ronda. */
  function inShop(opts: { map?: string; ids?: string[]; rounds?: number; dig?: { x: number; z: number } } = {}) {
    const g = new Game(TURN_SECONDS, SHOP_SECONDS);
    const ids = opts.ids ?? ["A", "B"];
    for (const id of ids) g.addPlayer(id, id);
    if (opts.map) g.setMap("A", opts.map);
    if (opts.rounds) g.setClock("A", { turn: TURN_SECONDS, shop: SHOP_SECONDS, rounds: opts.rounds });
    g.start("A", 34);
    if (opts.dig) {
      const t = g.match!.terrain;
      g.match = { ...g.match!, terrain: applyCraterTerrain(t, opts.dig.x, terrainHeightAt(t, opts.dig.x, opts.dig.z), opts.dig.z, WEAPONS.missile.craterRadius) };
    }
    for (const id of ids.slice(1)) g.match = { ...g.match!, tanks: g.match!.tanks.map((t) => (t.id === id ? { ...t, life: 0 } : t)) };
    killAndPass(g, ids[1]!);
    expect(g.phase).toBe("shop");
    return g;
  }
  const toNextRound = (g: Game) => {
    for (const s of g.connectedSeats) g.setReady(s.id);
  };
  /**
   * Un punto donde `id` puede nacer, a más de 30 celdas de donde lo dejó el sorteo: no es el mismo por
   * casualidad. Con `floor`, a esa altura o más (un hoyo ahí no llega al agua).
   */
  function freeSpot(g: Game, id: string, floor = 0): { x: number; z: number } {
    const { terrain } = g.match!;
    for (let z = 20.5; z < terrain.depth - 20; z += 7) {
      for (let x = 20.5; x < terrain.width - 20; x += 7) {
        if (terrainHeightAt(terrain, x, z) < floor || far({ x, z }, g.spawns.get(id)!) <= 30) continue;
        if (validateSpawn(terrain, g.pristine!, { x, z }, g.spawnRivals(id)).ok) return { x, z };
      }
    }
    throw new Error("no hay dónde");
  }

  it("al abrir la tienda cada uno tiene el nacimiento del sorteo; si nadie elige, la ronda 2 abre ahí, como siempre", () => {
    const g = inShop();
    const drawn = { A: { ...g.spawns.get("A")! }, B: { ...g.spawns.get("B")! } };
    expect([drawn.A.picked, drawn.B.picked]).toEqual([false, false]);
    expect(far(drawn.A, drawn.B)).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
    toNextRound(g);
    expect([g.round, g.phase]).toEqual([2, "aiming"]);
    expect(spot(tank(g, "A"))).toEqual(spot(drawn.A));
    expect(spot(tank(g, "B"))).toEqual(spot(drawn.B));
    expect(g.spawns.size).toBe(0); // fuera de la tienda no hay nacimientos pendientes
  });

  it("A elige un punto: queda marcado como suyo, y en la ronda 2 nace ahí, apoyado; B, donde lo dejó el sorteo, con el mismo viento", () => {
    const untouched = inShop();
    toNextRound(untouched);

    const g = inShop();
    const drawnB = spot(g.spawns.get("B")!);
    const at = freeSpot(g, "A");
    expect(g.chooseSpawn("A", { at })).toBe(true);
    expect(g.spawns.get("A")).toEqual({ ...at, picked: true });
    expect(g.spawns.get("B")).toEqual({ ...drawnB, picked: false });
    // Se puede cambiar hasta que cierre la tienda, también después de dar el listo.
    g.setReady("A");
    const again = { x: at.x + 2, z: at.z };
    expect(g.chooseSpawn("A", { at: again })).toBe(true);
    expect(g.chooseSpawn("A", { at })).toBe(true);

    const heights = g.match!.terrain.heights.slice();
    g.setReady("B");
    expect([g.round, g.phase]).toEqual([2, "aiming"]);
    expect(tank(g, "A")).toMatchObject({ ...at, y: terrainHeightAt(g.match!.terrain, at.x, at.z), life: 100 });
    expect(spot(tank(g, "B"))).toEqual(drawnB);
    expect(spot(tank(g, "B"))).toEqual(spot(tank(untouched, "B")));
    expect(g.match!.wind).toEqual(untouched.match!.wind);
    expect(g.match!.terrain.heights).toEqual(heights); // elegir no toca el piso
    // El cañón arranca mirando al centro desde donde nació.
    const yaw = ((Math.atan2(128 - at.z, 128 - at.x) * 180) / Math.PI + 360) % 360;
    expect(g.aims.get("A")!.yaw).toBeCloseTo(yaw, 6);
  });

  it("el server rechaza el agua, el borde y la basura, y queda el nacimiento que tenía", () => {
    const g = inShop({ map: "island" });
    const before = { ...g.spawns.get("A")! };
    const water = { x: 6, z: 128 };
    expect(terrainHeightAt(g.match!.terrain, water.x, water.z)).toBeLessThanOrEqual(WATER_LEVEL);
    expect(g.chooseSpawn("A", { at: water })).toBe(false);
    expect(g.chooseSpawn("A", { at: { x: 1, z: 128 } })).toBe(false);
    expect(g.chooseSpawn("A", { at: { x: 128, z: 400 } })).toBe(false);
    for (const bad of [null, {}, { at: null }, { at: { x: "128", z: 128 } }, { at: { x: NaN, z: 128 } }, { moveTo: { x: 128, z: 128 } }, "128,128"]) {
      expect(g.chooseSpawn("A", bad), JSON.stringify(bad)).toBe(false);
    }
    expect(g.chooseSpawn("nadie", { at: freeSpot(g, "A") })).toBe(false);
    expect(g.spawns.get("A")).toEqual(before);
    expect(parseSpawnMessage({ at: { x: 3, z: 4, y: 99 }, damage: 1 })).toEqual({ x: 3, z: 4 });
    toNextRound(g);
    expect(spot(tank(g, "A"))).toEqual(spot(before));
  });

  it("el server rechaza un hoyo: el mismo punto valía con el piso sano", () => {
    // Un punto firme cualquiera de la partida, lejos de donde el sorteo deja a los dos.
    const probe = inShop();
    const hole = freeSpot(probe, "A", 25);
    expect(probe.chooseSpawn("A", { at: hole })).toBe(true);

    const g = inShop({ dig: hole });
    expect(g.spawns.get("B")).toEqual(probe.spawns.get("B")); // el hoyo no movió el sorteo
    expect(isDug(g.match!.terrain, g.pristine!, hole.x, hole.z)).toBe(true);
    expect(terrainHeightAt(g.match!.terrain, hole.x, hole.z)).toBeGreaterThan(WATER_LEVEL); // hoyo seco: no es por el agua
    const before = { ...g.spawns.get("A")! };
    expect(g.chooseSpawn("A", { at: hole })).toBe(false);
    expect(g.spawns.get("A")).toEqual(before);
    // Afuera del hoyo, a un paso del borde, vale.
    expect(g.chooseSpawn("A", { at: { x: hole.x + WEAPONS.missile.craterRadius + 2, z: hole.z } })).toBe(true);
  });

  it(`el server rechaza un punto a menos de ${TANK_MIN_SEPARATION_3D} celdas de donde nace el otro, sea del sorteo o elegido`, () => {
    const g = inShop();
    const b = spot(g.spawns.get("B")!);
    // Alrededor de B, el primer rumbo donde el piso vale a 59 y a 61 celdas: lo único que cambia es la distancia.
    const ok = (p: { x: number; z: number }) => validateSpawn(g.match!.terrain, g.pristine!, p, []).ok;
    const ring = (deg: number, r: number) => ({ x: b.x + Math.cos((deg * Math.PI) / 180) * r, z: b.z + Math.sin((deg * Math.PI) / 180) * r });
    const deg = Array.from({ length: 72 }, (_, i) => i * 5).find((d) => ok(ring(d, TANK_MIN_SEPARATION_3D - 1)) && ok(ring(d, TANK_MIN_SEPARATION_3D + 1)))!;
    expect(deg).toBeDefined();
    const before = { ...g.spawns.get("A")! };
    expect(g.chooseSpawn("A", { at: ring(deg, TANK_MIN_SEPARATION_3D - 1) })).toBe(false);
    expect(g.chooseSpawn("A", { at: b })).toBe(false);
    expect(g.spawns.get("A")).toEqual(before);
    const near = ring(deg, TANK_MIN_SEPARATION_3D + 1);
    expect(g.chooseSpawn("A", { at: near })).toBe(true);

    // Ahora el que tiene que quedar lejos es B, del punto que eligió A. Y su propio lugar viejo no le estorba.
    expect(g.chooseSpawn("B", { at: { x: near.x + 3, z: near.z } })).toBe(false);
    expect(g.spawns.get("B")).toEqual({ ...b, picked: false });
    const back = ring(deg, -2); // dos celdas para el otro lado: pegado a donde estaba, lejos de A
    expect(g.chooseSpawn("B", { at: back })).toBe(ok(back));
    toNextRound(g);
    expect(far(tank(g, "A"), tank(g, "B"))).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
  });

  it("solo en la tienda: en la ronda 1 no se elige, y la revancha sortea de nuevo en su terreno", () => {
    const first = started(34);
    expect(first.spawns.size).toBe(0);
    expect(first.chooseSpawn("A", { at: spot(tank(first, "A")) })).toBe(false); // la ronda 1 se sortea

    const g = inShop({ rounds: 2 });
    const at = freeSpot(g, "A");
    expect(g.chooseSpawn("A", { at })).toBe(true);
    toNextRound(g);
    expect(spot(tank(g, "A"))).toEqual(at);
    expect(g.chooseSpawn("A", { at: freeSpot(inShop(), "A") })).toBe(false); // jugando, tampoco
    killAndPass(g, "B");
    expect(g.phase).toBe("ended"); // la última ronda no tiene tienda: no hay nada que elegir
    expect(g.spawns.size).toBe(0);
    expect(g.chooseSpawn("A", { at })).toBe(false);

    expect(g.rematch("A", 35)).toBe(true);
    expect(g.spawns.size).toBe(0);
    expect(g.match!.tanks.map(spot)).toEqual(started(35).match!.tanks.map(spot)); // lo elegido en la partida anterior no pasa
  });

  it("el que se fue no cuenta: su nacimiento no le saca lugar a nadie, y nace muerto donde lo dejó el sorteo", () => {
    const g = inShop({ ids: ["A", "B", "C"] });
    const c = spot(g.spawns.get("C")!);
    expect(g.chooseSpawn("A", { at: c })).toBe(false); // mientras está, a 60 de él
    g.removePlayer("C");
    expect(g.phase).toBe("shop");
    expect(g.spawnRivals("A")).toEqual([g.spawns.get("B")]);
    expect(g.chooseSpawn("A", { at: c })).toBe(true);
    toNextRound(g);
    expect(g.round).toBe(2);
    expect(tank(g, "C")).toMatchObject({ ...c, life: 0 });
    expect(tank(g, "A")).toMatchObject({ ...c, life: 100 });
  });
});

describe("loma dejada en la tienda", () => {
  const SEED = 34;
  const PRICE = SHOP_ITEMS.dirt.price;
  /** Lo que sube el centro: el radio entero del disco, trunc(radius) + 1. */
  const R = Math.trunc(WEAPONS.dirt.mound!.radius) + 1;
  const tank = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;
  const give = (g: Game, id: string, patch: { money?: number; dirt?: number }) => {
    g.match = {
      ...g.match!,
      players: g.match!.players.map((p) => (p.id === id ? { ...p, money: patch.money ?? p.money, inventory: { ...p.inventory, dirt: patch.dirt ?? p.inventory.dirt ?? 0 } } : p)),
    };
  };

  /** Una partida en la tienda de la ronda 1: B murió, A sobrevivió y nadie tocó el piso. */
  function inShop(opts: { map?: string; rounds?: number } = {}) {
    const g = new Game(TURN_SECONDS, SHOP_SECONDS);
    g.addPlayer("A", "A");
    g.addPlayer("B", "B");
    if (opts.map) g.setMap("A", opts.map);
    if (opts.rounds) g.setClock("A", { turn: TURN_SECONDS, shop: SHOP_SECONDS, rounds: opts.rounds });
    g.start("A", SEED);
    killAndPass(g, "B");
    expect(g.phase).toBe("shop");
    return g;
  }
  const toNextRound = (g: Game) => {
    g.setReady("A");
    g.setReady("B");
  };
  /** Un punto donde vale dejar una loma: firme, con el piso a `floor` o más, lejos de los tanques y de `avoid`. */
  function freeSpot(g: Game, floor = 8, avoid: { x: number; z: number }[] = []): { x: number; z: number } {
    const { terrain, tanks } = g.match!;
    for (let z = 40.5; z < terrain.depth - 40; z += 9) {
      for (let x = 40.5; x < terrain.width - 40; x += 9) {
        if (terrainHeightAt(terrain, x, z) < floor || avoid.some((p) => Math.hypot(p.x - x, p.z - z) < 40)) continue;
        if (validateMound(terrain, tanks, { x, z }).ok) return { x, z };
      }
    }
    throw new Error("no hay dónde");
  }

  it("A deja la loma con la Tierra que tenía: el piso sube ya, no paga, y la ronda 2 se juega con esa loma", () => {
    const untouched = inShop();
    toNextRound(untouched);

    const g = inShop();
    give(g, "A", { dirt: 1 });
    const before = g.match!.terrain;
    const pristine = g.pristine!.heights.slice();
    const spawns = [...g.spawns];
    const cash = money(g, "A");
    const at = freeSpot(g);
    const floor = terrainHeightAt(before, at.x, at.z);

    expect(g.leaveMound("A", { at })).toEqual({ ...at, y: floor });
    // Ya, con la tienda abierta: el heightmap de la partida es otro, y lo único que cambió es el disco de la loma.
    expect(g.phase).toBe("shop");
    const after = g.match!.terrain;
    expect(after.heights).toEqual(leaveMound(before, g.match!.tanks, at).heights);
    const rect = changedRect(before, after)!;
    const [cx, cz] = [Math.trunc(at.x), Math.trunc(at.z)];
    expect(rect.x0).toBeGreaterThanOrEqual(cx - R + 1);
    expect(rect.z0).toBeGreaterThanOrEqual(cz - R + 1);
    expect(rect.x0 + rect.w).toBeLessThanOrEqual(cx + R);
    expect(rect.z0 + rect.d).toBeLessThanOrEqual(cz + R);
    expect(after.heights.every((h, i) => h >= before.heights[i]!)).toBe(true);
    expect(terrainHeightAt(after, at.x, at.z)).toBeGreaterThan(floor + R - 2);
    // Salió del inventario: no paga. El terreno de la ronda 1 y los nacimientos no se tocan.
    expect(inv(g, "A").dirt).toBe(0);
    expect(money(g, "A")).toBe(cash);
    expect(g.pristine!.heights).toEqual(pristine);
    expect([...g.spawns]).toEqual(spawns);
    expect(tank(g, "A").y).toBe(terrainHeightAt(after, tank(g, "A").x, tank(g, "A").z)); // el que quedó en pie no quedó enterrado

    toNextRound(g);
    expect([g.round, g.phase]).toEqual([2, "aiming"]);
    // La ronda 2 se juega sobre ese mismo heightmap: la loma sigue ahí, y lo demás es la ronda de siempre.
    expect(g.match!.terrain).toBe(after);
    expect(terrainHeightAt(g.match!.terrain, at.x, at.z)).toBeGreaterThan(floor + R - 2);
    expect(g.match!.wind).toEqual(untouched.match!.wind);
    expect(g.match!.tanks.map(({ x, z }) => ({ x, z }))).toEqual(untouched.match!.tanks.map(({ x, z }) => ({ x, z })));
    for (const t of g.match!.tanks) expect(t.y).toBe(terrainHeightAt(after, t.x, t.z));
    expect(inv(g, "A").dirt).toBe(0);
    // Y sigue en la ronda 3: es terreno, como un hoyo.
    killAndPass(g, "B");
    toNextRound(g);
    expect(g.round).toBe(3);
    expect(g.match!.terrain).toBe(after);
  });

  it("sin Tierra la compra y la usa en el mismo gesto: paga el precio de la carta y no le queda ninguna; si no le alcanza, nada", () => {
    const g = inShop();
    const at = freeSpot(g);
    expect(inv(g, "A").dirt ?? 0).toBe(0);
    const cash = money(g, "A");
    expect(cash).toBeGreaterThanOrEqual(PRICE);
    const before = g.match!.terrain;
    expect(g.leaveMound("A", { at })).not.toBeNull();
    expect(money(g, "A")).toBe(cash - PRICE);
    expect(inv(g, "A").dirt).toBe(0);
    expect(g.match!.terrain).not.toBe(before);

    // A B le falta un peso: no hay loma, no paga y puede probar de nuevo cuando le alcance.
    give(g, "B", { money: PRICE - 1 });
    const mounded = g.match!.terrain;
    const other = freeSpot(g, 8, [at]);
    expect(g.leaveMound("B", { at: other })).toBeNull();
    expect(g.match!.terrain).toBe(mounded);
    expect(money(g, "B")).toBe(PRICE - 1);
    give(g, "B", { money: PRICE });
    expect(g.leaveMound("B", { at: other })).not.toBeNull();
    expect(money(g, "B")).toBe(0);
    expect(inv(g, "B").dirt).toBe(0);
    // Las dos quedaron: la de B no pisó la de A.
    expect(terrainHeightAt(g.match!.terrain, at.x, at.z)).toBe(terrainHeightAt(mounded, at.x, at.z));
    expect(terrainHeightAt(g.match!.terrain, other.x, other.z)).toBeGreaterThan(terrainHeightAt(mounded, other.x, other.z));
  });

  it("una por tienda cada uno: la segunda se ignora aunque tenga Tierra y plata, y en la tienda siguiente vuelve", () => {
    const g = inShop();
    give(g, "A", { dirt: 3 });
    const at = freeSpot(g);
    expect(g.mounded.size).toBe(0);
    expect(g.leaveMound("A", { at })).not.toBeNull();
    expect([...g.mounded]).toEqual(["A"]);
    const once = g.match!.terrain;
    const cash = money(g, "A");
    const other = freeSpot(g, 8, [at]);
    expect(g.leaveMound("A", { at: other })).toBeNull();
    expect(g.leaveMound("A", { at })).toBeNull();
    expect(g.match!.terrain).toBe(once);
    expect(inv(g, "A").dirt).toBe(2);
    expect(money(g, "A")).toBe(cash);
    // El listo no la cierra para el otro: B deja la suya hasta que la tienda cierre.
    g.setReady("A");
    expect(g.leaveMound("B", { at: other })).not.toBeNull();

    toNextRound(g);
    expect(g.round).toBe(2);
    expect(g.mounded.size).toBe(0);
    killAndPass(g, "B");
    expect(g.phase).toBe("shop");
    const third = freeSpot(g, 8, [at, other]);
    expect(g.leaveMound("A", { at: third })).not.toBeNull();
    expect(inv(g, "A").dirt).toBe(1);
  });

  it("el server rechaza el agua, el borde, la basura y un punto sobre un tanque: no sube nada y no gasta", () => {
    const g = inShop({ map: "island" });
    give(g, "A", { dirt: 1 });
    const before = g.match!.terrain;
    const cash = money(g, "A");
    const water = { x: 6, z: 128 };
    expect(terrainHeightAt(before, water.x, water.z)).toBeLessThanOrEqual(WATER_LEVEL);
    expect(g.leaveMound("A", { at: water })).toBeNull();
    expect(g.leaveMound("A", { at: { x: 1, z: 128 } })).toBeNull();
    expect(g.leaveMound("A", { at: { x: 128, z: 400 } })).toBeNull();
    for (const bad of [null, {}, { at: null }, { at: { x: "128", z: 128 } }, { at: { x: NaN, z: 128 } }, { moveTo: { x: 128, z: 128 } }, "128,128"]) {
      expect(g.leaveMound("A", bad), JSON.stringify(bad)).toBeNull();
    }
    // Sobre un tanque, esté vivo (A, que sobrevivió) o no (B): ni encima ni con el disco tocándolo.
    for (const id of ["A", "B"]) {
      const t = tank(g, id);
      expect(g.leaveMound("A", { at: { x: t.x, z: t.z } }), id).toBeNull();
      expect(g.leaveMound("A", { at: { x: Math.trunc(t.x) + MOUND_TANK_GAP - 2, z: Math.trunc(t.z) } }), id).toBeNull();
    }
    expect(g.leaveMound("nadie", { at: freeSpot(g) })).toBeNull();
    expect(g.match!.terrain).toBe(before);
    expect(inv(g, "A").dirt).toBe(1);
    expect(money(g, "A")).toBe(cash);
    expect(g.mounded.size).toBe(0);
    // Nada de eso le gastó la de esta tienda: un punto que vale, entra.
    expect(g.leaveMound("A", { at: freeSpot(g) })).not.toBeNull();
    expect(inv(g, "A").dirt).toBe(0);
  });

  it("el que elige nacer sobre la loma nace apoyado arriba, más alto que el piso de antes", () => {
    const g = inShop();
    give(g, "A", { dirt: 1 });
    // Un punto donde A puede nacer y además dejar la loma.
    let at: { x: number; z: number } | null = null;
    for (let z = 40.5; z < 217 && !at; z += 9) {
      for (let x = 40.5; x < 217 && !at; x += 9) {
        const here = { x, z };
        if (validateMound(g.match!.terrain, g.match!.tanks, here).ok && validateSpawn(g.match!.terrain, g.pristine!, here, g.spawnRivals("A")).ok) at = here;
      }
    }
    expect(at).not.toBeNull();
    const floor = terrainHeightAt(g.match!.terrain, at!.x, at!.z);
    expect(g.chooseSpawn("A", { at })).toBe(true);
    expect(g.leaveMound("A", { at })).not.toBeNull();
    expect(g.spawns.get("A")).toEqual({ ...at!, picked: true }); // la loma no le corre la estaca
    // Y al revés también vale: con la loma ya puesta, ese punto sigue siendo piso firme y no es hoyo.
    expect(g.chooseSpawn("A", { at })).toBe(true);
    toNextRound(g);
    const a = tank(g, "A");
    expect(a).toMatchObject({ ...at!, life: 100 });
    expect(a.y).toBe(terrainHeightAt(g.match!.terrain, at!.x, at!.z));
    expect(a.y).toBeGreaterThan(floor + R - 2);
  });

  it("solo en la tienda: jugando o con la partida terminada se ignora, y la revancha arranca en un cerro nuevo, sin la loma", () => {
    const first = started(SEED);
    give(first, "A", { dirt: 1 });
    const ground = first.match!.terrain;
    expect(first.leaveMound("A", { at: { x: 128, z: 128 } })).toBeNull(); // la ronda 1 no tiene tienda antes
    expect(first.match!.terrain).toBe(ground);
    expect(inv(first, "A").dirt).toBe(1);

    const g = inShop({ rounds: 2 });
    const at = freeSpot(g);
    expect(g.leaveMound("A", { at })).not.toBeNull();
    const mounded = g.match!.terrain;
    toNextRound(g);
    expect(g.leaveMound("B", { at: freeSpot(g, 8, [at]) })).toBeNull(); // jugando, tampoco
    killAndPass(g, "B");
    expect(g.phase).toBe("ended"); // la última ronda no tiene tienda
    expect(g.leaveMound("B", { at: freeSpot(g, 8, [at]) })).toBeNull();
    expect(g.match!.terrain).toBe(mounded);

    expect(g.rematch("A", SEED + 1)).toBe(true);
    expect(g.mounded.size).toBe(0);
    expect(g.match!.terrain.heights).toEqual(started(SEED + 1).match!.terrain.heights); // el de una partida recién arrancada
    expect(g.pristine).toBe(g.match!.terrain);
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
    // Es su primer turno de la ronda: la de la casa y dos compradas.
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, fuel: 3 } } : p)) };
    const t = g.match!.tanks.find((tk) => tk.id === id)!;
    return { g, id, t };
  }

  it("mueve el tanque antes de tirar y gasta una carga; de las suyas, una por turno", () => {
    const { g, id, t } = fueled();
    const to = { x: t.x + 10, z: t.z };
    const moved = g.move(id, { moveTo: to });
    expect(moved).not.toBeNull();
    expect(g.match!.tanks.find((tk) => tk.id === id)!.x).toBeCloseTo(t.x + 10, 5);
    expect(inv(g, id).fuel).toBe(2); // salió la de la casa, que no cuenta
    expect(g.move(id, { moveTo: { x: t.x + 12, z: t.z } })).not.toBeNull();
    expect(inv(g, id).fuel).toBe(1);
    expect(g.move(id, { moveTo: { x: t.x + 10, z: t.z } })).toBeNull(); // segunda de las suyas en el turno
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

describe("Nafta de la casa", () => {
  const give = (g: Game, id: string, items: object) => {
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === id ? { ...p, inventory: { ...p.inventory, ...items } } : p)) };
  };
  /** Piso plano a 10, A en (100, 128) y B en (200, 128), y un charco pegado a A, del lado de las x: de 108 a 112. */
  function flat() {
    const g = started();
    const terrain = createFlatTerrain(257, 257, 10);
    for (let z = 120; z <= 136; z++) for (let x = 108; x <= 112; x++) terrain.heights[x + z * 257] = 0;
    g.match = { ...g.match!, terrain, tanks: g.match!.tanks.map((t) => ({ ...t, x: t.id === "A" ? 100 : 200, y: 10, z: 128 })) };
    return g;
  }
  const at = (g: Game, id: string) => g.match!.tanks.find((t) => t.id === id)!;
  const fuel = (g: Game) => ["A", "B"].map((id) => inv(g, id).fuel ?? 0);
  const SHOT = { yaw: 90, pitch: 60, power: 200 }; // corto y para el costado: no le pega a nadie
  /** Le saca un punto de vida a mano: la vuelta deja de ser quieta y no cae la Nafta de arriba, que acá no se mira. */
  const scratch = (g: Game, id: string) => {
    g.match = { ...g.match!, tanks: g.match!.tanks.map((t) => (t.id === id ? { ...t, life: t.life - 1 } : t)) };
  };

  it("en el primer turno hay una Nafta de la casa, en el segundo no, y no se puede vender", () => {
    const g = flat();
    expect(g.turnId).toBe("A");
    expect(fuel(g)).toEqual([1, 1]); // una cada uno, sin haber comprado nada
    expect(g.houseLeft).toBe(true);
    const wallet = money(g, "A");
    expect(g.sell("A", { item: "fuel" })).toBe(false); // en la ronda no hay tienda
    expect(fuel(g)).toEqual([1, 1]);

    // Las reglas de la comprada: su turno, hasta 20, piso firme.
    expect(g.move("B", { moveTo: { x: 190, z: 128 } })).toBeNull(); // no es su turno
    expect(g.move("A", { moveTo: { x: 100, z: 128 + FUEL_MOVE_RANGE + 0.5 } })).toBeNull(); // más de 20
    expect(g.move("A", { moveTo: { x: 110, z: 128 } })).toBeNull(); // agua, a 10
    expect(g.move("A", { moveTo: { x: 100 }, x: 100, z: 120 })).toBeNull(); // mensaje roto
    expect(g.fire("A", { ...SHOT, weapon: "nuke" })).toBeNull(); // un tiro que no vale tampoco se la lleva
    expect(at(g, "A")).toMatchObject({ x: 100, z: 128 });
    expect(g.houseLeft).toBe(true); // nada de eso la gasta
    expect(fuel(g)).toEqual([1, 1]);

    expect(g.move("A", { moveTo: { x: 100, z: 128 - FUEL_MOVE_RANGE } })).toEqual({ x: 100, y: 10, z: 108 }); // 20 justos
    expect(at(g, "A")).toMatchObject({ x: 100, y: 10, z: 108 });
    expect(fuel(g)).toEqual([0, 1]);
    expect(money(g, "A")).toBe(wallet); // no costó nada
    expect(g.houseLeft).toBe(false);
    expect(g.move("A", { moveTo: { x: 100, z: 120 } })).toBeNull(); // era una sola
    expect(g.phase).toBe("aiming"); // el turno sigue con el tiro
    expect(g.fire("A", SHOT)).not.toBeNull();
    g.finishShot();

    // B tiene la suya en su primer turno. Tira sin usarla: se pierde con el tiro.
    expect(g.turnId).toBe("B");
    expect(g.houseLeft).toBe(true);
    scratch(g, "B");
    expect(g.fire("B", SHOT)).not.toBeNull();
    expect(fuel(g)).toEqual([0, 0]);
    g.finishShot();

    // Segundo turno: ya no está, ni para el que la usó ni para el que no (no se guarda).
    expect(g.turnId).toBe("A");
    expect(g.houseLeft).toBe(false);
    expect(fuel(g)).toEqual([0, 0]);
    expect(g.move("A", { moveTo: { x: 100, z: 100 } })).toBeNull();
    expect(at(g, "A")).toMatchObject({ x: 100, z: 108 });

    // Y en la tienda no hay nada que vender: ninguna llegó.
    killAndPass(g, "B");
    expect(g.phase).toBe("shop");
    expect(fuel(g)).toEqual([0, 0]);
    for (const id of ["A", "B"]) {
      const before = money(g, id);
      expect(g.sell(id, { item: "fuel" })).toBe(false);
      expect(money(g, id)).toBe(before);
    }
  });

  it("la comprada se suma: en el primer turno se gastan las dos, la de la casa primero; sin usar, queda la comprada", () => {
    const g = flat();
    give(g, "A", { fuel: 3 }); // la de la casa y dos compradas
    give(g, "B", { fuel: 2 }); // la de la casa y una comprada

    expect(g.move("A", { moveTo: { x: 100, z: 120 } })).not.toBeNull();
    expect(fuel(g)).toEqual([2, 2]);
    expect(g.houseLeft).toBe(false); // salió la de la casa
    expect(g.movedThisTurn).toBe(false); // y no cuenta como el movimiento del turno
    expect(g.move("A", { moveTo: { x: 100, z: 110 } })).not.toBeNull();
    expect(fuel(g)).toEqual([1, 2]);
    expect(g.movedThisTurn).toBe(true);
    expect(g.move("A", { moveTo: { x: 100, z: 100 } })).toBeNull(); // de las suyas, una por turno
    expect(at(g, "A")).toMatchObject({ x: 100, z: 110 });
    expect(g.fire("A", SHOT)).not.toBeNull();
    g.finishShot();
    expect(fuel(g)).toEqual([1, 2]);

    // B no se mueve: pierde la de la casa y se queda con la que compró.
    scratch(g, "B");
    expect(g.fire("B", SHOT)).not.toBeNull();
    g.finishShot();
    expect(fuel(g)).toEqual([1, 1]);

    // Esa sí llega a la tienda y se vende.
    killAndPass(g, "B");
    expect(g.phase).toBe("shop");
    expect(fuel(g)).toEqual([1, 1]);
    expect(g.sell("B", { item: "fuel" })).toBe(true);
    expect(fuel(g)).toEqual([1, 0]);
  });

  it("vuelve con cada ronda, y al que se le va el reloj en su primer turno la pierde", () => {
    const g = flat();
    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond(); // A se cuelga sin usarla
    expect(fuel(g)).toEqual([0, 1]);
    scratch(g, "B");
    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond(); // B también
    expect(g.turnId).toBe("A");
    expect(g.houseLeft).toBe(false);
    expect(fuel(g)).toEqual([0, 0]);
    killAndPass(g, "B");
    g.setReady("A");
    g.setReady("B");
    expect(g.round).toBe(2);
    expect(g.houseLeft).toBe(true);
    expect(fuel(g)).toEqual([1, 1]);
    const t = at(g, g.turnId!);
    expect(validateMove(g.match!, t.id, { x: t.x, z: t.z }).ok).toBe(true);
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
    expect(fuel(g)).toEqual([0, 1]); // media vuelta todavía no es una vuelta: B tiene la de la casa, que se le va con su turno
    expect(g.takeRefuel()).toEqual([]);
    pass(g); // B
    expect(fuel(g)).toEqual([1, 1]);
    expect(g.takeRefuel().sort()).toEqual(["A", "B"]);
    expect(g.takeRefuel()).toEqual([]); // la sala lo avisa una sola vez
    expect(g.houseLeft).toBe(false); // la de la casa no vuelve a mitad de ronda

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
    give(g, "B", { fuel: 2 }); // B ya tenía una comprada, además de la de la casa
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
      expect(inv(g, id)).toEqual({ ...startingInventory(), fuel: 1 }); // lo del arranque y la Nafta de la casa
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
