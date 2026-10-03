// SPDX-License-Identifier: GPL-2.0-or-later
// Daño por explosión y por caída. Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/target/TargetDamageCalc.cpp explosion()      (curva de daño por distancia)
//   src/common/target/TargetLife.cpp       collisionDistance(), setLife()
//   src/common/target/TargetDamage.cpp     damageTarget()   (daño recortado a la vida; chequeo de caída)
//   src/common/actions/TargetFalling.cpp   collision()      (daño = distancia caída · 20)

import {
  EXPLOSION_FALLOFF_FRACTION,
  EXPLOSION_FULL_DAMAGE_FRACTION,
  EXPLOSION_MAX_DAMAGE,
  FALL_DAMAGE_PER_WU,
  MIN_FALL_DISTANCE,
  TANK_RADIUS,
} from "./constants";
import { flattenUnder } from "./crater";
import { heightAt, type Heightmap } from "./heightmap";
import { tankCenter } from "./projectile";

/** Tanque en la partida. (x, y) es la base [wu]; life en [hp]. life = 0 → muerto. */
export interface Tank {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly life: number;
}

export const isAlive = (t: Tank): boolean => t.life > 0;

/**
 * Distancia desde un punto a la superficie de la esfera del tanque (0 si está adentro). [wu]
 * TargetLife::collisionDistance(), caso esfera.
 */
export function collisionDistance(tank: Tank, px: number, py: number): number {
  const c = tankCenter(tank.x, tank.y);
  return Math.max(0, Math.hypot(px - c.x, py - c.y) - TANK_RADIUS);
}

/**
 * Daño de explosión a distancia `dist` [wu] para una explosión de radio `radius` [wu]. [hp]
 * TargetDamageCalc::explosion():
 *   dist ≤ r/3        → 100
 *   r/3 < dist < r    → 100 - (dist - r/3) / (0.66 r) · 100
 *   dist ≥ r          → 0
 * Todo multiplicado por hurtAmount.
 */
export function explosionDamage(dist: number, radius: number, hurtAmount = 1): number {
  if (!(dist < radius)) return 0;
  let damage = EXPLOSION_MAX_DAMAGE;
  const full = radius * EXPLOSION_FULL_DAMAGE_FRACTION;
  if (dist > full) {
    damage = EXPLOSION_MAX_DAMAGE - ((dist - full) / (radius * EXPLOSION_FALLOFF_FRACTION)) * EXPLOSION_MAX_DAMAGE;
  }
  return damage * hurtAmount;
}

/** Daño por caer `distance` [wu]. TargetFalling::collision(): `dist * 20`, 0 si dist < 0.5. [hp] */
export function fallDamage(distance: number): number {
  if (!(distance >= MIN_FALL_DISTANCE)) return 0;
  return distance * FALL_DAMAGE_PER_WU;
}

export interface DamageApplied<T extends Tank = Tank> {
  tank: T;
  /** Daño efectivamente quitado (recortado a la vida que tenía). Base del premio en plata. [hp] */
  dealt: number;
  /** Esta aplicación lo mató. */
  killed: boolean;
}

/**
 * Resta vida. TargetDamage::damageTarget(): el daño se recorta a la vida restante;
 * TargetLife::setLife(): con menos de 1 hp el tanque queda en 0 (muerto).
 */
export function applyDamage<T extends Tank>(tank: T, amount: number): DamageApplied<T> {
  if (!isAlive(tank) || !(amount > 0)) return { tank, dealt: 0, killed: false };
  const dealt = Math.min(amount, tank.life);
  let life = tank.life - dealt;
  if (life < 1) life = 0;
  return { tank: { ...tank, life }, dealt, killed: life === 0 };
}

export interface FallResult {
  heights: Heightmap;
  tank: Tank;
  /** undefined si el tanque tenía piso. */
  fall?: { fromY: number; toY: number; distance: number; damage: number };
}

/**
 * Si el suelo bajo el tanque quedó más bajo que su base, el tanque cae hasta el suelo,
 * el terreno bajo él se aplana y se calcula el daño de caída (sin aplicarlo: el que llama
 * decide a quién acreditar la plata).
 *
 * El original simula la caída como partícula con gravedad y viento 0 (TargetFalling::init,
 * `setForces(0, 1)`) hasta tocar el suelo; como solo hay movimiento vertical, la distancia
 * caída es la diferencia de alturas, que es lo que se usa acá.
 */
export function settleTank(heights: Heightmap, tank: Tank): FallResult {
  if (!isAlive(tank)) return { heights, tank };
  const ground = heightAt(heights, tank.x);
  if (!(ground < tank.y)) return { heights, tank };

  const distance = tank.y - ground;
  // fround: el heightmap es Float32; así la base coincide bit a bit con el suelo aplanado.
  const landed: Tank = { ...tank, y: Math.fround(ground) };
  return {
    heights: flattenUnder(heights, tank.x, landed.y),
    tank: landed,
    fall: { fromY: tank.y, toY: ground, distance, damage: fallDamage(distance) },
  };
}
