// El bot: cómo elige el tiro, la compra, la nafta y dónde nacer (sin red) y una sala real con un solo cliente humano.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker, type Server } from "@colyseus/core";
import {
  createFlatTerrain,
  createRng,
  FUEL_MOVE_RANGE,
  isAlive,
  MONEY_START,
  onShore,
  resolveTurn3D,
  SHOP_ITEMS,
  TANK_MIN_SEPARATION_3D,
  terrainHeightAt,
  validateSpawn,
  type MatchState3D,
} from "@pegaycobra/sim";
import { BOT_NAME, BOT_SAMPLES, botCandidates, botMovePick, botShopPick, botSpawnPick, pickBotShot } from "../src/bot";
import { Game } from "../src/game";
import { createServer, ROOM_NAME } from "../src/server";
import { GameRoom } from "../src/room";
import type { TerrainMessage } from "../src/terrain-net";

describe("decisiones del bot", () => {
  function started() {
    const g = new Game();
    g.addPlayer("A", "Ana");
    g.addPlayer("B", BOT_NAME);
    g.start("A", 7);
    return g;
  }

  it("prueba 24 punterías con el sim y se queda con la que cae más cerca del rival", () => {
    const g = started();
    const all = botCandidates(g.match!, "B", createRng(1));
    const pick = pickBotShot(g.match!, "B", createRng(1))!;
    expect(all).toHaveLength(BOT_SAMPLES);
    expect(all).toContainEqual(pick);
    expect(pick.landed).toBe(true);
    const clear = all.filter((c) => c.landed && !c.blocked);
    expect(pick.miss).toBe(Math.min(...(clear.length ? clear : all.filter((c) => c.landed)).map((c) => c.miss)));
    // El giro queda cerca del rumbo al rival, y no son 24 veces el mismo tiro.
    expect(Math.max(...all.map((c) => c.yaw)) - Math.min(...all.map((c) => c.yaw))).toBeLessThanOrEqual(16);
    expect(new Set(all.map((c) => c.power)).size).toBe(BOT_SAMPLES);
    expect(new Set(all.map((c) => c.yaw)).size).toBe(BOT_SAMPLES);
  });

  // Piso plano con un cerro de pared a pared entre el bot (x = 60) y Ana (x = 200).
  const HILL_X0 = 180;
  const HILL_X1 = 192;
  function behindHill(): MatchState3D {
    const g = started();
    const terrain = createFlatTerrain(257, 257, 10);
    for (let z = 0; z < 257; z++) for (let x = HILL_X0; x <= HILL_X1; x++) terrain.heights[x + z * 257] = 45;
    const at = (id: string, x: number) => ({ ...g.match!.tanks.find((t) => t.id === id)!, x, y: 10, z: 128 });
    return { ...g.match!, terrain, wind: { x: 0, z: 0 }, tanks: [at("A", 200), at("B", 60)] };
  }

  it("con un cerro en el medio no elige el tiro que pega en el cerro si otro lo pasa", () => {
    const m = behindHill();
    const all = botCandidates(m, "B", createRng(1));
    const clear = all.filter((c) => c.landed && !c.blocked);
    const onHill = all.filter((c) => c.blocked);
    const pick = pickBotShot(m, "B", createRng(1))!;
    // Hay tiros que pasan el cerro, y el que cae más cerca de Ana de todos se queda en el cerro.
    expect(clear.length).toBeGreaterThan(0);
    expect(Math.min(...onHill.map((c) => c.miss))).toBeLessThan(Math.min(...clear.map((c) => c.miss)));
    expect(pick.blocked).toBe(false);
    expect(pick.miss).toBe(Math.min(...clear.map((c) => c.miss)));
    // Dónde cae el elegido según Game.fire: del otro lado del cerro.
    const g = started();
    g.match = m;
    g.tickSecond();
    for (let i = 0; i < 29; i++) g.tickSecond();
    expect(g.fire("B", pick)!.result.shot.x).toBeGreaterThan(HILL_X1);
  });

  it("si ninguna puntería pasa el cerro, tira la menos mala", () => {
    const m = behindHill();
    const all = botCandidates(m, "B", createRng(25));
    expect(all.some((c) => c.landed && !c.blocked)).toBe(false);
    const pick = pickBotShot(m, "B", createRng(25))!;
    expect(pick.landed).toBe(true);
    expect(pick.miss).toBe(Math.min(...all.filter((c) => c.landed).map((c) => c.miss)));
  });

  // Piso plano sin viento, el bot en x = 60 y Ana en x = 110, los dos a la altura `ground`.
  function onGround(ground: number, inventory: object): MatchState3D {
    const g = started();
    const at = (id: string, x: number) => ({ ...g.match!.tanks.find((t) => t.id === id)!, x, y: ground, z: 128 });
    return {
      ...g.match!,
      terrain: createFlatTerrain(257, 257, ground),
      wind: { x: 0, z: 0 },
      tanks: [at("A", 110), at("B", 60)],
      players: g.match!.players.map((p) => (p.id === "B" ? { ...p, inventory: { ...p.inventory, ...inventory } } : p)),
    };
  }

  it("con el rival en la orilla, entre una muestra que lo ahoga y otra que solo le roza, manda la que ahoga", () => {
    const m = onGround(3, { missile: 3 });
    expect(onShore(m.terrain, 110, 128)).toBe(true);
    const all = botCandidates(m, "B", createRng(167));
    const wet = all.filter((c) => c.drowns);
    const closest = all.reduce((a, b) => (b.miss < a.miss ? b : a));
    // Una sola lo ahoga, y la que cae más cerca (la que tiraría sin mirar el agua) no es esa: le roza.
    expect(wet).toHaveLength(1);
    expect(closest.drowns).toBe(false);
    const graze = resolveTurn3D(m, { playerId: "B", yaw: closest.yaw, pitch: closest.pitch, power: closest.power, weaponId: "missile" });
    expect(graze.damage.some((d) => d.targetId === "A" && d.cause === "explosion")).toBe(true);
    expect(isAlive(graze.state.tanks.find((t) => t.id === "A")!)).toBe(true);

    const pick = pickBotShot(m, "B", createRng(167))!;
    expect(pick).toEqual(wet[0]);
    // Lo que hace Game.fire con el elegido: Ana termina en el agua.
    const g = started();
    g.match = m;
    g.tickSecond();
    for (let i = 0; i < 29; i++) g.tickSecond();
    const fired = g.fire("B", pick)!;
    expect(fired.result.damage).toContainEqual(expect.objectContaining({ targetId: "A", cause: "water", killed: true }));

    // Si ninguna lo ahoga, tira como siempre: la que cae más cerca.
    const dry = botCandidates(m, "B", createRng(1));
    expect(dry.some((c) => c.drowns)).toBe(false);
    expect(pickBotShot(m, "B", createRng(1))!.miss).toBe(Math.min(...dry.map((c) => c.miss)));
    // Con el rival en piso alto, o con el Rodillo en la orilla, ninguna muestra cuenta como ahogo.
    for (const other of [onGround(10, { missile: 3 }), onGround(3, { roller: 3 })]) {
      const same = botCandidates(other, "B", createRng(167));
      expect(same.some((c) => c.drowns)).toBe(false);
      expect(pickBotShot(other, "B", createRng(167))!.miss).toBe(Math.min(...same.filter((c) => c.landed && !c.blocked).map((c) => c.miss)));
    }
  });

  it("el tiro elegido lo acepta Game.fire como el de cualquier jugador", () => {
    const g = started();
    g.tickSecond(); // no hace falta que tire A: se saltea su turno
    for (let i = 0; i < 29; i++) g.tickSecond();
    expect(g.turnId).toBe("B");
    const pick = pickBotShot(g.match!, "B", createRng(1))!;
    expect(pick.weapon).toBe("babyMissile"); // no tiene Missiles
    expect(g.fire("B", pick)).not.toBeNull();
  });

  it("compra una sola cosa, si le alcanza: Missile, Roller, Rebote o nafta, sorteado entre lo que puede pagar", () => {
    const g = started();
    const bot = g.playerOf("B")!;
    expect(bot.money).toBe(MONEY_START);
    expect(bot.money).toBeGreaterThanOrEqual(SHOP_ITEMS.fuel.price);
    expect(botShopPick(bot, () => 0.1)).toBe("missile");
    expect(botShopPick(bot, () => 0.3)).toBe("roller");
    expect(botShopPick(bot, () => 0.6)).toBe("leapfrog");
    expect(botShopPick(bot, () => 0.9)).toBe("fuel");
    // Compra también con Missiles encima.
    expect(botShopPick({ ...bot, inventory: { ...bot.inventory, missile: 3 } }, () => 0.6)).toBe("leapfrog");
    // Sortea solo entre lo que le alcanza; si no le alcanza para nada, no compra.
    expect(botShopPick({ ...bot, money: SHOP_ITEMS.roller.price - 1 }, () => 0.9)).toBe("missile");
    expect(botShopPick({ ...bot, money: SHOP_ITEMS.missile.price - 1 }, () => 0.1)).toBeNull();
  });

  it("el escudo lo compra si le pegaron en la ronda anterior y no tiene uno", () => {
    const g = started();
    const bot = g.playerOf("B")!;
    const rng = createRng(5);
    for (let i = 0; i < 50; i++) {
      expect(botShopPick(bot, rng, true)).toBe("shield");
      expect(botShopPick(bot, rng, false)).not.toBe("shield");
      expect(botShopPick(bot, rng)).not.toBe("shield");
      // Ya tiene uno: compra otra cosa.
      expect(botShopPick({ ...bot, inventory: { ...bot.inventory, shield: 1 } }, rng, true)).not.toBe("shield");
    }
    // No le alcanza para el escudo: sortea entre lo demás.
    expect(botShopPick({ ...bot, money: SHOP_ITEMS.shield.price - 1 }, () => 0.9, true)).toBe("leapfrog");
  });

  it("no compra Nuke aunque le sobre, ni Napalm, Tierra, Racimo o paracaídas, salga lo que salga en el sorteo", () => {
    const g = started();
    const rich = { ...g.playerOf("B")!, money: 999_999 };
    for (const no of ["nuke", "napalm", "dirt", "mirv", "parachute"] as const) expect(rich.money).toBeGreaterThan(SHOP_ITEMS[no].price);
    const rng = createRng(3);
    const picks = new Set<string | null>();
    for (let i = 0; i < 200; i++) picks.add(botShopPick(rich, rng, i % 2 === 0));
    expect(picks.has("nuke")).toBe(false);
    expect([...picks].sort()).toEqual(["fuel", "leapfrog", "missile", "roller", "shield"]);
  });

  it("con plata para un Rebote y sin Missiles, lo compra y lo dispara en su turno", () => {
    const g = started();
    while (g.phase !== "shop") g.tickSecond(); // nadie tira: la ronda corta sola y abre la tienda
    g.match = {
      ...g.match!,
      players: g.match!.players.map((p) => (p.id === "B" ? { ...p, money: SHOP_ITEMS.leapfrog.price } : p)),
    };
    expect(g.playerOf("B")!.inventory.missile ?? 0).toBe(0);
    const item = botShopPick(g.playerOf("B")!, () => 0.9);
    expect(item).toBe("leapfrog");
    expect(g.buy("B", { item })).toBe(true);
    expect(g.playerOf("B")!.money).toBe(0);
    expect(g.playerOf("B")!.inventory.leapfrog).toBe(SHOP_ITEMS.leapfrog.pack);
    g.setReady("A");
    g.setReady("B");
    expect(g.round).toBe(2);
    expect(g.turnId).toBe("B"); // la ronda 2 la abre el segundo asiento
    const pick = pickBotShot(g.match!, "B", createRng(1))!;
    expect(pick.weapon).toBe("leapfrog");
    expect(g.fire("B", pick)!.weapon).toBe("leapfrog");
    expect(g.playerOf("B")!.inventory.leapfrog).toBe(SHOP_ITEMS.leapfrog.pack - 1);
  });

  it("tira lo que tiene: Missile, si no Rebote, si no Roller, si no la Baby", () => {
    const g = started();
    const give = (inventory: object) => ({
      ...g.match!,
      players: g.match!.players.map((p) => (p.id === "B" ? { ...p, inventory: { ...p.inventory, ...inventory } } : p)),
    });
    expect(pickBotShot(give({ missile: 3, leapfrog: 2, roller: 2 }), "B", createRng(1))!.weapon).toBe("missile");
    expect(pickBotShot(give({ leapfrog: 2, roller: 2 }), "B", createRng(1))!.weapon).toBe("leapfrog");
    expect(pickBotShot(give({ roller: 2 }), "B", createRng(1))!.weapon).toBe("roller");
    expect(pickBotShot(give({}), "B", createRng(1))!.weapon).toBe("babyMissile");
    // Lo que no compra tampoco lo tira, aunque lo tenga.
    expect(pickBotShot(give({ mirv: 2, nuke: 1, napalm: 1, dirt: 1 }), "B", createRng(1))!.weapon).toBe("babyMissile");
    // El Roller elegido lo acepta Game.fire, y se gasta.
    g.match = give({ roller: 2 });
    g.tickSecond();
    for (let i = 0; i < 29; i++) g.tickSecond();
    expect(g.fire("B", pickBotShot(g.match, "B", createRng(1))!)!.weapon).toBe("roller");
    expect(g.playerOf("B")!.inventory.roller).toBe(1);
  });

  it("nafta: con un cerro de por medio y piso más alto a menos de 20 celdas, sube antes de tirar; si no, no se mueve", () => {
    const fueled = (m: MatchState3D, fuel: number): MatchState3D => ({
      ...m,
      players: m.players.map((p) => (p.id === "B" ? { ...p, inventory: { ...p.inventory, fuel } } : p)),
    });
    // Una loma de altura 20 al lado del bot (que está en x = 60, a altura 10).
    const withMound = (m: MatchState3D, x0: number): MatchState3D => {
      const terrain = { ...m.terrain, heights: m.terrain.heights.slice() };
      for (let z = 126; z <= 130; z++) for (let x = x0; x <= x0 + 4; x++) terrain.heights[x + z * 257] = 20;
      return { ...m, terrain };
    };
    const flat: MatchState3D = { ...behindHill(), terrain: createFlatTerrain(257, 257, 10) };

    const m = fueled(withMound(behindHill(), 70), 1);
    const to = botMovePick(m, "B")!;
    expect(Math.hypot(to.x - 60, to.z - 128)).toBeLessThan(FUEL_MOVE_RANGE);
    expect(terrainHeightAt(m.terrain, to.x, to.z)).toBe(20);

    expect(botMovePick(fueled(withMound(behindHill(), 70), 0), "B")).toBeNull(); // sin nafta
    expect(botMovePick(fueled(withMound(flat, 46), 1), "B")).toBeNull(); // sin cerro de por medio (la loma queda atrás)
    expect(botMovePick(fueled(behindHill(), 1), "B")).toBeNull(); // sin piso más alto
    expect(botMovePick(fueled(withMound(behindHill(), 81), 1), "B")).toBeNull(); // el piso más alto queda a más de 20

    // El destino lo acepta Game.move como el de cualquier jugador, gasta la carga y después tira desde arriba.
    const g = started();
    g.match = m;
    g.tickSecond();
    for (let i = 0; i < 29; i++) g.tickSecond();
    expect(g.turnId).toBe("B");
    expect(g.move("B", { moveTo: to })!.y).toBe(20);
    expect(g.playerOf("B")!.inventory.fuel).toBe(0);
    expect(botMovePick(g.match!, "B")).toBeNull();
    expect(g.fire("B", pickBotShot(g.match!, "B", createRng(1))!)).not.toBeNull();
  });

  it("nacimiento: el piso firme más alto que queda a 60 de los demás; ni un hoyo ni el agua, aunque sean más altos o no haya otra cosa", () => {
    // Piso plano a 10 con tres cimas: 50, 40 y 30.
    const pristine = createFlatTerrain(257, 257, 10);
    const peak = (t: { heights: Float32Array }, x: number, z: number, h: number) => (t.heights[x + z * 257] = h);
    peak(pristine, 100, 100, 50);
    peak(pristine, 200, 200, 40);
    peak(pristine, 60, 200, 30);
    expect(botSpawnPick(pristine, pristine, [])).toEqual({ x: 100, z: 100 });
    // Otro nace a 20 celdas de la más alta: va a la segunda. Con los dos cerca de las dos primeras, a la tercera.
    expect(botSpawnPick(pristine, pristine, [{ x: 120, z: 100 }])).toEqual({ x: 200, z: 200 });
    expect(botSpawnPick(pristine, pristine, [{ x: 120, z: 100 }, { x: 200, z: 240 }])).toEqual({ x: 60, z: 200 });
    // A la más alta le volaron la punta: sigue siendo la más alta, pero es un hoyo.
    const dug = { ...pristine, heights: pristine.heights.slice() };
    peak(dug, 100, 100, 45);
    expect(botSpawnPick(dug, pristine, [])).toEqual({ x: 200, z: 200 });
    // Todo agua: no elige, y le queda el del sorteo.
    expect(botSpawnPick(createFlatTerrain(257, 257, 0), createFlatTerrain(257, 257, 0), [])).toBeNull();

    // En una partida, Game.chooseSpawn lo acepta como el de cualquier jugador y en la ronda 2 nace ahí:
    // no hay piso que valga y sea más alto.
    const g = started();
    g.match = { ...g.match!, tanks: g.match!.tanks.map((t) => (t.id === "B" ? { ...t, life: 0 } : t)) };
    while (g.phase === "aiming") g.tickSecond();
    expect(g.phase).toBe("shop");
    const { terrain } = g.match!;
    const at = botSpawnPick(terrain, g.pristine!, g.spawnRivals("B"))!;
    expect(g.chooseSpawn("B", { at })).toBe(true);
    let top = -Infinity;
    for (let z = 0; z < terrain.depth; z++) {
      for (let x = 0; x < terrain.width; x++) {
        const check = validateSpawn(terrain, g.pristine!, { x, z }, g.spawnRivals("B"));
        if (check.ok) top = Math.max(top, check.y);
      }
    }
    g.setReady("A");
    g.setReady("B");
    expect(g.round).toBe(2);
    expect(g.match!.tanks.find((t) => t.id === "B")).toMatchObject({ ...at, y: top });
    expect(Math.hypot(at.x - g.match!.tanks[0]!.x, at.z - g.match!.tanks[0]!.z)).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
  });
});

