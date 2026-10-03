// El bot: cómo elige el tiro (sin red) y una sala real con un solo cliente humano.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import type { Server } from "@colyseus/core";
import { createRng, MONEY_START, SHOP_ITEMS } from "@pegaycobra/sim";
import { BOT_NAME, BOT_SAMPLES, botCandidates, botWantsMissile, pickBotShot } from "../src/bot";
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

  it("prueba 12 punterías con el sim y se queda con la que cae más cerca del rival", () => {
    const g = started();
    const all = botCandidates(g.match!, "B", createRng(1));
    const pick = pickBotShot(g.match!, "B", createRng(1))!;
    expect(all).toHaveLength(BOT_SAMPLES);
    expect(all).toContainEqual(pick);
    expect(pick.landed).toBe(true);
    expect(pick.miss).toBe(Math.min(...all.filter((c) => c.landed).map((c) => c.miss)));
    // No son 12 veces el mismo tiro.
    expect(new Set(all.map((c) => c.power)).size).toBe(BOT_SAMPLES);
    expect(new Set(all.map((c) => c.yaw)).size).toBe(BOT_SAMPLES);
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

  it("compra Missile solo si no tiene y le alcanza; con Missiles, los tira", () => {
    const g = started();
    const bot = g.playerOf("B")!;
    expect(bot.money).toBe(MONEY_START);
    expect(botWantsMissile(bot)).toBe(true);
    expect(botWantsMissile({ ...bot, money: SHOP_ITEMS.missile.price - 1 })).toBe(false);
    const armed = { ...bot, inventory: { ...bot.inventory, missile: 3 } };
    expect(botWantsMissile(armed)).toBe(false);
    g.match = { ...g.match!, players: g.match!.players.map((p) => (p.id === "B" ? armed : p)) };
    expect(pickBotShot(g.match, "B", createRng(1))!.weapon).toBe("missile");
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

  it("en la tienda compra un Missile, da el listo y lo gasta en la ronda siguiente", async () => {
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
    expect(bot.missiles).toBe(SHOP_ITEMS.missile.pack);
    expect(bot.money).toBe(money - SHOP_ITEMS.missile.price);
    expect(bot.parachute).toBe(0);
    expect(bot.fuel).toBe(0);

    a.send("ready");
    await until(() => a.state.round === 2 && a.state.phase === "aiming");
    if (a.state.turnId === a.sessionId) a.send("fire", { yaw: a.state.players.get(a.sessionId).yaw + 180, pitch: 60, power: 250 });
    await until(() => botShots.some((s) => s.weapon === "missile"));
    await until(() => bot.missiles === SHOP_ITEMS.missile.pack - 1);
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
