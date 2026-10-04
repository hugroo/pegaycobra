// SPDX-License-Identifier: GPL-2.0-or-later
// Partida en 3D: viento vectorial, ubicación de tanques, caída y resolución de un disparo.
// Mismas reglas que turn.ts (perfil), sobre el terreno width × depth:
//   tiro (shot3d.ts; el Roller además rueda, roller.ts) → cráter en disco (terrain.ts)
//   → daño de explosión (damage.ts), salvo a quien lo tapa un escudo (al Nuke no lo tapa)
//   → caídas y daño de caída → el que quedó en el agua muere → plata para quien disparó (economy.ts).
// El tiro que cae al agua (WATER_LEVEL) se hunde: ni cráter, ni explosión, ni fuego, ni loma.
// El Napalm no abre cráter ni explota: deja un fuego (napalm.ts) que quema al empezar cada turno.
// La Dirt Ball tampoco: levanta una loma (terrain.ts) y el tanque que quedó debajo sube con ella.
// El MIRV se abre en el aire (mirv.ts) y cada cabeza es un golpe aparte, resuelto con estas mismas reglas.
// El Leap Frog pica y sigue (bounce.ts): el golpe es uno solo, donde termina el segundo tramo.
// Orígenes: Explosion.cpp, TargetDamageCalc.cpp, TargetDamage.cpp, TargetFalling.cpp, Wind.cpp.

import { TANK_RADIUS, WATER_LEVEL, WIND_MAX } from "./constants";
import { craterDepthAt } from "./crater";
import { applyDamage, explosionDamage, fallDamage, isAlive, type Tank } from "./damage";
import { canFire, clampMoney, consumeAmmo, moneyForDamage } from "./economy";
import { TANK_START_HEIGHT_MAX, TANK_START_HEIGHT_MIN } from "./match";
import { shotImpacts } from "./mirv";
import { fireFromShot, inFire, type Fire } from "./napalm";
import { simulateWeaponShot3D } from "./roller";
import type { Shot3DResult, Wind } from "./shot3d";
import {
  applyCraterTerrain,
  applyMoundTerrain,
  flattenTerrainUnder,
  isWater,
  terrainHeightAt,
  type Terrain,
} from "./terrain";
import type { DamageEvent, Player } from "./turn";
import { isPlayable, WEAPONS, type WeaponId } from "./weapons";

/** Tanque en 3D. (x, y, z) es la base [wu]; y es la altura. */
export interface Tank3D extends Tank {
  readonly z: number;
}

export interface MatchState3D {
  readonly terrain: Terrain;
  readonly wind: Wind;
  readonly tanks: readonly Tank3D[];
  readonly players: readonly Player[];
  /** Fuegos prendidos en la ronda (napalm.ts). Ausente = ninguno; una ronda nueva arranca sin fuego. */
  readonly fires?: readonly Fire[];
}

export interface FireCommand3D {
  playerId: string;
  /** [grados] 0 = +X, 90 = +Z */
  yaw: number;
  /** [grados] 0..90 */
  pitch: number;
  /** [0, POWER_MAX] */
  power: number;
  weaponId?: WeaponId;
}

export interface FallEvent3D {
  tankId: string;
  fromY: number;
  toY: number;
  distance: number;
  /** El tanque tenía paracaídas activo: la caída no hizo daño. */
  parachute: boolean;
  /** El escudo absorbió este mismo tiro: la caída a su cráter tampoco hizo daño. */
  shielded: boolean;
}

export interface TurnResult3D {
  state: MatchState3D;
  shot: Shot3DResult;
  damage: DamageEvent[];
  falls: FallEvent3D[];
  /**
   * Tanques a los que la explosión les iba a hacer daño y el escudo lo absorbió (y se gastó). Con el
   * MIRV, el escudo absorbe una sola cabeza: el mismo tanque puede estar acá y también en `damage`.
   */
  blocked: string[];
  /** El fuego que prendió este tiro (Napalm), ya agregado a state.fires. null si no prendió nada. */
  fire: Fire | null;
}

/**
 * Viento con el que arranca la ronda, como vector en XZ. Wind::newLevel() (WindRandom):
 * velocidad = trunc(rand · 5.9) → 0..5; ángulo = rand · 360°; dirección = (sin a, cos a).
 * El "y" del piso del original es nuestro z.
 */
export function rollWind3D(rng: () => number): Wind {
  const speed = Math.trunc(rng() * 5.9);
  if (speed <= 0) return { x: 0, z: 0 };
  const a = (rng() * 360 * Math.PI) / 180;
  return { x: speed * Math.sin(a), z: speed * Math.cos(a) };
}

