// SPDX-License-Identifier: GPL-2.0-or-later
// Alcance por arma (`reach` en weapons.ts, launchPower): la distancia importa. Primero los números,
// en piso llano; después un test por mapa, sobre el terreno y los arranques de una partida de dos
// (startRound3D), sin viento.
import { describe, expect, it } from "vitest";
import {
  collisionDistance3D,
  createFlatTerrain,
  FULL_REACH,
  launchPower,
  MONEY_START,
  PLAYABLE_WEAPONS,
  POWER_MAX,
  resolveTurn3D,
  simulateWeaponShot3D,
  startingInventory,
  startRound3D,
  TANK_MAX_LIFE,
  TANK_RADIUS,
  terrainHeightAt,
  WEAPONS,
  type MapId,
  type MatchState3D,
  type Player,
  type Shot3DResult,
  type Tank3D,
  type WeaponId,
} from "../src";

type Aim = { yaw: number; pitch: number; power: number };

const armed = (id: string): Player => ({
  id,
  money: MONEY_START,
  inventory: { ...startingInventory(), missile: 3, roller: 2, nuke: 1 },
});
const tankOf = (m: MatchState3D, id: string) => m.tanks.find((t) => t.id === id)!;
const flatDist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Una ronda de dos en `map`, tal como la arma la partida, con el viento en cero. */
function duelOn(map: MapId, seed: number): MatchState3D {
  return { ...startRound3D(seed, [armed("A"), armed("B")], new Set(), map), wind: { x: 0, z: 0 } };
}

/** La cuenta de la fantasma del cliente (computeGhost): simulateWeaponShot3D con el arma, el tanque propio y los vivos. */
function ghost(m: MatchState3D, weapon: WeaponId, me: Tank3D, aim: Aim): Shot3DResult {
  return simulateWeaponShot3D(m.terrain, WEAPONS[weapon], { originX: me.x, originY: me.y, originZ: me.z, ...aim, wind: m.wind, shooterId: me.id }, m.tanks);
}

