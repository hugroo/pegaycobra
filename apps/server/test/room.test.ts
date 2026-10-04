// Integración: server real + dos clientes del SDK jugando una partida completa de 5 rondas en 3D.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import type { Server } from "@colyseus/core";
import { fireFromShot, inFire, SHOP_ITEMS, simulateShot3D, simulateWeaponShot3D, terrainHeightAt, WEAPONS, WIND_DRIFT_MAX, type Terrain } from "@pegaycobra/sim";
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
          // Ana vende esos Misiles: le queda el neto de la mitad, y Beto ve la misma plata y el mismo inventario que ella.
          a.send("sell", { item: "missile" });
          await until(() => b.state.players.get(a.sessionId).missiles === 0);
          expect(b.state.players.get(a.sessionId).money).toBe(before - SHOP_ITEMS.missile.price / 2);
          await until(() => a.state.players.get(a.sessionId).missiles === 0);
          const inventory = (p: any) => [p.money, p.missiles, p.rollers, p.napalms, p.nukes, p.dirts, p.mirvs, p.leapfrogs, p.shield, p.parachute, p.fuel];
          expect(inventory(b.state.players.get(a.sessionId))).toEqual(inventory(a.state.players.get(a.sessionId)));
          // Un Rodillo: comprado y vendido, y la Chispa no se vende.
          a.send("buy", { item: "roller" });
          await until(() => b.state.players.get(a.sessionId).rollers === 2);
          a.send("sell", { item: "roller" });
          a.send("sell", { item: "babyMissile" });
          await until(() => b.state.players.get(a.sessionId).rollers === 0);
          expect(b.state.players.get(a.sessionId).money).toBe(before - SHOP_ITEMS.missile.price / 2 - SHOP_ITEMS.roller.price / 2);
          // Y vuelve a comprar los Misiles, que los va a tirar en las rondas que siguen.
          a.send("buy", { item: "missile" });
          await until(() => b.state.players.get(a.sessionId).missiles === 3);
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

  it("Napalm: los dos clientes ven el fuego, el terreno no cambia y al que quedó adentro lo quema cada turno", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    const ta = trackTerrain(a);
    const tb = trackTerrain(b);
    const burnsA: any[] = [];
    const burnsB: any[] = [];
    a.onMessage("burn", (m) => burnsA.push(m));
    b.onMessage("burn", (m) => burnsB.push(m));
    for (const r of [a, b]) for (const type of ["shot", "skip", "moved", "roundEnd"]) r.onMessage(type, () => {});
    await until(() => a.state.players?.size === 2 && b.state.players?.size === 2);
    a.send("start");
    await until(() => a.state.phase === "aiming" && tb.fulls === 1);

    const BURN = WEAPONS.napalm.burn!.damagePerTurn;
    const rooms: Record<string, Room<any>> = { [a.sessionId]: a, [b.sessionId]: b };
    const seenBy = (r: Room<any>, id: string) => r.state.players.get(id);
    /** El del turno manda `msg` (por defecto una Baby para atrás, lejos de todos) y espera a que termine el tiro. */
    async function turn(id: string, msg?: object): Promise<void> {
      await until(() => a.state.phase === "aiming" && a.state.turnId === id);
      rooms[id]!.send("fire", msg ?? { yaw: seenBy(a, id).yaw + 180, pitch: 60, power: 250 });
      await until(() => a.state.phase !== "aiming" || a.state.turnId !== id);
      await until(() => a.state.phase !== "animating");
    }

    // Ronda 1: nadie le apunta a nadie, hasta que corta por tiros. En la tienda Ana compra un Napalm y Beto nafta.
    while (a.state.phase !== "shop") await turn(a.state.turnId);
    a.send("buy", { item: "napalm" });
    b.send("buy", { item: "fuel" });
    await until(() => seenBy(b, a.sessionId).napalms === 1 && seenBy(a, b.sessionId).fuel === 1);
    a.send("ready");
    b.send("ready");
    await until(() => a.state.round === 2 && a.state.phase === "aiming" && ta.fulls === 2 && tb.fulls === 2);
    expect(a.state.fires.length).toBe(0);

    // Ronda 2: Beto tira para atrás y Ana busca, con el sim, un Napalm que deje a Beto bien adentro del disco.
    await turn(b.sessionId);
    const me = seenBy(a, a.sessionId);
    const foe = seenBy(a, b.sessionId);
    const tanks = [me, foe].map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number, z: p.z as number }));
    const wind = { x: a.state.windX, z: a.state.windZ };
    const base = (Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI;
    let aim: { yaw: number; pitch: number; power: number } | null = null;
    search: for (let pitch = 35; pitch <= 80; pitch += 5) {
      for (let power = 300; power <= 1000; power += 5) {
        for (let d = 0; d <= 12; d += 0.5) {
          for (const yaw of [base + d, base - d]) {
            const r = simulateWeaponShot3D(ta.terrain!, WEAPONS.napalm, { originX: me.x, originY: me.y, originZ: me.z, yaw, pitch, power, wind, shooterId: me.id }, tanks);
            const f = fireFromShot(WEAPONS.napalm, r, me.id);
            if (f && Math.hypot(f.x - foe.x, f.z - foe.z) <= f.radius - 2) {
              aim = { yaw, pitch, power };
              break search;
            }
          }
        }
      }
    }
    expect(aim).not.toBeNull();

    const heights = tb.terrain!.heights.slice();
    const patches = [ta.patches, tb.patches];
    await turn(a.sessionId, { ...aim, weapon: "napalm" });

    // El fuego está en el estado de los dos, en el mismo lugar, con Beto adentro.
    await until(() => a.state.fires.length === 1 && b.state.fires.length === 1);
    const fire = b.state.fires[0];
    expect({ x: fire.x, z: fire.z, radius: fire.radius }).toEqual({ x: a.state.fires[0].x, z: a.state.fires[0].z, radius: a.state.fires[0].radius });
    expect(fire.radius).toBe(WEAPONS.napalm.burn!.radius);
    expect(inFire(fire, seenBy(b, b.sessionId))).toBe(true);
    expect(seenBy(b, a.sessionId).napalms).toBe(0);
    // No es un cráter: no viajó ningún parche de terreno y el heightmap es el de antes.
    expect([ta.patches, tb.patches]).toEqual(patches);
    expect(tb.terrain!.heights).toEqual(heights);
    expect(ta.terrain!.heights).toEqual(heights);

    // Le toca a Beto: pierde vida al empezar el turno, y lo ven los dos.
    await until(() => burnsA.length === 1 && burnsB.length === 1);
    expect(burnsB[0]).toEqual({ id: b.sessionId, damage: BURN, killed: false });
    await until(() => seenBy(a, b.sessionId).life === 100 - BURN && seenBy(b, b.sessionId).life === 100 - BURN);
    expect(seenBy(b, a.sessionId).points).toBe(BURN);

    // Nadie le tira de nuevo: los dos tiran para atrás y, cuando le vuelve el turno, se quema otra vez.
    await turn(b.sessionId);
    await turn(a.sessionId);
    await until(() => burnsA.length === 2 && burnsB.length === 2);
    await until(() => seenBy(a, b.sessionId).life === 100 - 2 * BURN);

    // Beto sale con nafta: el fuego se queda, pero ya no lo quema.
    const from = seenBy(b, b.sessionId);
    const dx = from.x - fire.x;
    const dz = from.z - fire.z;
    const far = (fire.radius + 3) / Math.max(1e-6, Math.hypot(dx, dz));
    const to = Math.hypot(dx, dz) < 0.5 ? { x: fire.x + fire.radius + 3, z: fire.z } : { x: fire.x + dx * far, z: fire.z + dz * far };
    b.send("move", { moveTo: to });
    await until(() => !inFire(fire, seenBy(a, b.sessionId)));
    await turn(b.sessionId);
    await turn(a.sessionId);
    await until(() => a.state.phase === "aiming" && a.state.turnId === b.sessionId);
    await sleep(100);
    expect(burnsB).toHaveLength(2);
    expect(seenBy(a, b.sessionId).life).toBe(100 - 2 * BURN);
    expect(b.state.fires.length).toBe(1);

    await a.leave();
    await b.leave();
  }, 60_000);

  it("Tierra: los dos clientes ven subir el mismo terreno, y el tanque de abajo sube con la loma sin perder vida", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    const ta = trackTerrain(a);
    const tb = trackTerrain(b);
    const shotsSeenByB: any[] = [];
    b.onMessage("shot", (m) => shotsSeenByB.push(m));
    a.onMessage("shot", () => {});
    for (const r of [a, b]) for (const type of ["skip", "moved", "roundEnd", "burn"]) r.onMessage(type, () => {});
    await until(() => a.state.players?.size === 2 && b.state.players?.size === 2);
    a.send("start");
    await until(() => a.state.phase === "aiming" && tb.fulls === 1);

    const rooms: Record<string, Room<any>> = { [a.sessionId]: a, [b.sessionId]: b };
    const seenBy = (r: Room<any>, id: string) => r.state.players.get(id);
    /** El del turno manda `msg` (por defecto una Baby para atrás, lejos de todos) y espera a que termine el tiro. */
    async function turn(id: string, msg?: object): Promise<void> {
      await until(() => a.state.phase === "aiming" && a.state.turnId === id);
      rooms[id]!.send("fire", msg ?? { yaw: seenBy(a, id).yaw + 180, pitch: 60, power: 250 });
      await until(() => a.state.phase !== "aiming" || a.state.turnId !== id);
      await until(() => a.state.phase !== "animating");
    }

    // Ronda 1: nadie le apunta a nadie, hasta que corta por tiros. En la tienda Ana compra una Tierra.
    while (a.state.phase !== "shop") await turn(a.state.turnId);
    const money = seenBy(b, a.sessionId).money;
    a.send("buy", { item: "dirt" });
    await until(() => seenBy(b, a.sessionId).dirts === 1);
    expect(seenBy(b, a.sessionId).money).toBe(money - SHOP_ITEMS.dirt.price);
    a.send("ready");
    b.send("ready");
    await until(() => a.state.round === 2 && a.state.phase === "aiming" && ta.fulls === 2 && tb.fulls === 2);

    // Ronda 2: Beto tira para atrás y Ana busca, con el sim, una Tierra que le caiga encima a Beto.
    await turn(b.sessionId);
    const me = seenBy(a, a.sessionId);
    const foe = seenBy(a, b.sessionId);
    const tanks = [me, foe].map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number, z: p.z as number }));
    const wind = { x: a.state.windX, z: a.state.windZ };
    const base = (Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI;
    let aim: { yaw: number; pitch: number; power: number } | null = null;
    search: for (let pitch = 35; pitch <= 80; pitch += 5) {
      for (let power = 300; power <= 1000; power += 5) {
        for (let d = 0; d <= 12; d += 0.5) {
          for (const yaw of [base + d, base - d]) {
            const r = simulateWeaponShot3D(ta.terrain!, WEAPONS.dirt, { originX: me.x, originY: me.y, originZ: me.z, yaw, pitch, power, wind, shooterId: me.id }, tanks);
            if ((r.outcome === "ground" || r.outcome === "tank") && Math.hypot(r.x - foe.x, r.z - foe.z) <= 3) {
              aim = { yaw, pitch, power };
              break search;
            }
          }
        }
      }
    }
    expect(aim).not.toBeNull();

    const heights = tb.terrain!.heights.slice();
    const patches = [ta.patches, tb.patches];
    const foeY = foe.y as number;
    const lives = [me.life, foe.life];
    await turn(a.sessionId, { ...aim, weapon: "dirt" });

    // A los dos les llegó un parche de terreno, el mismo, y adentro todo subió: es una loma, no un cráter.
    await until(() => ta.patches === patches[0]! + 1 && tb.patches === patches[1]! + 1);
    expect(ta.terrain!.heights).toEqual(tb.terrain!.heights);
    expect(tb.terrain!.heights.every((h, i) => h >= heights[i]!)).toBe(true);
    const at = Math.round(foe.x) + Math.round(foe.z) * tb.terrain!.width;
    expect(tb.terrain!.heights[at]!).toBeGreaterThan(heights[at]! + 5);

    // Beto quedó arriba de la loma, apoyado en el piso nuevo, y lo ven igual los dos.
    await until(() => seenBy(a, b.sessionId).y > foeY + 5 && seenBy(b, b.sessionId).y > foeY + 5);
    expect(seenBy(b, b.sessionId).y).toBe(seenBy(a, b.sessionId).y);
    expect(seenBy(b, b.sessionId).y).toBeCloseTo(terrainHeightAt(tb.terrain!, foe.x, foe.z), 3);
    expect([seenBy(b, a.sessionId).life, seenBy(b, b.sessionId).life]).toEqual(lives);
    expect(seenBy(b, a.sessionId).points).toBe(0);
    expect(seenBy(b, a.sessionId).dirts).toBe(0);
    const shot = shotsSeenByB.at(-1);
    expect(shot).toMatchObject({ shooterId: a.sessionId, weapon: "dirt", damage: 0, blocked: [] });

    await a.leave();
    await b.leave();
  }, 60_000);

  it("Racimo: los dos clientes ven la apertura, los mismos hoyos y el daño sumado", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    const ta = trackTerrain(a);
    const tb = trackTerrain(b);
    const shotsSeenByA: any[] = [];
    const shotsSeenByB: any[] = [];
    a.onMessage("shot", (m) => shotsSeenByA.push(m));
    b.onMessage("shot", (m) => shotsSeenByB.push(m));
    for (const r of [a, b]) for (const type of ["skip", "moved", "roundEnd", "burn"]) r.onMessage(type, () => {});
    await until(() => a.state.players?.size === 2 && b.state.players?.size === 2);
    a.send("start");
    await until(() => a.state.phase === "aiming" && tb.fulls === 1);

    const rooms: Record<string, Room<any>> = { [a.sessionId]: a, [b.sessionId]: b };
    const seenBy = (r: Room<any>, id: string) => r.state.players.get(id);
    /** El del turno manda `msg` (por defecto una Baby para atrás, lejos de todos) y espera a que termine el tiro. */
    async function turn(id: string, msg?: object): Promise<void> {
      await until(() => a.state.phase === "aiming" && a.state.turnId === id);
      rooms[id]!.send("fire", msg ?? { yaw: seenBy(a, id).yaw + 180, pitch: 60, power: 250 });
      await until(() => a.state.phase !== "aiming" || a.state.turnId !== id);
      await until(() => a.state.phase !== "animating");
    }

    // Ronda 1: nadie le apunta a nadie, hasta que corta por tiros. En la tienda Ana compra un Racimo.
    while (a.state.phase !== "shop") await turn(a.state.turnId);
    const money = seenBy(b, a.sessionId).money;
    a.send("buy", { item: "mirv" });
    await until(() => seenBy(b, a.sessionId).mirvs === 1);
    expect(seenBy(b, a.sessionId).money).toBe(money - SHOP_ITEMS.mirv.price);
    a.send("ready");
    b.send("ready");
    await until(() => a.state.round === 2 && a.state.phase === "aiming" && ta.fulls === 2 && tb.fulls === 2);

    // Ronda 2: Beto tira para atrás y Ana busca, con el sim, un Racimo que se abra bien arriba, caiga
    // entero en el mapa y cuya cabeza del medio le explote cerca a Beto.
    await turn(b.sessionId);
    const me = seenBy(a, a.sessionId);
    const foe = seenBy(a, b.sessionId);
    const tanks = [me, foe].map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number, z: p.z as number }));
    const wind = { x: a.state.windX, z: a.state.windZ };
    const base = (Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI;
    const landed = (h: { outcome: string }) => h.outcome === "ground" || h.outcome === "tank";
    let aim: { yaw: number; pitch: number; power: number } | null = null;
    search: for (let pitch = 35; pitch <= 80; pitch += 5) {
      for (let power = 300; power <= 1000; power += 5) {
        for (let d = 0; d <= 12; d += 0.5) {
          for (const yaw of [base + d, base - d]) {
            const r = simulateWeaponShot3D(ta.terrain!, WEAPONS.mirv, { originX: me.x, originY: me.y, originZ: me.z, yaw, pitch, power, wind, shooterId: me.id }, tanks);
            const top = r.split?.y ?? 0;
            if (r.split?.heads.every((h) => landed(h) && top > h.y + 12) && Math.hypot(r.x - foe.x, r.z - foe.z) <= 3) {
              aim = { yaw, pitch, power };
              break search;
            }
          }
        }
      }
    }
    expect(aim).not.toBeNull();

    const heights = tb.terrain!.heights.slice();
    const patches = [ta.patches, tb.patches];
    const foeLife = foe.life as number;
    await turn(a.sessionId, { ...aim, weapon: "mirv" });

    // Los dos reciben el mismo tiro: el recorrido hasta donde se abre, en el aire, y de ahí cinco cabezas.
    const shot = shotsSeenByB.at(-1);
    expect(shot).toEqual(shotsSeenByA.at(-1));
    expect(shot).toMatchObject({ shooterId: a.sessionId, weapon: "mirv" });
    expect(shot.heads).toHaveLength(WEAPONS.mirv.split!.heads);
    const open = shot.path.slice(-3) as number[];
    const ends = (shot.heads as { path: number[] }[]).map((h) => h.path.slice(-3));
    for (const h of shot.heads) expect(h.path.slice(0, 3)).toEqual(open);
    for (const end of ends) expect(open[1]!).toBeGreaterThan(end[1]! + 10); // se abrió bien arriba de donde cayeron
    // Los impactos no son el mismo punto.
    expect(new Set(ends.map((e) => `${Math.round(e[0]!)},${Math.round(e[2]!)}`)).size).toBe(ends.length);

    // Un solo parche de terreno, el mismo para los dos, y bajó el piso donde cayó cada cabeza: los mismos hoyos.
    await until(() => ta.patches === patches[0]! + 1 && tb.patches === patches[1]! + 1);
    expect(ta.terrain!.heights).toEqual(tb.terrain!.heights);
    expect(tb.terrain!.heights.every((h, i) => h <= heights[i]!)).toBe(true);
    for (const [x, , z] of ends) {
      const at = Math.trunc(x!) + Math.trunc(z!) * tb.terrain!.width;
      expect(tb.terrain!.heights[at]!).toBeLessThan(heights[at]!);
    }

    // El cartel trae el daño de todas las cabezas sumado: es la vida que perdió Beto, y lo ven igual los dos.
    await until(() => seenBy(a, b.sessionId).life < foeLife && seenBy(b, b.sessionId).life < foeLife);
    expect(seenBy(b, b.sessionId).life).toBe(seenBy(a, b.sessionId).life);
    expect(shot.damage).toBeGreaterThan(0);
    expect(shot.damage).toBeCloseTo(foeLife - seenBy(b, b.sessionId).life, 1);
    expect(seenBy(b, a.sessionId).points).toBeGreaterThan(0);
    expect(seenBy(b, a.sessionId).mirvs).toBe(0);

    await a.leave();
    await b.leave();
  }, 60_000);

  it("Rebote: los dos clientes ven el mismo camino con el pique, y el mismo hoyo en el segundo golpe", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    const ta = trackTerrain(a);
    const tb = trackTerrain(b);
    const shotsSeenByA: any[] = [];
    const shotsSeenByB: any[] = [];
    a.onMessage("shot", (m) => shotsSeenByA.push(m));
    b.onMessage("shot", (m) => shotsSeenByB.push(m));
    for (const r of [a, b]) for (const type of ["skip", "moved", "roundEnd", "burn"]) r.onMessage(type, () => {});
    await until(() => a.state.players?.size === 2 && b.state.players?.size === 2);
    a.send("start");
    await until(() => a.state.phase === "aiming" && tb.fulls === 1);

    const rooms: Record<string, Room<any>> = { [a.sessionId]: a, [b.sessionId]: b };
    const seenBy = (r: Room<any>, id: string) => r.state.players.get(id);
    /** El del turno manda `msg` (por defecto una Baby para atrás, lejos de todos) y espera a que termine el tiro. */
    async function turn(id: string, msg?: object): Promise<void> {
      await until(() => a.state.phase === "aiming" && a.state.turnId === id);
      rooms[id]!.send("fire", msg ?? { yaw: seenBy(a, id).yaw + 180, pitch: 60, power: 250 });
      await until(() => a.state.phase !== "aiming" || a.state.turnId !== id);
      await until(() => a.state.phase !== "animating");
    }

    // Ronda 1: nadie le apunta a nadie, hasta que corta por tiros. En la tienda Ana compra un pack de Rebote.
    while (a.state.phase !== "shop") await turn(a.state.turnId);
    const money = seenBy(b, a.sessionId).money;
    a.send("buy", { item: "leapfrog" });
    await until(() => seenBy(b, a.sessionId).leapfrogs === 2);
    expect(seenBy(b, a.sessionId).money).toBe(money - SHOP_ITEMS.leapfrog.price);
    a.send("ready");
    b.send("ready");
    await until(() => a.state.round === 2 && a.state.phase === "aiming" && ta.fulls === 2 && tb.fulls === 2);

    // Ronda 2: Beto tira para atrás y Ana busca, con el sim, un Rebote que pique en el piso y vuelva
    // a caer en el mapa, lejos del pique y lejos de los dos tanques.
    await turn(b.sessionId);
    const me = seenBy(a, a.sessionId);
    const foe = seenBy(a, b.sessionId);
    const tanks = [me, foe].map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number, z: p.z as number }));
    const wind = { x: a.state.windX, z: a.state.windZ };
    const base = (Math.atan2(128 - me.z, 128 - me.x) * 180) / Math.PI; // hacia el centro del mapa
    const reach = WEAPONS.leapfrog.explosionRadius + 6;
    let aim: { yaw: number; pitch: number; power: number } | null = null;
    search: for (let pitch = 40; pitch <= 70; pitch += 5) {
      for (let power = 300; power <= 700; power += 20) {
        for (const yaw of [base, base + 20, base - 20, base + 40, base - 40]) {
          const r = simulateWeaponShot3D(ta.terrain!, WEAPONS.leapfrog, { originX: me.x, originY: me.y, originZ: me.z, yaw, pitch, power, wind, shooterId: me.id }, tanks);
          if (r.outcome !== "ground" || !r.bounce) continue;
          if (Math.hypot(r.x - r.bounce.x, r.z - r.bounce.z) < reach) continue;
          if (tanks.some((t) => Math.hypot(r.x - t.x, r.z - t.z) < 3 * reach)) continue;
          aim = { yaw, pitch, power };
          break search;
        }
      }
    }
    expect(aim).not.toBeNull();

    const heights = tb.terrain!.heights.slice();
    const before: Terrain = { width: tb.terrain!.width, depth: tb.terrain!.depth, heights };
    const patches = [ta.patches, tb.patches];
    await turn(a.sessionId, { ...aim, weapon: "leapfrog" });

    // Los dos reciben el mismo tiro: un solo camino, con el pique en el medio.
    const shot = shotsSeenByB.at(-1);
    expect(shot).toEqual(shotsSeenByA.at(-1));
    expect(shot).toMatchObject({ shooterId: a.sessionId, weapon: "leapfrog", outcome: "ground", damage: 0, blocked: [] });
    expect(shot.heads).toBeUndefined();
    const steps = shot.path.length / 3 - 1;
    const tick = shot.bounce.tick as number;
    expect(tick).toBeGreaterThan(0);
    expect(tick).toBeLessThan(steps);
    const at = (i: number) => shot.path.slice(i * 3, i * 3 + 3) as [number, number, number];
    const [px, py, pz] = at(tick);
    // Ahí tocó el piso (el camino viaja redondeado a 0.01)...
    expect(Math.abs(py - terrainHeightAt(before, px, pz))).toBeLessThan(0.05);
    // ...venía por el aire y salió subiendo...
    const [qx, qy, qz] = at(tick - 1);
    expect(qy).toBeGreaterThan(terrainHeightAt(before, qx, qz) - 0.02);
    expect(at(tick + 1)[1]).toBeGreaterThan(py);
    // ...y terminó en otro lado, que es donde va el cartel.
    const [ex, ey, ez] = at(steps);
    expect(Math.hypot(ex - px, ez - pz)).toBeGreaterThanOrEqual(reach - 0.1);
    expect(shot.impact).toEqual({ x: ex, y: ey, z: ez });

    // Un solo parche de terreno, el mismo para los dos: el hoyo está en el segundo golpe y donde picó no cambió nada.
    await until(() => ta.patches === patches[0]! + 1 && tb.patches === patches[1]! + 1);
    expect(ta.terrain!.heights).toEqual(tb.terrain!.heights);
    const cell = (x: number, z: number) => Math.round(x) + Math.round(z) * tb.terrain!.width;
    expect(tb.terrain!.heights[cell(ex, ez)]!).toBeLessThan(heights[cell(ex, ez)]!);
    expect(tb.terrain!.heights[cell(px, pz)]!).toBe(heights[cell(px, pz)]!);
    expect(tb.terrain!.heights.every((h, i) => h <= heights[i]!)).toBe(true);
    await until(() => seenBy(b, a.sessionId).leapfrogs === 1);
    expect(seenBy(a, a.sessionId).leapfrogs).toBe(1);

    await a.leave();
    await b.leave();
  }, 60_000);

  it("el viento se corre al empezar cada turno, nunca en pleno vuelo, y los dos clientes reciben el mismo", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    const ta = trackTerrain(a);
    const tb = trackTerrain(b);
    const windOf = (r: Room<any>) => ({ x: r.state.windX as number, z: r.state.windZ as number });
    /** El viento que tenía cada cliente cuando le llegó cada "shot": el del tiro que está por ver volar. */
    const atShot: { x: number; z: number }[][] = [[], []];
    const shots: any[] = [];
    a.onMessage("shot", (m) => (shots.push(m), atShot[0]!.push(windOf(a))));
    b.onMessage("shot", () => atShot[1]!.push(windOf(b)));
    for (const r of [a, b]) for (const type of ["skip", "moved", "roundEnd", "burn"]) r.onMessage(type, () => {});
    await until(() => a.state.players?.size === 2 && b.state.players?.size === 2);
    a.send("start");
    await until(() => a.state.phase === "aiming" && b.state.phase === "aiming" && ta.fulls === 1 && tb.fulls === 1);

    const rooms: Record<string, Room<any>> = { [a.sessionId]: a, [b.sessionId]: b };
    const winds: { x: number; z: number }[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const id = a.state.turnId as string;
      await until(() => b.state.phase === "aiming" && b.state.turnId === id);
      // Antes de apuntar, las dos pestañas tienen el mismo vector.
      const wind = windOf(a);
      expect(windOf(b)).toEqual(wind);
      winds.push(wind);

      // Una Chispa para atrás, lejos de todos. El server la tira con ese mismo viento: el recorrido
      // que manda es el que da el sim con lo que ve el cliente (la fantasma), punto por punto.
      const me = a.state.players.get(id);
      const aim = { yaw: me.yaw + 180, pitch: 60, power: 250 };
      const ghost = simulateShot3D(ta.terrain!, { originX: me.x, originY: me.y, originZ: me.z, ...aim, wind, shooterId: id }, [], { recordPath: true });
      rooms[id]!.send("fire", aim);
      await until(() => atShot[0]!.length === turn + 1 && atShot[1]!.length === turn + 1);
      const path = shots[turn].path as number[];
      expect(path).toHaveLength(ghost.path!.length);
      path.forEach((v, i) => expect(Math.abs(v - ghost.path![i]!)).toBeLessThan(0.02));
      // En pleno vuelo el cartel sigue mostrando el viento con el que se tiró.
      expect(atShot[0]![turn]).toEqual(wind);
      expect(atShot[1]![turn]).toEqual(wind);
      await until(() => a.state.phase === "aiming" && a.state.turnId !== id);
    }

    // Dos turnos seguidos nunca tienen el mismo viento, y no pega un salto: se corre a lo sumo WIND_DRIFT_MAX.
    for (let i = 1; i < winds.length; i++) {
      const step = Math.hypot(winds[i]!.x - winds[i - 1]!.x, winds[i]!.z - winds[i - 1]!.z);
      expect(step).toBeGreaterThan(0.1);
      expect(step).toBeLessThanOrEqual(WIND_DRIFT_MAX + 1e-4);
    }

    await a.leave();
    await b.leave();
  }, 30_000);

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
