// SPDX-License-Identifier: GPL-2.0-or-later
// Bot para probar solo. Ocupa un asiento como cualquier jugador y la sala le pasa sus mensajes
// por los mismos caminos que los de un cliente (Game.fire, Game.move, Game.buy, Game.setReady).
// Acá solo se decide qué manda: el tiro sale de probar unas pocas punterías con el sim, descartar
// las que se quedan en un cerro antes del rival y quedarse con la que cae más cerca; no busca hasta pegar.

import {
  canFire,
  cannotBuy,
  collisionDistance3D,
  explosionDamage,
  FUEL_MOVE_RANGE,
  isAlive,
  POWER_MAX,
  simulateWeaponShot3D,
  TANK_RADIUS,
  terrainHeightAt,
  validateMove,
  WEAPONS,
  type MatchState3D,
  type Player,
  type ShopItemId,
  type Tank3D,
  type Terrain,
  type WeaponId,
} from "@pegaycobra/sim";

export const BOT_NAME = "Bot";
/** Punterías que prueba por turno. */
export const BOT_SAMPLES = 24;
/** El giro se sortea alrededor del rumbo al rival más cercano, ± esto. [grados] */
const YAW_SPREAD = 8;
const PITCH_MIN = 40;
const PITCH_MAX = 65;
const POWER_MIN = 300;
/** Lo que tira si tiene, en este orden. Si no tiene nada de esto, la Baby. */
const BOT_WEAPONS: readonly WeaponId[] = ["missile", "leapfrog", "roller"];
/** Lo que sortea en la tienda. El escudo va aparte (botShopPick). */
const BOT_SHOP: readonly ShopItemId[] = ["missile", "roller", "leapfrog", "fuel"];

export interface BotShot {
  yaw: number;
  pitch: number;
  power: number;
  weapon: WeaponId;
  /** El tiro explota (suelo o tanque); si no, se fue del mapa. */
  landed: boolean;
  /** Pegó en el suelo antes de llegar al rival más cercano y la explosión no lo alcanza: quedó en un cerro del medio. */
  blocked: boolean;
  /** Distancia del final del tiro al rival vivo más cercano. [wu] */
  miss: number;
}

function nearestFoe(me: Tank3D, foes: readonly Tank3D[]): Tank3D {
  return foes.reduce((a, b) => (Math.hypot(a.x - me.x, a.z - me.z) <= Math.hypot(b.x - me.x, b.z - me.z) ? a : b));
}

/** Las BOT_SAMPLES punterías sorteadas, cada una con dónde cae según el sim. */
export function botCandidates(match: MatchState3D, botId: string, rng: () => number): BotShot[] {
  const alive = match.tanks.filter(isAlive);
  const me = alive.find((t) => t.id === botId);
  const foes = alive.filter((t) => t.id !== botId);
  const inventory = match.players.find((p) => p.id === botId)?.inventory;
  if (!me || !inventory || foes.length === 0) return [];

  // Tira lo que compró: Missile si tiene, si no Rebote, si no Roller, si no la Baby. Apunta igual con
  // cualquiera: el sim ya trae el pique del Rebote y la rodada del Roller.
  // Lo que no compra (Napalm, Nuke, Tierra y Racimo) tampoco lo tira, aunque lo tenga.
  const weapon: WeaponId = BOT_WEAPONS.find((id) => canFire(inventory, id)) ?? "babyMissile";
  const w = WEAPONS[weapon];
  const nearest = nearestFoe(me, foes);
  const bearing = (Math.atan2(nearest.z - me.z, nearest.x - me.x) * 180) / Math.PI;

  const out: BotShot[] = [];
  for (let i = 0; i < BOT_SAMPLES; i++) {
    const yaw = bearing + (rng() * 2 - 1) * YAW_SPREAD;
    const pitch = PITCH_MIN + rng() * (PITCH_MAX - PITCH_MIN);
    // La potencia va por franjas, así las muestras cubren de corto a largo.
    const power = POWER_MIN + ((i + rng()) / BOT_SAMPLES) * (POWER_MAX - POWER_MIN);
    const r = simulateWeaponShot3D(
      match.terrain,
      w,
      { originX: me.x, originY: me.y, originZ: me.z, yaw, pitch, power, wind: match.wind, shooterId: botId },
      alive,
    );
    const miss = Math.min(...foes.map((f) => collisionDistance3D(f, r.x, r.y, r.z)));
    const short = Math.hypot(r.x - me.x, r.z - me.z) < Math.hypot(nearest.x - me.x, nearest.z - me.z);
    const blocked = r.outcome === "ground" && short && explosionDamage(miss, w.explosionRadius, w.hurtAmount) <= 0;
    out.push({ yaw, pitch, power, weapon, landed: r.outcome === "ground" || r.outcome === "tank", blocked, miss });
  }
  return out;
}

