// Integración: server real + dos clientes del SDK jugando una partida completa de 5 rondas en 3D.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import type { Server } from "@colyseus/core";
import { SHOP_ITEMS, simulateShot3D, type Terrain } from "@pegaycobra/sim";
import { createServer, ROOM_NAME } from "../src/server";
import { GameRoom, type RoundEndBroadcast } from "../src/room";
import { applyTerrainMessage, type TerrainMessage } from "../src/terrain-net";

const PORT = 25670 + Math.floor(Math.random() * 1000);
let server: Server;

beforeAll(async () => {
  GameRoom.shotDelayScale = 0.02; // que el test no espere la animación entera
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

/** Copia local del heightmap armada solo con los mensajes "terrain" del server. */
function trackTerrain(room: Room<any>) {
  const box: { terrain: Terrain | null; patches: number; fulls: number } = { terrain: null, patches: 0, fulls: 0 };
  room.onMessage("terrain", (m: TerrainMessage) => {
    if (!box.terrain || box.terrain.width !== m.width) {
      box.terrain = { width: m.width, depth: m.depth, heights: new Float32Array(m.width * m.depth) };
    }
    applyTerrainMessage(box.terrain.heights, m.width, m);
    if (m.w === m.width && m.d === m.depth) box.fulls++;
    else box.patches++;
  });
  return box;
}

/** El "jugador" del test busca un tiro que pegue con el sim (el cliente real no hace esto). */
function aimAt(state: any, terrain: Terrain, shooterId: string): { yaw: number; pitch: number; power: number } {
  const tanks = [...state.players.values()]
    .filter((p: any) => p.life > 0)
    .map((p: any) => ({ id: p.id as string, x: p.x as number, y: p.y as number, z: p.z as number }));
  const me = tanks.find((t) => t.id === shooterId)!;
  const foe = tanks.find((t) => t.id !== shooterId);
  if (!foe) return { yaw: 0, pitch: 45, power: 300 };
  const base = (Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI;
  const wind = { x: state.windX, z: state.windZ };
  for (let pitch = 30; pitch <= 80; pitch += 5) {
    for (let power = 300; power <= 1000; power += 10) {
      for (let d = 0; d <= 12; d++) {
        for (const yaw of [base + d, base - d]) {
          const r = simulateShot3D(terrain, { originX: me.x, originY: me.y, originZ: me.z, yaw, pitch, power, wind, shooterId }, tanks);
          if (r.outcome === "tank") return { yaw, pitch, power };
        }
      }
    }
  }
  return { yaw: base, pitch: 45, power: 600 };
}

describe("partida de 5 rondas por red", () => {
  it("dos clientes: rondas seguidas, viento nuevo, tienda, Missile que el otro ve gastar, ganador por puntos", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    const ta = trackTerrain(a);
    const tb = trackTerrain(b);
    const shotsSeenByB: any[] = [];
    const roundEnds: RoundEndBroadcast[] = [];
    b.onMessage("shot", (m) => shotsSeenByB.push(m));
    b.onMessage("roundEnd", (m: RoundEndBroadcast) => roundEnds.push(m));
    a.onMessage("shot", () => {});
    a.onMessage("roundEnd", () => {});
    for (const r of [a, b]) {
      r.onMessage("skip", () => {});
      r.onMessage("moved", () => {});
    }

    await until(() => a.state.players?.size === 2 && b.state.players?.size === 2);
    a.send("start");

    const rooms = { [a.sessionId]: a, [b.sessionId]: b };
    const winds: string[] = [];
    let missileCountSeenByB: number[] = [];
    let missilesFired = 0;

    for (let round = 1; round <= 5; round++) {
      await until(() => b.state.round === round && b.state.phase === "aiming" && tb.fulls === round);
      expect(ta.terrain!.heights).toEqual(tb.terrain!.heights); // el mismo cerro en las dos
      winds.push(`${b.state.windX.toFixed(3)},${b.state.windZ.toFixed(3)}`);

      let turns = 0;
      while ((a.state.phase === "aiming" || a.state.phase === "animating") && turns < 40) {
        await until(() => a.state.phase !== "animating");
        if (a.state.phase !== "aiming") break;
        const turnId = a.state.turnId as string;
        const room = rooms[turnId]!;
        const me = room.state.players.get(turnId);
        const weapon = turnId === a.sessionId && me.missiles > 0 ? "missile" : "babyMissile";
        room.send("fire", { ...aimAt(room.state, ta.terrain!, turnId), weapon, damage: 999 });
        await until(() => a.state.phase !== "aiming" || a.state.turnId !== turnId);
        if (weapon === "missile") {
          missilesFired++;
          await until(() => b.state.players.get(a.sessionId).missiles === 3 - missilesFired);
          missileCountSeenByB.push(b.state.players.get(a.sessionId).missiles);
        }
        await until(() => a.state.phase !== "animating");
        turns++;
      }

      await until(() => roundEnds.length === round);
      if (round < 5) {
        await until(() => b.state.phase === "shop");
        expect(b.state.timeLeft).toBeGreaterThan(0);
        if (round === 1) {
          // Ana compra un pack de Missiles; Beto ve la plata y el inventario de Ana cambiar.
          const before = b.state.players.get(a.sessionId).money;
          a.send("buy", { item: "missile" });
          await until(() => b.state.players.get(a.sessionId).missiles === 3);
          expect(b.state.players.get(a.sessionId).money).toBe(before - SHOP_ITEMS.missile.price);
          // No se puede comprar de más: Beto intenta comprar más de lo que le alcanza.
          const bMoney = b.state.players.get(b.sessionId).money;
          const affordable = Math.floor(bMoney / SHOP_ITEMS.missile.price);
          for (let i = 0; i < affordable + 3; i++) b.send("buy", { item: "missile" });
          await until(() => b.state.players.get(b.sessionId).missiles === affordable * 3);
          await sleep(100);
          expect(b.state.players.get(b.sessionId).missiles).toBe(affordable * 3);
          expect(b.state.players.get(b.sessionId).money).toBe(bMoney - affordable * SHOP_ITEMS.missile.price);
        }
        a.send("ready");
        b.send("ready");
      }
    }

    await until(() => a.state.phase === "ended" && b.state.phase === "ended");
    expect(a.state.endReason).toBe("rounds");

    // Viento sorteado de nuevo en cada ronda.
    expect(new Set(winds).size).toBeGreaterThan(1);
    // Beto vio el Missile de Ana gastarse.
    expect(missilesFired).toBeGreaterThan(0);
    expect(missileCountSeenByB[0]).toBe(2);
    expect(shotsSeenByB.some((s) => s.shooterId === a.sessionId && s.weapon === "missile")).toBe(true);
    // Cobraron al terminar cada ronda.
    expect(roundEnds).toHaveLength(5);
    expect(roundEnds.every((r) => r.payouts.every((p) => p.interest > 0))).toBe(true);
    // Hubo cráteres (parches de terreno) además de los 5 terrenos completos.
    expect(tb.patches).toBeGreaterThan(0);

    // Ganador por puntos: el de más puntos, y el estado coincide con la tabla.
    const rows = [...b.state.players.values()].map((p: any) => ({ id: p.id, points: p.points, kills: p.kills, damage: p.damage }));
    rows.sort((x, y) => y.points - x.points || y.kills - x.kills || y.damage - x.damage);
    if (rows[0]!.points !== rows[1]!.points || rows[0]!.kills !== rows[1]!.kills || rows[0]!.damage !== rows[1]!.damage) {
      expect(b.state.winnerId).toBe(rows[0]!.id);
    } else {
      expect(b.state.winnerId).toBe("");
    }
    expect(rows.some((r) => r.points > 0)).toBe(true);

    await a.leave();
    await b.leave();
  }, 120_000);

  it("si uno se va en plena partida, el otro gana", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    a.onMessage("terrain", () => {});
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    b.onMessage("terrain", () => {});
    await until(() => a.state.players?.size === 2);
    a.send("start");
    await until(() => a.state.phase === "aiming");
    await b.leave();
    await until(() => a.state.phase === "ended");
    expect(a.state.winnerId).toBe(a.sessionId);
    expect(a.state.endReason).toBe("forfeit");
    await a.leave();
  }, 15_000);

  it("un código que no existe falla", async () => {
    await expect(new Client(`ws://localhost:${PORT}`).joinById("ZZZZ", {})).rejects.toBeTruthy();
  });
});