/** Lo menos que se corre el viento de un turno al siguiente: nunca queda igual. [unidad de viento] */
export const WIND_DRIFT_MIN = 0.25;
/** Lo más que se corre el viento de un turno al siguiente: no pasa de golpe a un huracán. [unidad de viento] */
export const WIND_DRIFT_MAX = 1;

/**
 * Viento del turno que empieza: el del turno anterior, corrido entre WIND_DRIFT_MIN y WIND_DRIFT_MAX
 * hacia cualquier lado. Regla propia: no se sortea de cero. Si el paso lo sacaría de WIND_MAX, se da
 * para el otro lado, y si tampoco entra se recorta al borde. Sale ya en float32, que es como viaja
 * por la red: el server tira con el mismo número que ve el cliente.
 */
export function driftWind3D(wind: Wind, rng: () => number): Wind {
  const step = WIND_DRIFT_MIN + rng() * (WIND_DRIFT_MAX - WIND_DRIFT_MIN);
  const a = rng() * Math.PI * 2;
  const dx = step * Math.cos(a);
  const dz = step * Math.sin(a);
  let x = wind.x + dx;
  let z = wind.z + dz;
  if (Math.hypot(x, z) > WIND_MAX) {
    x = wind.x - dx;
    z = wind.z - dz;
  }
  const mag = Math.hypot(x, z);
  if (mag > WIND_MAX) {
    x *= WIND_MAX / mag;
    z *= WIND_MAX / mag;
  }
  return { x: Math.fround(x), z: Math.fround(z) };
}

/** Distancia mínima garantizada entre tanques al empezar. [wu = celdas] */
export const TANK_MIN_SEPARATION_3D = 60;

/**
 * Ubica `count` tanques lejos entre sí. Regla propia (el placeTank() del original es al azar y
 * no garantiza distancia): los tanques van sobre un anillo alrededor del centro, repartidos en
 * ángulos iguales con un giro al azar, y cada uno se corre un poco al azar buscando suelo en
 * [5.5, 70] (defnhilly.xml). Si un candidato queda a menos de TANK_MIN_SEPARATION_3D de otro,
 * se descarta; si no aparece ninguno bueno, queda el punto exacto del anillo. Si ese punto es agua
 * (o quedó pegado a otro tanque), se corre al piso firme más cercano que respete la separación
 * (nearestStart): nadie nace en el lago.
 * Con el anillo a 0.36 del ancho, la cuerda entre vecinos es ≥ 130 wu con 4 jugadores.
 */
export function placeTanks3D(terrain: Terrain, count: number, rng: () => number): { x: number; z: number }[] {
  const cx = (terrain.width - 1) / 2;
  const cz = (terrain.depth - 1) / 2;
  const radius = Math.min(cx, cz) * 0.72;
  const spin = rng() * Math.PI * 2;
  const step = (Math.PI * 2) / Math.max(1, count);
  const placed: { x: number; z: number }[] = [];
  for (let n = 0; n < count; n++) {
    const base = spin + step * n;
    let pick = { x: cx + Math.cos(base) * radius, z: cz + Math.sin(base) * radius };
    let found = false;
    for (let i = 0; i < 60; i++) {
      const a = base + (rng() - 0.5) * step * 0.3;
      const r = radius * (0.85 + rng() * 0.25);
      const cand = { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
      const h = terrainHeightAt(terrain, cand.x, cand.z);
      if (h < TANK_START_HEIGHT_MIN || h > TANK_START_HEIGHT_MAX) continue;
      if (placed.some((p) => Math.hypot(p.x - cand.x, p.z - cand.z) < TANK_MIN_SEPARATION_3D)) continue;
      pick = cand;
      found = true;
      break;
    }
    const ring = pick;
    const tooClose = placed.some((p) => Math.hypot(p.x - ring.x, p.z - ring.z) < TANK_MIN_SEPARATION_3D);
    if (!found && (tooClose || isWater(terrain, ring.x, ring.z))) pick = nearestStart(terrain, ring, placed) ?? ring;
    placed.push(pick);
  }
  return placed;
}

/**
 * La celda de piso firme más cercana a `from` que queda a TANK_MIN_SEPARATION_3D o más de los ya
 * ubicados. Se prefiere suelo con altura de arranque ([5.5, 70]); si no hay, cualquiera que no sea
 * agua. Las dos filas del borde no cuentan. null si el mapa no tiene dónde.
 */
function nearestStart(
  terrain: Terrain,
  from: { x: number; z: number },
  placed: readonly { x: number; z: number }[],
): { x: number; z: number } | null {
  let good: { x: number; z: number } | null = null;
  let dry: { x: number; z: number } | null = null;
  let goodD = Infinity;
  let dryD = Infinity;
  for (let z = 2; z < terrain.depth - 2; z++) {
    for (let x = 2; x < terrain.width - 2; x++) {
      const h = terrain.heights[x + z * terrain.width]!;
      if (!(h > WATER_LEVEL)) continue;
      const start = h >= TANK_START_HEIGHT_MIN && h <= TANK_START_HEIGHT_MAX;
      const d = Math.hypot(x - from.x, z - from.z);
      if (d >= (start ? goodD : dryD)) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < TANK_MIN_SEPARATION_3D)) continue;
      if (start) [good, goodD] = [{ x, z }, d];
      else [dry, dryD] = [{ x, z }, d];
    }
  }
  return good ?? dry;
}

