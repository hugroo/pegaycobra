// SPDX-License-Identifier: GPL-2.0-or-later
// Bot para probar solo. Ocupa un asiento como cualquier jugador y la sala le pasa sus mensajes
// por los mismos caminos que los de un cliente (Game.fire, Game.buy, Game.setReady).
// Acá solo se decide qué manda: el tiro sale de probar unas pocas punterías con el sim, descartar
// las que se quedan en un cerro antes del rival y quedarse con la que cae más cerca; no busca hasta pegar.

import {
  canFire,
  cannotBuy,
  collisionDistance3D,
  explosionDamage,
  isAlive,
  POWER_MAX,
  simulateShot3D,
  WEAPONS,
  type MatchState3D,
  type Player,
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

/** Las BOT_SAMPLES punterías sorteadas, cada una con dónde cae según el sim. */
export function botCandidates(match: MatchState3D, botId: string, rng: () => number): BotShot[] {
  const alive = match.tanks.filter(isAlive);
  const me = alive.find((t) => t.id === botId);
  const foes = alive.filter((t) => t.id !== botId);
  const inventory = match.players.find((p) => p.id === botId)?.inventory;
  if (!me || !inventory || foes.length === 0) return [];

  const weapon: WeaponId = canFire(inventory, "missile") ? "missile" : "babyMissile";
  const w = WEAPONS[weapon];
  const nearest = foes.reduce((a, b) => (Math.hypot(a.x - me.x, a.z - me.z) <= Math.hypot(b.x - me.x, b.z - me.z) ? a : b));
  const bearing = (Math.atan2(nearest.z - me.z, nearest.x - me.x) * 180) / Math.PI;

  const out: BotShot[] = [];
  for (let i = 0; i < BOT_SAMPLES; i++) {
    const yaw = bearing + (rng() * 2 - 1) * YAW_SPREAD;
    const pitch = PITCH_MIN + rng() * (PITCH_MAX - PITCH_MIN);
    // La potencia va por franjas, así las muestras cubren de corto a largo.
    const power = POWER_MIN + ((i + rng()) / BOT_SAMPLES) * (POWER_MAX - POWER_MIN);
    const r = simulateShot3D(
      match.terrain,
      {
        originX: me.x,
        originY: me.y,
        originZ: me.z,
        yaw,
        pitch,
        power,
        wind: match.wind,
        windFactor: w.windFactor,
        gravityFactor: w.gravityFactor,
        shooterId: botId,
      },
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

/** En la tienda: un pack de Missiles si no le queda ninguno y le alcanza. Paracaídas y nafta, no. */
export function botWantsMissile(player: Player): boolean {
  return (player.inventory.missile ?? 0) <= 0 && cannotBuy(player, "missile") === null;
}
