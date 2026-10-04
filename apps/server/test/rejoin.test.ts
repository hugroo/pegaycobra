// Integración: a uno se le cae la conexión (un refresco) y vuelve con el token de reconexión.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import type { Server } from "@colyseus/core";
import { createServer, ROOM_NAME } from "../src/server";
import { GameRoom } from "../src/room";

const PORT = 28670 + Math.floor(Math.random() * 1000);
const url = `ws://localhost:${PORT}`;
let server: Server;
const defaults = { rejoinSeconds: GameRoom.rejoinSeconds, turnSeconds: GameRoom.turnSeconds };

beforeAll(async () => {
  GameRoom.shotDelayScale = 0.02;
  GameRoom.seedOverride = 424242;
  server = await createServer(PORT);
});

afterEach(() => {
  Object.assign(GameRoom, defaults);
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

/** Ana y Beto con la partida arrancada y el turno en Beto (Ana ya tiró el suyo, a cualquier lado). */
async function matchOnBetosTurn(): Promise<{ a: Room<any>; b: Room<any> }> {
  const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
  a.onMessage("*", () => {});
  const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
  b.onMessage("*", () => {});
  await until(() => a.state.players?.size === 2);
  a.send("start");
  await until(() => a.state.phase === "aiming" && a.state.turnId === a.sessionId);
  a.send("fire", { yaw: a.state.players.get(a.sessionId).yaw + 180, pitch: 60, power: 250 });
  await until(() => a.state.phase === "aiming" && a.state.turnId === b.sessionId);
  return { a, b };
}

/** Lo que hace un refresco: la conexión se corta sin avisar. Devuelve lo que el cliente tenía guardado. */
async function drop(room: Room<any>): Promise<string> {
  const token = room.reconnectionToken;
  room.reconnection.enabled = false; // el SDK no reintenta solo: vuelve "otra pestaña"
  await room.leave(false);
  return token;
}

const seat = (p: any) => ({
  id: p.id,
  name: p.name,
  slot: p.slot,
  x: p.x,
  y: p.y,
  z: p.z,
  life: p.life,
  money: p.money,
  missiles: p.missiles,
  shield: p.shield,
  fuel: p.fuel,
  points: p.points,
});

describe("volver a la sala después de un refresco", () => {
  it("vuelve con el mismo id y el otro lo ve como el mismo tanque; el turno era suyo y lo sigue siendo", async () => {
    const { a, b } = await matchOnBetosTurn();
    const id = b.sessionId;
    const before = seat(a.state.players.get(id));
    expect(before.money).toBeGreaterThan(0);

    const token = await drop(b);
    await until(() => a.state.players.get(id).connected === false);
    // Para la partida sigue sentado: ni se terminó, ni se le murió el tanque, ni perdió el turno.
    expect(a.state.phase).toBe("aiming");
    expect(a.state.turnId).toBe(id);
    expect(a.state.players.get(id).life).toBe(before.life);
    // El reloj de su turno sigue corriendo mientras no está.
    const t0 = a.state.timeLeft;
    await until(() => a.state.timeLeft < t0);

    const b2: Room<any> = await new Client(url).reconnect(token);
    let fullTerrains = 0;
    b2.onMessage("terrain", (m: { w: number; width: number }) => m.w === m.width && fullTerrains++);
    b2.onMessage("*", () => {});
    expect(b2.sessionId).toBe(id);
    expect(b2.roomId).toBe(a.roomId);
    await until(() => a.state.players.get(id).connected === true && b2.state.players?.size === 2);

    // Para el otro son los mismos dos tanques, no un tercero.
    expect(a.state.players.size).toBe(2);
    expect([...a.state.order]).toEqual([a.sessionId, id]);
    expect(seat(a.state.players.get(id))).toEqual(before);
    expect(seat(b2.state.players.get(id))).toEqual(before);
    // El terreno no está en el estado: le llega entero de nuevo.
    await until(() => fullTerrains === 1);

    // Sigue siendo su turno y tira él.
    expect(a.state.turnId).toBe(id);
    const shots: string[] = [];
    a.onMessage("shot", (m: { shooterId: string }) => shots.push(m.shooterId));
    b2.send("fire", { yaw: b2.state.players.get(id).yaw + 180, pitch: 60, power: 250 });
    await until(() => shots.length === 1);
    expect(shots).toEqual([id]);

    await a.leave();
    await b2.leave();
  }, 20_000);

  it("si el turno se le vence mientras no está, pasa como siempre y al volver sigue vivo", async () => {
    GameRoom.turnSeconds = 2;
    const { a, b } = await matchOnBetosTurn();
    const id = b.sessionId;
    const skips: unknown[] = [];
    a.onMessage("skip", (m) => skips.push(m));
    const token = await drop(b);
    await until(() => a.state.phase === "aiming" && a.state.turnId === a.sessionId);
    expect(skips.length).toBe(1);
    expect(a.state.players.get(id).life).toBeGreaterThan(0);

    const b2: Room<any> = await new Client(url).reconnect(token);
    b2.onMessage("*", () => {});
    expect(b2.sessionId).toBe(id);
    await until(() => a.state.players.get(id).connected === true);
    expect(a.state.players.size).toBe(2);
    await a.leave();
    await b2.leave();
  }, 20_000);

  it("si no vuelve a tiempo, la partida sigue sin él y el guardado ya no sirve", async () => {
    GameRoom.rejoinSeconds = 0.3;
    const { a, b } = await matchOnBetosTurn();
    const token = await drop(b);
    await until(() => a.state.phase === "ended");
    expect(a.state.winnerId).toBe(a.sessionId);
    expect(a.state.endReason).toBe("forfeit");
    await expect(new Client(url).reconnect(token)).rejects.toBeTruthy();
    await a.leave();
  }, 20_000);

  it("una sala que ya no existe no deja volver", async () => {
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const token = a.reconnectionToken;
    await a.leave();
    await sleep(100);
    await expect(new Client(url).reconnect(token)).rejects.toBeTruthy();
  });
});