export function tanks3DAt(
  terrain: Terrain,
  ids: readonly string[],
  spots: readonly { x: number; z: number }[],
  life: number,
): Tank3D[] {
  return ids.map((id, i) => {
    const { x, z } = spots[i]!;
    return { id, x, y: terrainHeightAt(terrain, x, z), z, life };
  });
}

/**
 * Altura de orilla: hasta acá, el cráter de un Missile al pie baja el piso hasta el agua
 * (WATER_LEVEL más lo que cava en el centro). [wu]
 */
export const SHORE_LEVEL = WATER_LEVEL + craterDepthAt(WEAPONS.missile.craterRadius, 0);

/**
 * ¿El piso en (x, z) está a un hoyo del lago? Piso firme, pero tan bajo que un Missile ahí lo deja
 * en agua. Es solo un aviso para el cliente (la marca de orilla): no cambia el daño ni la regla del
 * agua. Sale del terreno y la posición, que son los del server: todas las pestañas ven lo mismo.
 */
export function onShore(terrain: Terrain, x: number, z: number): boolean {
  const h = terrainHeightAt(terrain, x, z);
  return h > WATER_LEVEL && h <= SHORE_LEVEL;
}

/** Distancia del punto a la superficie de la esfera del tanque (0 adentro). [wu] */
export function collisionDistance3D(t: Tank3D, px: number, py: number, pz: number): number {
  return Math.max(0, Math.hypot(px - t.x, py - (t.y + TANK_RADIUS), pz - t.z) - TANK_RADIUS);
}

/** Si el suelo quedó por debajo de la base, el tanque cae, se aplana el piso y se calcula el daño. */
export function settleTank3D(
  terrain: Terrain,
  tank: Tank3D,
): { terrain: Terrain; tank: Tank3D; fall?: { fromY: number; toY: number; distance: number; damage: number } } {
  if (!isAlive(tank)) return { terrain, tank };
  const ground = terrainHeightAt(terrain, tank.x, tank.z);
  if (!(ground < tank.y)) return { terrain, tank };
  const distance = tank.y - ground;
  const y = Math.fround(ground);
  return {
    terrain: flattenTerrainUnder(terrain, tank.x, y, tank.z),
    tank: { ...tank, y },
    fall: { fromY: tank.y, toY: ground, distance, damage: fallDamage(distance) },
  };
}

/**
 * Resuelve un disparo 3D. Mismas validaciones que resolveTurn: jugador vivo, arma jugable
 * (Baby Missile, Missile, Roller, Napalm, Nuke, Dirt Ball, MIRV, Leap Frog) y con munición. No recibe daño ni impacto: los calcula.
 *
 * Escudo (regla propia, campaign.ts): si la explosión (también la del Roller) le iba a sacar vida
 * a un tanque con escudo, el escudo absorbe ese tiro y se gasta. El cráter se abre igual y el
 * tanque cae a él, pero la caída de ese mismo tiro tampoco le saca vida: si no, con el cráter del
 * Missile el escudo no salvaría a nadie. Lo que el escudo no tapa es la caída sola: si le sacan el
 * piso sin que la explosión lo alcance, el escudo no se gasta y la caída duele como siempre.
 *
 * Nuke (piercesShield): el escudo no lo frena ni se gasta. La explosión y la caída a su cráter le
 * sacan vida al tanque como si no tuviera escudo, y `blocked` queda vacío.
 *
 * Napalm: donde termina el tiro queda un fuego (fireFromShot) y nada más. Sin cráter el terreno es
 * el mismo objeto que entró, nadie cae, y como no hay explosión tampoco se gasta ningún escudo.
 *
 * Dirt Ball (mound): donde termina el tiro el piso sube (applyMoundTerrain). No es un golpe: no saca
 * vida, no paga y el escudo ni la frena ni se gasta. Regla propia: en el original la tierra tapa al
 * tanque; acá el tanque que quedó debajo sube con la loma y queda apoyado arriba, con la vida que tenía.
 *
 * MIRV (split): si el tiro se abrió, cada cabeza es un golpe, y se resuelven de a uno en el orden en
 * que caen: su cráter, su explosión y las caídas a ese cráter, con los tanques como los dejó el golpe
 * anterior. El escudo absorbe la primera cabeza que le iba a sacar vida y se gasta ahí: la caída a
 * ese cráter no duele, pero la cabeza siguiente pega como a cualquiera. El daño de todas va en `damage`.
 *
 * Leap Frog (bounce): donde pica no pasa nada, ni cráter ni daño. Explota una vez, como un Missile,
 * donde termina el tiro (el segundo golpe, o el primero si fue contra un tanque).
 *
 * Agua (regla propia, WATER_LEVEL): el golpe que cae al agua ("water") se hunde y no hace nada. Y el
 * tanque vivo que queda parado en el agua, después de cada golpe y al terminar el turno, muere: lo
 * que le quedaba de vida va a `damage` con causa "water" y lo cobra el que disparó, como una caída.
 * No lo salva el paracaídas ni el escudo (que tampoco se gasta por eso).
 */