describe("sala con bot", () => {
  const PORT = 26700 + Math.floor(Math.random() * 1000);
  const url = `ws://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    GameRoom.shotDelayScale = 0.02;
    GameRoom.botDelayMs = 30;
    GameRoom.seedOverride = 424242;
    server = await createServer(PORT);
  });

  afterAll(async () => {
    GameRoom.seedOverride = null;
    await server.gracefullyShutdown(false);
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error("timeout esperando condición");
      await sleep(10);
    }
  }
  const players = (r: Room<any>): any[] => [...r.state.players.values()];

  function quiet(r: Room<any>) {
    for (const type of ["terrain", "shot", "moved", "skip", "roundEnd"]) r.onMessage(type, () => {});
  }

  it("el bot dispara dentro de su turno y el otro cliente ve el cráter", async () => {
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    quiet(a);
    let patches = 0;
    let skips = 0;
    const shots: any[] = [];
    a.onMessage("terrain", (m: TerrainMessage) => {
      if (m.w !== m.width || m.d !== m.depth) patches++;
    });
    a.onMessage("skip", () => skips++);
    a.onMessage("shot", (m) => shots.push({ ...m, turnId: a.state.turnId, phase: a.state.phase }));

    await until(() => a.state.players?.size === 1);
    a.send("start"); // sola no arranca
    a.send("fillBots");
    await until(() => a.state.players.size === 2);
    const bot = players(a).find((p) => p.id !== a.sessionId);
    expect(bot.name).toBe("Bot");
    a.send("fillBots"); // completa hasta 2, no más
    a.send("start");
    await until(() => a.state.phase === "aiming");
    expect(a.state.players.size).toBe(2);
    // Mismo arranque que un jugador: vida y plata iguales.
    expect(bot.life).toBe(a.state.players.get(a.sessionId).life);
    expect(bot.money).toBe(a.state.players.get(a.sessionId).money);

    // Tira Ana (lejos de todo) y le toca al bot.
    expect(a.state.turnId).toBe(a.sessionId);
    a.send("fire", { yaw: a.state.players.get(a.sessionId).yaw, pitch: 60, power: 250 });
    await until(() => a.state.phase === "aiming" && a.state.turnId === bot.id);
    const patchesBefore = patches;

    await until(() => shots.some((s) => s.shooterId === bot.id));
    const shot = shots.find((s) => s.shooterId === bot.id);
    expect(skips).toBe(0); // tiró él, no se le venció el reloj
    expect(a.state.timeLeft).toBeGreaterThan(0);
    expect(["ground", "tank"]).toContain(shot.outcome);
    expect(shot.path.length).toBeGreaterThan(3);

    // El cráter del bot le llega a Ana como parche de terreno, y el turno vuelve.
    await until(() => patches > patchesBefore);
    await until(() => a.state.phase !== "animating");
    if (a.state.phase === "aiming") expect(a.state.turnId).toBe(a.sessionId);
    await a.leave();
  }, 20_000);

  it("en la tienda compra una sola cosa, elige dónde nacer, da el listo y, si es un arma, la gasta en la ronda siguiente", async () => {
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    quiet(a);
    const botShots: any[] = [];
    let botMoves = 0;
    let mounds = 0;
    let digs = 0;
    a.onMessage("shot", (m) => m.shooterId !== a.sessionId && botShots.push(m));
    a.onMessage("moved", (m) => m.id !== a.sessionId && botMoves++);
    a.onMessage("mound", () => mounds++);
    a.onMessage("dug", () => digs++);
    await until(() => a.state.players?.size === 1);
    a.send("fillBots");
    await until(() => a.state.players.size === 2);
    const bot = players(a).find((p) => p.id !== a.sessionId);
    a.send("start");
    await until(() => a.state.phase === "aiming");

    // Ronda 1: Ana tira al aire hasta que la ronda corta o alguien muere.
    while (a.state.phase !== "shop" && a.state.phase !== "ended") {
      if (a.state.phase === "aiming" && a.state.turnId === a.sessionId) {
        a.send("fire", { yaw: a.state.players.get(a.sessionId).yaw + 180, pitch: 60, power: 250 });
        await until(() => a.state.phase !== "aiming" || a.state.turnId !== a.sessionId);
      }
      await sleep(5);
    }
    expect(a.state.phase).toBe("shop");
    expect(botShots.every((s) => s.weapon === "babyMissile")).toBe(true);

    const game = (matchMaker.getLocalRoomById(a.roomId) as any).game as Game;
    const money = bot.money;
    expect(money).toBeGreaterThanOrEqual(SHOP_ITEMS.dirt.price);
    await until(() => bot.ready);
    // Plata para una Tierra tenía, pero del piso elige dónde nace y nada más: no deja loma.
    expect([mounds, bot.mound, game.mounded.size]).toEqual([0, false, 0]);
    // Ni cava, que sale menos todavía.
    expect([digs, bot.dug, game.dug.size]).toEqual([0, false, 0]);
    const has = (): Record<string, number> => ({
      missile: bot.missiles,
      roller: bot.rollers,
      leapfrog: bot.leapfrogs,
      shield: bot.shield,
      fuel: bot.fuel,
    });
    const boughtAll = Object.keys(has()).filter((k) => has()[k]! > 0);
    expect(boughtAll).toHaveLength(1); // una sola cosa
    const bought = boughtAll[0] as "missile" | "roller" | "leapfrog" | "shield" | "fuel";
    expect(has()[bought]).toBe(SHOP_ITEMS[bought].pack);
    expect(bot.money).toBe(money - SHOP_ITEMS[bought].price);
    expect(bot.napalms + bot.nukes + bot.dirts + bot.mirvs + bot.parachute).toBe(0);

    // Antes del listo eligió dónde nacer: el firme más alto que le deja Ana. Ana lo ve marcado, y ella sigue con el del sorteo.
    const born = botSpawnPick(game.match!.terrain, game.pristine!, game.spawnRivals(bot.id))!;
    expect([bot.spawnX, bot.spawnZ, bot.spawnPicked]).toEqual([born.x, born.z, true]);
    const ana = a.state.players.get(a.sessionId);
    expect(ana.spawnPicked).toBe(false);
    expect(Math.hypot(born.x - ana.spawnX, born.z - ana.spawnZ)).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
    const drawn = { x: ana.spawnX, z: ana.spawnZ };

    botMoves = 0;
    a.send("ready");
    await until(() => a.state.round === 2 && a.state.phase !== "shop");
    // La ronda 2 abre con cada uno donde estaba su marca, y las marcas se van. (Si al bot le tocó
    // primero y ya usó la Nafta de la casa, se corrió de ahí: el aviso "moved" llega antes que el estado.)
    if (botMoves === 0) expect([bot.x, bot.z]).toEqual([born.x, born.z]);
    expect([ana.x, ana.z]).toEqual([drawn.x, drawn.z]);
    expect([bot.spawnX, ana.spawnX]).toEqual([-1, -1]);
    if (bought !== "shield" && bought !== "fuel") {
      // Si el bot tira primero puede cerrar la ronda de un tiro: Ana solo tira si le toca.
      while (!botShots.some((s) => s.weapon === bought)) {
        if (a.state.round === 2 && a.state.phase === "aiming" && a.state.turnId === a.sessionId) {
          a.send("fire", { yaw: a.state.players.get(a.sessionId).yaw + 180, pitch: 60, power: 250 });
          await until(() => a.state.phase !== "aiming" || a.state.turnId !== a.sessionId);
        }
        await sleep(5);
      }
      await until(() => has()[bought] === SHOP_ITEMS[bought].pack - 1);
    }
    await a.leave();
  }, 60_000);

  it("con un cerro de por medio, el bot sube con la Nafta de la casa (la comprada la guarda) y después tira en el mismo turno", async () => {
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    quiet(a);
    const events: any[] = [];
    a.onMessage("moved", (m) => events.push({ type: "moved", ...m }));
    a.onMessage("shot", (m) => events.push({ type: "shot", ...m }));
    await until(() => a.state.players?.size === 1);
    a.send("fillBots");
    await until(() => a.state.players.size === 2);
    const bot = players(a).find((p) => p.id !== a.sessionId);
    a.send("start");
    await until(() => a.state.phase === "aiming");
    expect(a.state.turnId).toBe(a.sessionId);

    // Mientras le toca a Ana, se le arma al bot el caso: piso plano, un cerro de pared a pared
    // entre los dos, una loma al lado del bot y, además de la Nafta de la casa, una comprada.
    const game = (matchMaker.getLocalRoomById(a.roomId) as any).game as Game;
    const terrain = createFlatTerrain(257, 257, 10);
    for (let z = 0; z < 257; z++) for (let x = 180; x <= 192; x++) terrain.heights[x + z * 257] = 45;
    for (let z = 126; z <= 130; z++) for (let x = 70; x <= 74; x++) terrain.heights[x + z * 257] = 20;
    const m = game.match!;
    game.match = {
      ...m,
      terrain,
      tanks: m.tanks.map((t) => ({ ...t, x: t.id === bot.id ? 60 : 200, y: 10, z: 128 })),
      players: m.players.map((p) => (p.id === bot.id ? { ...p, inventory: { ...p.inventory, fuel: 2 } } : p)),
    };

    a.send("fire", { yaw: 0, pitch: 60, power: 250 }); // lejos del bot
    await until(() => events.some((e) => e.type === "shot" && e.shooterId === bot.id));
    const moved = events.findIndex((e) => e.type === "moved");
    const shot = events.findIndex((e) => e.type === "shot" && e.shooterId === bot.id);
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(moved).toBeLessThan(shot);
    expect(events[moved].id).toBe(bot.id);
    expect(events[moved].y).toBe(20);
    expect(events.filter((e) => e.type === "moved")).toHaveLength(1);
    await until(() => bot.fuel === 1 && bot.y === 20);
    await a.leave();
  }, 20_000);

  it("si entra un humano y la sala pasaría de 4, el bot se va", async () => {
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    quiet(a);
    await until(() => a.state.players?.size === 1);
    a.send("fillBots");
    await until(() => a.state.players.size === 2);
    const others: Room<any>[] = [];
    for (const name of ["Beto", "Caro"]) others.push(await new Client(url).joinById(a.roomId, { name }));
    await until(() => a.state.players.size === 4);
    expect(players(a).map((p) => p.name)).toContain("Bot"); // con 4 justos, se queda
    others.push(await new Client(url).joinById(a.roomId, { name: "Dani" }));
    await until(() => players(a).some((p) => p.name === "Dani"));
    expect(a.state.players.size).toBe(4);
    expect(players(a).map((p) => p.name).sort()).toEqual(["Ana", "Beto", "Caro", "Dani"]);
    for (const r of [...others, a]) await r.leave();
  }, 15_000);
});