/** 2 = explota sin quedar tapado, 1 = explota pero tapado, 0 = se fue del mapa. */
const rank = (c: BotShot) => (c.landed ? (c.blocked ? 1 : 2) : 0);

/**
 * De las muestras que no quedan tapadas, la que cae más cerca de un rival. Si todas quedan tapadas
 * o se van, la menos mala. null = no hay a quién tirarle.
 */
export function pickBotShot(match: MatchState3D, botId: string, rng: () => number): BotShot | null {
  let best: BotShot | null = null;
  for (const c of botCandidates(match, botId, rng)) {
    if (!best || rank(c) > rank(best) || (rank(c) === rank(best) && c.miss < best.miss)) best = c;
  }
  return best;
}

/** Hay cerro de por medio: la recta de un tanque al otro, a la altura del cañón, pasa por debajo del piso. */
function hillBetween(terrain: Terrain, a: Tank3D, b: Tank3D): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
  for (let i = 1; i < steps; i++) {
    const k = i / steps;
    const sight = a.y + (b.y - a.y) * k + TANK_RADIUS;
    if (terrainHeightAt(terrain, a.x + (b.x - a.x) * k, a.z + (b.z - a.z) * k) > sight) return true;
  }
  return false;
}

/**
 * Nafta: si tiene, el rival más cercano está cerro de por medio y hay piso más alto que el suyo a
 * menos de FUEL_MOVE_RANGE celdas, el punto más alto al que puede ir. null = se queda donde está.
 */
export function botMovePick(match: MatchState3D, botId: string): { x: number; z: number } | null {
  const alive = match.tanks.filter(isAlive);
  const me = alive.find((t) => t.id === botId);
  const foes = alive.filter((t) => t.id !== botId);
  const fuel = match.players.find((p) => p.id === botId)?.inventory.fuel ?? 0;
  if (!me || fuel <= 0 || foes.length === 0) return null;
  if (!hillBetween(match.terrain, me, nearestFoe(me, foes))) return null;

  let best: { x: number; z: number } | null = null;
  let top = me.y;
  for (let dz = -FUEL_MOVE_RANGE; dz <= FUEL_MOVE_RANGE; dz++) {
    for (let dx = -FUEL_MOVE_RANGE; dx <= FUEL_MOVE_RANGE; dx++) {
      if (Math.hypot(dx, dz) >= FUEL_MOVE_RANGE) continue;
      const to = { x: me.x + dx, z: me.z + dz };
      const check = validateMove(match, botId, to);
      if (check.ok && check.y > top) {
        top = check.y;
        best = to;
      }
    }
  }
  return best;
}

/**
 * En la tienda compra una sola cosa por ronda, si le alcanza. Si le pegaron en la ronda anterior
 * (`wasHit`) y no tiene escudo, el escudo. Si no, sortea entre lo que puede pagar de Missile,
 * Roller, Rebote y nafta. Napalm, Nuke, Tierra, Racimo y paracaídas, no. null = no compra nada.
 */
export function botShopPick(player: Player, rng: () => number, wasHit = false): ShopItemId | null {
  if (wasHit && cannotBuy(player, "shield") === null) return "shield";
  const can = BOT_SHOP.filter((item) => cannotBuy(player, item) === null);
  return can.length > 0 ? can[Math.floor(rng() * can.length)]! : null;
}