export function resolveTurn3D(
  state: MatchState3D,
  cmd: FireCommand3D,
  options: { recordPath?: boolean } = {},
): TurnResult3D {
  const weaponId = cmd.weaponId ?? "babyMissile";
  if (!isPlayable(weaponId)) throw new Error(`arma no jugable en el MVP: ${weaponId}`);
  const weapon = WEAPONS[weaponId];

  const shooterIdx = state.players.findIndex((p) => p.id === cmd.playerId);
  const shooterPlayer = state.players[shooterIdx];
  const shooterTank = state.tanks.find((t) => t.id === cmd.playerId);
  if (!shooterPlayer || !shooterTank) throw new Error(`jugador desconocido: ${cmd.playerId}`);
  if (!isAlive(shooterTank)) throw new Error(`el tanque de ${cmd.playerId} está muerto`);
  if (!canFire(shooterPlayer.inventory, weaponId)) throw new Error(`sin munición de ${weaponId}`);

  const shot = simulateWeaponShot3D(
    state.terrain,
    weapon,
    {
      originX: shooterTank.x,
      originY: shooterTank.y,
      originZ: shooterTank.z,
      yaw: cmd.yaw,
      pitch: cmd.pitch,
      power: cmd.power,
      wind: state.wind,
      shooterId: shooterTank.id,
    },
    state.tanks.filter(isAlive),
    { recordPath: options.recordPath ?? false },
  );

  let terrain = state.terrain;
  const tanks = state.tanks.slice();
  const players = state.players.slice();
  let money = shooterPlayer.money;
  const damage: DamageEvent[] = [];
  const falls: FallEvent3D[] = [];
  const blocked: string[] = [];
  let fire: Fire | null = null;

  const hurt = (i: number, amount: number, cause: DamageEvent["cause"]) => {
    const target = tanks[i]!;
    const r = applyDamage(target, amount);
    if (r.dealt <= 0) return;
    tanks[i] = r.tank;
    const reward = moneyForDamage({
      damage: r.dealt,
      killed: r.killed,
      armsLevel: weapon.armsLevel,
      friendly: target.id === shooterTank.id,
    });
    money = clampMoney(money + reward);
    damage.push({ targetId: target.id, cause, damage: r.dealt, killed: r.killed, money: reward });
  };

  const drown = () => {
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i]!;
      if (isAlive(t) && isWater(terrain, t.x, t.z)) hurt(i, t.life, "water");
    }
  };

  // Un golpe por vuelta: uno solo, salvo el MIRV abierto, que trae uno por cabeza, en el orden en
  // que caen. Cada uno se resuelve entero (cráter, explosión, caídas) antes de pasar al siguiente.
  for (const hit of shotImpacts(shot)) {
    if (hit.outcome !== "ground" && hit.outcome !== "tank") continue;
    fire = fireFromShot(weapon, shot, shooterTank.id);
    if (weapon.craterRadius > 0) terrain = applyCraterTerrain(terrain, hit.x, hit.y, hit.z, weapon.craterRadius);
    if (weapon.mound) {
      terrain = applyMoundTerrain(terrain, hit.x, hit.y, hit.z, weapon.mound.radius);
      // Nadie queda enterrado: el tanque (o el resto de uno) que quedó bajo la loma sube con ella.
      for (let i = 0; i < tanks.length; i++) {
        const t = tanks[i]!;
        const ground = terrainHeightAt(terrain, t.x, t.z);
        if (ground > t.y) tanks[i] = { ...t, y: ground };
      }
    }
    /** Los escudos que se comieron este golpe (no uno anterior del mismo tiro). */
    const absorbed: string[] = [];
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i]!;
      if (!isAlive(t)) continue;
      const amount = explosionDamage(collisionDistance3D(t, hit.x, hit.y, hit.z), weapon.explosionRadius, weapon.hurtAmount);
      const pi = players.findIndex((p) => p.id === t.id);
      const shield = players[pi]?.inventory.shield ?? 0;
      if (amount > 0 && shield > 0 && !weapon.piercesShield) {
        players[pi] = { ...players[pi]!, inventory: { ...players[pi]!.inventory, shield: shield - 1 } };
        blocked.push(t.id);
        absorbed.push(t.id);
        continue;
      }
      hurt(i, amount, "explosion");
    }
    // Sin cráter (Napalm, Dirt Ball) no hay a dónde caer: el terreno no se toca ni para aplanar.
    const cratered = weapon.craterRadius > 0;
    for (let i = 0; cratered && i < tanks.length; i++) {
      const s = settleTank3D(terrain, tanks[i]!);
      if (!s.fall) continue;
      terrain = s.terrain;
      tanks[i] = s.tank;
      // TargetFalling::collision(): con paracaídas el daño de caída es 0. Acá el paracaídas dura
      // toda la ronda (campaign.ts), así que no se gasta por caída.
      const owner = state.players.find((p) => p.id === s.tank.id);
      const parachute = (owner?.inventory.parachute ?? 0) > 0;
      const shielded = absorbed.includes(s.tank.id);
      falls.push({ tankId: s.tank.id, fromY: s.fall.fromY, toY: s.fall.toY, distance: s.fall.distance, parachute, shielded });
      hurt(i, parachute || shielded ? 0 : s.fall.damage, "fall");
    }
    drown();
  }
  // También sin golpe (el tiro se fue, o se hundió): nadie termina un turno vivo en el agua.
  drown();

  // El inventario del que disparó puede haber cambiado arriba (su propio escudo).
  const shooterNow = players[shooterIdx]!;
  players[shooterIdx] = { ...shooterNow, money, inventory: consumeAmmo(shooterNow.inventory, weaponId) };
  const next: MatchState3D = { ...state, terrain, tanks, players };
  return { state: fire ? { ...next, fires: [...(state.fires ?? []), fire] } : next, shot, damage, falls, blocked, fire };
}