/** Lo que prueba un jugador empecinado: el cañón girado hasta 12° del rumbo al rival, de 30° a 80° de alto, y la potencia de 300 al máximo. */
function* aims(me: Tank3D, foe: Tank3D): Generator<Aim> {
  const bearing = (Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI;
  for (let turn = -12; turn <= 12; turn += 3)
    for (let pitch = 30; pitch <= 80; pitch += 5)
      for (let power = 300; power <= POWER_MAX; power += 20) yield { yaw: bearing + turn, pitch, power };
}

/** Con `weapon`, de todas esas punterías: la que termina más cerca del rival y la que cae más lejos del que tira (en piso firme). */
function tryAll(m: MatchState3D, weapon: WeaponId, me: Tank3D, foe: Tank3D) {
  let closest = { miss: Infinity, aim: null as Aim | null };
  let farthest = { dist: -Infinity, aim: null as Aim | null, shot: null as Shot3DResult | null };
  for (const aim of aims(me, foe)) {
    const r = ghost(m, weapon, me, aim);
    if (r.outcome !== "ground" && r.outcome !== "tank") continue;
    const miss = r.tankId === foe.id ? 0 : collisionDistance3D(foe, r.x, r.y, r.z);
    if (miss < closest.miss) closest = { miss, aim };
    const dist = flatDist(r, me);
    if (dist > farthest.dist) farthest = { dist, aim, shot: r };
  }
  return { closest, farthest };
}

describe("alcance: un número al lado de cada arma", () => {
  it("en piso llano, con la potencia al máximo y a 45°, cada arma llega hasta su `reach`", () => {
    const flat = createFlatTerrain(600, 9, 10);
    for (const id of [...PLAYABLE_WEAPONS, "babyNuke"] as const) {
      const r = simulateWeaponShot3D(flat, WEAPONS[id], { originX: 20, originY: 10, originZ: 4, yaw: 0, pitch: 45, power: POWER_MAX, wind: { x: 0, z: 0 } });
      // El Roller se mide donde toca el piso, el Rebote donde pica y el Racimo en la cabeza que sigue el tiro.
      const lands = r.landed ?? r.bounce ?? r;
      expect(lands.x - 20, id).toBeGreaterThan(WEAPONS[id].reach - 1);
      expect(lands.x - 20, id).toBeLessThan(WEAPONS[id].reach + 3);
    }
  });

  it("el Bombazo es el que menos llega, después la Chispa, y el tiro largo es el Misil; lo que sale como un Misil llega igual", () => {
    expect(WEAPONS.nuke.reach).toBeLessThan(WEAPONS.babyMissile.reach);
    expect(WEAPONS.babyMissile.reach).toBeLessThan(WEAPONS.missile.reach);
    expect(WEAPONS.nuke.reach * 2).toBeLessThan(WEAPONS.missile.reach); // la tienda dice "menos de la mitad"
    for (const id of ["roller", "napalm", "dirt", "mirv", "leapfrog"] as const) expect(WEAPONS[id].reach, id).toBe(WEAPONS.missile.reach);
    // Ninguna cruza ya el mapa entero, como hacían todas.
    expect(FULL_REACH).toBeCloseTo(252.5, 1);
    for (const w of Object.values(WEAPONS)) expect(w.reach, w.id).toBeLessThan(FULL_REACH);
  });

  it("launchPower: el alcance crece con el cuadrado de la potencia, y la puntería se recorta a [0, POWER_MAX]", () => {
    for (const w of Object.values(WEAPONS)) {
      expect((launchPower(w, POWER_MAX) / POWER_MAX) ** 2, w.id).toBeCloseTo(w.reach / FULL_REACH, 9);
      expect(launchPower(w, 500), w.id).toBeCloseTo(launchPower(w, POWER_MAX) / 2, 9);
      expect(launchPower(w, 5000), w.id).toBe(launchPower(w, POWER_MAX));
      expect(launchPower(w, -5), w.id).toBe(0);
    }
  });

  it("el server y la fantasma hacen la misma cuenta: el Bombazo cae donde lo mostró la fantasma, más corto que el Misil", () => {
    const terrain = createFlatTerrain(257, 257, 10);
    const m: MatchState3D = {
      terrain,
      wind: { x: 0, z: 0 },
      tanks: [
        { id: "A", x: 30, y: 10, z: 128, life: TANK_MAX_LIFE },
        { id: "B", x: 30, y: 10, z: 30, life: TANK_MAX_LIFE },
      ],
      players: [armed("A"), armed("B")],
    };
    const aim = { yaw: 0, pitch: 45, power: POWER_MAX };
    for (const weaponId of ["nuke", "missile", "babyMissile"] as const) {
      const seen = ghost(m, weaponId, tankOf(m, "A"), aim);
      expect(resolveTurn3D(m, { playerId: "A", ...aim, weaponId }).shot, weaponId).toEqual(seen);
      expect(seen.x - 30, weaponId).toBeCloseTo(WEAPONS[weaponId].reach, -1);
    }
  });
});

describe("Isla: el Bombazo no cruza el cerro de lado a lado", () => {
  const CENTER = { x: 128, z: 128 };

  it.each([1, 2, 3, 4, 6, 7])("ronda %i: cae en la ladera de enfrente y no toca al de la costa opuesta; el Misil sí llega", (seed) => {
    const m = duelOn("island", seed);
    const [me, foe] = [tankOf(m, "A"), tankOf(m, "B")];
    // Cada uno en su playa, con el cerro en el medio.
    expect(flatDist(me, foe)).toBeGreaterThan(110);
    expect(flatDist(me, CENTER)).toBeGreaterThan(55);

    const nuke = tryAll(m, "nuke", me, foe);
    // Ninguna puntería deja la explosión (radio 18) a tiro del otro: ni lo roza.
    expect(nuke.closest.miss).toBeGreaterThan(WEAPONS.nuke.explosionRadius);
    // Lo más lejos que cae es pasando el centro de la isla, en piso firme: la ladera de enfrente.
    const far = nuke.farthest.shot!;
    expect(nuke.farthest.dist).toBeGreaterThan(flatDist(me, CENTER) + 15);
    expect(flatDist(far, foe)).toBeLessThan(flatDist(far, me));
    // El server con esa puntería: abre el hoyo ahí, y el de enfrente ni se entera.
    const blast = resolveTurn3D(m, { playerId: "A", ...nuke.farthest.aim!, weaponId: "nuke" });
    expect(terrainHeightAt(blast.state.terrain, far.x, far.z)).toBeLessThan(terrainHeightAt(m.terrain, far.x, far.z) - 5);
    expect(tankOf(blast.state, "B").life).toBe(TANK_MAX_LIFE);
    expect(blast.damage).toEqual([]);

    // El Misil sí cruza: hay una puntería que le saca vida.
    const missile = tryAll(m, "missile", me, foe);
    expect(missile.closest.miss).toBeLessThan(WEAPONS.missile.explosionRadius / 2);
    const hit = resolveTurn3D(m, { playerId: "A", ...missile.closest.aim!, weaponId: "missile" });
    expect(tankOf(hit.state, "B").life).toBeLessThan(TANK_MAX_LIFE);
  });
});

describe("Valle: el tiro largo es el Misil, no el Bombazo", () => {
  it.each([1, 2, 3, 4])("ronda %i: el Misil le pega al de enfrente; el Bombazo abre un hoyo tres veces más ancho, pero se queda corto", (seed) => {
    const m = duelOn("valley", seed);
    const [me, foe] = [tankOf(m, "A"), tankOf(m, "B")];
    const missile = tryAll(m, "missile", me, foe);
    const nuke = tryAll(m, "nuke", me, foe);

    expect(missile.closest.miss).toBeLessThan(WEAPONS.missile.explosionRadius / 2);
    const hit = resolveTurn3D(m, { playerId: "A", ...missile.closest.aim!, weaponId: "missile" });
    expect(tankOf(hit.state, "B").life).toBeLessThan(TANK_MAX_LIFE);

    // El Bombazo gana por el hoyo, no por el alcance: cae a más de un radio del rival, y no le saca vida.
    expect(WEAPONS.nuke.craterRadius).toBeGreaterThanOrEqual(3 * WEAPONS.missile.craterRadius);
    expect(nuke.closest.miss).toBeGreaterThan(WEAPONS.nuke.explosionRadius);
    expect(nuke.farthest.dist).toBeLessThan(flatDist(me, foe) - WEAPONS.nuke.explosionRadius);
    const short = resolveTurn3D(m, { playerId: "A", ...nuke.closest.aim!, weaponId: "nuke" });
    expect(tankOf(short.state, "B").life).toBe(TANK_MAX_LIFE);
  });
});

describe("Cerro: el Rodillo baja hasta un tanque que el Misil no ve", () => {
  it("pasa el cerro que el Misil pega, cae en la bajada y rueda hasta el tanque", () => {
    // En esta ronda B tiene a A a 190 celdas, con un cerro de por medio.
    const m = duelOn("hill", 104);
    const [me, foe] = [tankOf(m, "B"), tankOf(m, "A")];
    const dist = flatDist(me, foe);
    const bearing = (Math.atan2(foe.z - me.z, foe.x - me.x) * 180) / Math.PI;

    // El obstáculo: en la recta entre los dos el piso sube muy por encima de la visual. No se ven.
    let crest = { at: 0, over: -Infinity };
    for (let d = 1; d < dist; d++) {
      const k = d / dist;
      const sight = me.y + (foe.y - me.y) * k + TANK_RADIUS;
      const over = terrainHeightAt(m.terrain, me.x + (foe.x - me.x) * k, me.z + (foe.z - me.z) * k) - sight;
      if (over > crest.over) crest = { at: d, over };
    }
    expect(crest.over).toBeGreaterThan(20);

    // El Misil derecho al rival pega en ese cerro, antes de la cima...
    const direct = ghost(m, "missile", me, { yaw: bearing, pitch: 15, power: POWER_MAX });
    expect(direct.outcome).toBe("ground");
    expect(flatDist(direct, me)).toBeLessThan(crest.at);
    // ...y bombeado tampoco llega: ninguna puntería deja la explosión a tiro del tanque.
    const missile = tryAll(m, "missile", me, foe);
    expect(missile.closest.miss).toBeGreaterThan(WEAPONS.missile.explosionRadius);

    // El Rodillo vuela igual que el Misil, pasa el cerro, toca el piso en la bajada y rueda hasta el tanque.
    let roll: { aim: Aim; shot: Shot3DResult } | null = null;
    for (const aim of aims(me, foe)) {
      const shot = ghost(m, "roller", me, aim);
      if (shot.outcome !== "tank" || shot.tankId !== foe.id || !shot.landed) continue;
      roll = { aim, shot };
      break;
    }
    expect(roll).not.toBeNull();
    const landed = roll!.shot.landed!;
    expect(flatDist(landed, me)).toBeGreaterThan(crest.at);
    expect(flatDist(landed, roll!.shot)).toBeGreaterThan(10); // rodó: no cayó encima
    expect(landed.y).toBeGreaterThan(roll!.shot.y); // cuesta abajo

    // Con esa misma puntería el Misil explota donde el Rodillo tocó el piso, y al tanque no le llega.
    const same = resolveTurn3D(m, { playerId: "B", ...roll!.aim, weaponId: "missile" });
    expect(same.shot.x).toBeCloseTo(landed.x, 6);
    expect(same.shot.z).toBeCloseTo(landed.z, 6);
    expect(tankOf(same.state, "A").life).toBe(TANK_MAX_LIFE);

    // El server resuelve el Rodillo con la cuenta de la fantasma, y le saca vida.
    const rolled = resolveTurn3D(m, { playerId: "B", ...roll!.aim, weaponId: "roller" });
    expect(rolled.shot).toEqual(roll!.shot);
    expect(tankOf(rolled.state, "A").life).toBeLessThan(TANK_MAX_LIFE);
  });
});
