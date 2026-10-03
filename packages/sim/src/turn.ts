// SPDX-License-Identifier: GPL-2.0-or-later
// Resolución completa de un disparo: lo que el server va a llamar con el ángulo y la
// potencia que mandó el cliente. Orquesta las piezas portadas de Scorched3D:
//   tiro (projectile.ts) → cráter (crater.ts) → daño de explosión (damage.ts)
//   → caídas y daño de caída (damage.ts) → plata para quien disparó (economy.ts).
// Orden tomado de src/common/actions/Explosion.cpp (primero deforma, después daña) y
// src/common/target/TargetDamage.cpp (después del daño, si no hay piso, cae).
//
// Diferencia con el original: ahí solo se chequea la caída de tanques dentro de
// radio + 5 de la explosión. Acá se chequean todos los vivos; el resultado es el mismo
// porque un cráter no puede quitarle el piso a un tanque fuera de su radio.

import { applyCrater } from "./crater";
import { applyDamage, collisionDistance, explosionDamage, isAlive, settleTank, type Tank } from "./damage";
import { canFire, clampMoney, consumeAmmo, moneyForDamage, type Inventory } from "./economy";
import type { Heightmap } from "./heightmap";
import { simulateShot, type ShotResult } from "./projectile";
import { isPlayable, WEAPONS, type WeaponId } from "./weapons";
import { resolveTurn3D, type FireCommand3D, type MatchState3D, type TurnResult3D } from "./turn3d";

export interface Player {
  readonly id: string;
  /** [$] */
  readonly money: number;
  readonly inventory: Inventory;
}

export interface MatchState {
  readonly heights: Heightmap;
  /** Viento con signo, positivo hacia +x. [unidad de viento] */
  readonly wind: number;
  /** Un tanque por jugador; tank.id === player.id. */
  readonly tanks: readonly Tank[];
  readonly players: readonly Player[];
}

/** Lo único que manda el cliente. */
export interface FireCommand {
  playerId: string;
  /** [grados] 0 = derecha, 90 = arriba, 180 = izquierda */
  angleDeg: number;
  /** [0, POWER_MAX] */
  power: number;
  weaponId?: WeaponId;
}

export interface DamageEvent {
  targetId: string;
  cause: "explosion" | "fall" | "burn";
  /** Daño quitado. [hp] */
  damage: number;
  killed: boolean;
  /** Plata que este evento le dio (o sacó) a quien disparó. [$] */
  money: number;
}

export interface FallEvent {
  tankId: string;
  fromY: number;
  toY: number;
  /** [wu] */
  distance: number;
}

export interface TurnResult {
  state: MatchState;
  shot: ShotResult;
  damage: DamageEvent[];
  falls: FallEvent[];
}

/**
 * Resuelve un disparo de punta a punta y devuelve un estado nuevo (no muta el anterior).
 * Tira error si el jugador no existe, está muerto, el arma no es jugable o no tiene munición.
 */
export function resolveTurn(
  state: MatchState3D,
  cmd: FireCommand3D,
  options?: { recordPath?: boolean },
): TurnResult3D;
export function resolveTurn(state: MatchState, cmd: FireCommand, options?: { recordPath?: boolean }): TurnResult;
export function resolveTurn(
  state: MatchState | MatchState3D,
  cmd: FireCommand | FireCommand3D,
  options: { recordPath?: boolean } = {},
): TurnResult | TurnResult3D {
  if ("terrain" in state) {
    if (!("yaw" in cmd)) throw new Error("el mapa 3D necesita yaw y pitch");
    return resolveTurn3D(state, cmd, options);
  }
  if ("yaw" in cmd) throw new Error("el mapa de perfil usa angleDeg, no yaw");
  return resolveProfileTurn(state, cmd, options);
}

/** Disparo en el mapa de perfil (una fila). Es la resolución original de este archivo. */
function resolveProfileTurn(state: MatchState, cmd: FireCommand, options: { recordPath?: boolean }): TurnResult {
  const weaponId = cmd.weaponId ?? "babyMissile";
  const weapon = WEAPONS[weaponId];
  if (!isPlayable(weaponId)) throw new Error(`arma no jugable en el MVP: ${weaponId}`);

  const shooterIdx = state.players.findIndex((p) => p.id === cmd.playerId);
  const shooterPlayer = state.players[shooterIdx];
  const shooterTank = state.tanks.find((t) => t.id === cmd.playerId);
  if (!shooterPlayer || !shooterTank) throw new Error(`jugador desconocido: ${cmd.playerId}`);
  if (!isAlive(shooterTank)) throw new Error(`el tanque de ${cmd.playerId} está muerto`);
  if (!canFire(shooterPlayer.inventory, weaponId)) throw new Error(`sin munición de ${weaponId}`);

  const shot = simulateShot(
    state.heights,
    {
      originX: shooterTank.x,
      originY: shooterTank.y,
      angleDeg: cmd.angleDeg,
      power: cmd.power,
      wind: state.wind,
      windFactor: weapon.windFactor,
      gravityFactor: weapon.gravityFactor,
      shooterId: shooterTank.id,
    },
    state.tanks.filter(isAlive),
    { recordPath: options.recordPath ?? false },
  );

  let heights = state.heights;
  const tanks = state.tanks.slice();
  let money = shooterPlayer.money;
  const damage: DamageEvent[] = [];
  const falls: FallEvent[] = [];

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
    money = clampMoney(money + reward); // TankScore::setMoney recorta en cada cambio
    damage.push({ targetId: target.id, cause, damage: r.dealt, killed: r.killed, money: reward });
  };

  if (shot.outcome === "ground" || shot.outcome === "tank") {
    heights = applyCrater(heights, shot.x, shot.y, weapon.craterRadius);

    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i]!;
      if (!isAlive(t)) continue;
      const dist = collisionDistance(t, shot.x, shot.y);
      hurt(i, explosionDamage(dist, weapon.explosionRadius, weapon.hurtAmount), "explosion");
    }

    for (let i = 0; i < tanks.length; i++) {
      const settled = settleTank(heights, tanks[i]!);
      if (!settled.fall) continue;
      heights = settled.heights;
      tanks[i] = settled.tank;
      falls.push({
        tankId: settled.tank.id,
        fromY: settled.fall.fromY,
        toY: settled.fall.toY,
        distance: settled.fall.distance,
      });
      // TargetFalling acredita el daño de caída al que disparó, con su arma.
      hurt(i, settled.fall.damage, "fall");
    }
  }

  const players = state.players.slice();
  players[shooterIdx] = {
    ...shooterPlayer,
    money,
    inventory: consumeAmmo(shooterPlayer.inventory, weaponId),
  };

  return { state: { ...state, heights, tanks, players }, shot, damage, falls };
}