/** Lo que le sacó un fuego a un tanque al empezar su turno. */
export interface BurnEvent extends DamageEvent {
  cause: "burn";
  /** Quién había prendido ese fuego: `money` y el puntaje son suyos. */
  ownerId: string;
}

/**
 * Empieza el turno de `playerId`: por cada fuego de la ronda en el que su tanque está parado
 * (inFire), pierde `damagePerTurn`. Dos fuegos encimados queman dos veces. El que se movió con
 * nafta y quedó afuera no pierde nada. El escudo no lo tapa ni se gasta: no es un tiro.
 * La plata por el daño es del que prendió el fuego, con el armslevel del arma, igual que un tiro
 * (si se quema con el suyo, la paga). Si no se quema, devuelve el mismo estado.
 */
export function burnTurn3D(state: MatchState3D, playerId: string): { state: MatchState3D; burns: BurnEvent[] } {
  const burns: BurnEvent[] = [];
  const ti = state.tanks.findIndex((t) => t.id === playerId);
  if (ti < 0 || !state.fires) return { state, burns };

  let tank = state.tanks[ti]!;
  const players = state.players.slice();
  for (const f of state.fires) {
    if (!isAlive(tank)) break;
    if (!inFire(f, tank)) continue;
    const r = applyDamage(tank, f.damagePerTurn);
    if (r.dealt <= 0) continue;
    tank = r.tank;
    const money = moneyForDamage({
      damage: r.dealt,
      killed: r.killed,
      armsLevel: WEAPONS[f.weaponId].armsLevel,
      friendly: f.ownerId === playerId,
    });
    const oi = players.findIndex((p) => p.id === f.ownerId);
    if (oi >= 0) players[oi] = { ...players[oi]!, money: clampMoney(players[oi]!.money + money) };
    burns.push({ targetId: playerId, cause: "burn", damage: r.dealt, killed: r.killed, money, ownerId: f.ownerId });
  }
  if (burns.length === 0) return { state, burns };
  const tanks = state.tanks.slice();
  tanks[ti] = tank;
  return { state: { ...state, tanks, players }, burns };
}
