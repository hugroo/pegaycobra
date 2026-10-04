// El bot: cómo elige el tiro (sin red) y una sala real con un solo cliente humano.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import type { Server } from "@colyseus/core";
import { createFlatTerrain, createRng, MONEY_START, SHOP_ITEMS, type MatchState3D } from "@pegaycobra/sim";
import { BOT_NAME, BOT_SAMPLES, botCandidates, botShopPick, pickBotShot } from "../src/bot";
import { Game } from "../src/game";
import { createServer, ROOM_NAME } from "../src/server";
import { GameRoom } from "../src/room";
import type { TerrainMessage } from "../src/terrain-net";

describe("puntería del bot", () => {
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
    const all = botCandidates(m, "B", createRng(4));
    expect(all.some((c) => c.landed && !c.blocked)).toBe(false);
    const pick = pickBotShot(m, "B", createRng(4))!;
    expect(pick.landed).toBe(true);
    expect(pick.miss).toBe(Math.min(...all.filter((c) => c.landed).map((c) => c.miss)));
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

  it("compra solo si no tiene Missile y le alcanza: Missile o Roller, a cara o cruz", () => {
    const g = started();
    const bot = g.playerOf("B")!;
    expect(bot.money).toBe(MONEY_START);
    expect(botShopPick(bot, () => 0.9)).toBe("missile");
    expect(botShopPick(bot, () => 0.1)).toBe("roller");
    expect(botShopPick({ ...bot, money: SHOP_ITEMS.missile.price - 1 }, () => 0.9)).toBeNull();
    expect(botShopPick({ ...bot, money: SHOP_ITEMS.roller.price - 1 }, () => 0.1)).toBeNull();
    const armed = { ...bot, inventory: { ...bot.inventory, missile: 3 } };
    expect(botShopPick(armed, () => 0.1)).toBeNull();
    expect(botShopPick(armed, () => 0.9)).toBeNull();
  });

  it("no compra Napalm, Nuke, Tierra ni Racimo, tenga la plata que tenga y salga lo que salga en el sorteo", () => {
    const g = started();
    const rich = { ...g.playerOf("B")!, money: 999_999 };
    expect(rich.money).toBeGreaterThan(SHOP_ITEMS.napalm.price);
    expect(rich.money).toBeGreaterThan(SHOP_ITEMS.nuke.price);
    expect(rich.money).toBeGreaterThan(SHOP_ITEMS.dirt.price);
    expect(rich.money).toBeGreaterThan(SHOP_ITEMS.mirv.price);
    const rng = createRng(3);
    const picks = new Set(Array.from({ length: 200 }, () => botShopPick(rich, rng)));
    expect([...picks].sort()).toEqual(["missile", "roller"]);
  });

  it("tira lo que tiene: Missile, si no Roller, si no la Baby", () => {
    const g = started();
    const give = (inventory: object) => ({
      ...g.match!,
      players: g.match!.players.map((p) => (p.id === "B" ? { ...p, inventory: { ...p.inventory, ...inventory } } : p)),
    });
    expect(pickBotShot(give({ missile: 3, roller: 2 }), "B", createRng(1))!.weapon).toBe("missile");
    expect(pickBotShot(give({ roller: 2 }), "B", createRng(1))!.weapon).toBe("roller");
    expect(pickBotShot(give({}), "B", createRng(1))!.weapon).toBe("babyMissile");
    // Un Racimo que no compró él tampoco lo tira.
    expect(pickBotShot(give({ mirv: 2 }), "B", createRng(1))!.weapon).toBe("babyMissile");
    // El Roller elegido lo acepta Game.fire, y se gasta.
    g.match = give({ roller: 2 });
    g.tickSecond();
    for (let i = 0; i < 29; i++) g.tickSecond();
    expect(g.fire("B", pickBotShot(g.match, "B", createRng(1))!)!.weapon).toBe("roller");
    expect(g.playerOf("B")!.inventory.roller).toBe(1);
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

  it("en la tienda compra un pack (Missile o Roller), da el listo y lo gasta en la ronda siguiente", async () => {
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    quiet(a);
    const botShots: any[] = [];
    a.onMessage("shot", (m) => m.shooterId !== a.sessionId && botShots.push(m));
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

    const money = bot.money;
    await until(() => bot.ready);
    const bought = bot.missiles > 0 ? "missile" : "roller";
    const left = () => (bought === "missile" ? bot.missiles : bot.rollers);
    expect(bot.missiles + bot.rollers).toBe(SHOP_ITEMS[bought].pack); // un solo pack, de una sola cosa
    expect(bot.money).toBe(money - SHOP_ITEMS[bought].price);
    expect(bot.shield).toBe(0);
    expect(bot.parachute).toBe(0);
    expect(bot.fuel).toBe(0);

    a.send("ready");
    await until(() => a.state.round === 2 && a.state.phase !== "shop");
    // Si el bot tira primero puede cerrar la ronda de un tiro: Ana solo tira si le toca.
    while (!botShots.some((s) => s.weapon === bought)) {
      if (a.state.round === 2 && a.state.phase === "aiming" && a.state.turnId === a.sessionId) {
        a.send("fire", { yaw: a.state.players.get(a.sessionId).yaw + 180, pitch: 60, power: 250 });
        await until(() => a.state.phase !== "aiming" || a.state.turnId !== a.sessionId);
      }
      await sleep(5);
    }
    await until(() => left() === SHOP_ITEMS[bought].pack - 1);
    await a.leave();
  }, 60_000);

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
