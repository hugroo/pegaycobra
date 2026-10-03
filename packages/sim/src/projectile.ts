// SPDX-License-Identifier: GPL-2.0-or-later
// Integración del proyectil. Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/tank/TankLib.cpp                  getVelocityVector(), getGunPosition()
//   src/common/simactions/PlayMovesSimAction.cpp velocity = getVelocityVector(...) * (power + 1)
//   src/common/engine/PhysicsParticleObject.cpp  setForces() (viento + gravedad), simulate() (paso)
//   src/common/actions/ShotProjectile.cpp        el tiro avanza en pasos fijos de stepSize
//
// Vista de perfil: el original apunta con dos ángulos (rotación xy y elevación yz).
// Acá hay un solo ángulo: 0° = hacia +x, 90° = vertical, 180° = hacia -x.
// El viento es un escalar con signo: positivo empuja hacia +x.

import {
  FORCE_DIVISOR,
  GRAVITY,
  GUN_LENGTH,
  MAX_SHOT_TICKS,
  POWER_MAX,
  POWER_TO_VELOCITY,
  TANK_RADIUS,
  VELOCITY_TO_POSITION,
  WIND_MAX,
  WIND_SCALE,
} from "./constants";
import { heightAt, type Heightmap } from "./heightmap";

export interface ShotParams {
  /** Posición del tanque que dispara (base, apoyada en el suelo). [wu] */
  originX: number;
  originY: number;
  /** Elevación: 0 = derecha, 90 = arriba, 180 = izquierda. Se recorta a [0, 180]. [grados] */
  angleDeg: number;
  /** Se recorta a [0, POWER_MAX]. [adimensional] */
  power: number;
  /** Viento con signo, se recorta a [-WIND_MAX, WIND_MAX]. [unidad de viento] */
  wind: number;
  /** Multiplicadores del arma (default 1). [adimensional] */
  windFactor?: number;
  gravityFactor?: number;
  /** Id del tanque que dispara: su propio casco no frena el tiro. */
  shooterId?: string;
}

/** Tanque visto por el proyectil. (x, y) es la base. [wu] */
export interface ShotTank {
  id: string;
  x: number;
  y: number;
}

export type ShotOutcome = "ground" | "tank" | "offmap" | "timeout";

export interface ShotResult {
  outcome: ShotOutcome;
  /** Último punto del tiro (impacto, o donde salió del mapa). [wu] */
  x: number;
  y: number;
  /** Pasos integrados. Multiplicar por STEP_SECONDS para animar. [tick] */
  ticks: number;
  /** Solo si outcome === "tank". */
  tankId?: string;
  /** Si se pidió: [x0, y0, x1, y1, ...], un par por tick, empezando en la boca del cañón. [wu] */
  path?: number[];
}

export interface ShotOptions {
  recordPath?: boolean;
  maxTicks?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function assertFinite(name: string, v: number): void {
  if (!Number.isFinite(v)) throw new RangeError(`${name} debe ser finito (recibido ${v})`);
}

/** Centro de la esfera de colisión del tanque. [wu] */
export function tankCenter(x: number, y: number): { x: number; y: number } {
  return { x, y: y + TANK_RADIUS };
}

/**
 * Velocidad inicial en vu.
 * getVelocityVector(): dirección unitaria * 1.2 / 20; PlayMovesSimAction: * (power + 1).
 */
export function launchVelocity(angleDeg: number, power: number): { vx: number; vy: number } {
  const a = (clamp(angleDeg, 0, 180) * Math.PI) / 180;
  const speed = POWER_TO_VELOCITY * (clamp(power, 0, POWER_MAX) + 1);
  return { vx: Math.cos(a) * speed, vy: Math.sin(a) * speed };
}

/** Boca del cañón: centro del tanque + GUN_LENGTH en la dirección del ángulo. [wu] */
export function muzzlePosition(originX: number, originY: number, angleDeg: number): { x: number; y: number } {
  const a = (clamp(angleDeg, 0, 180) * Math.PI) / 180;
  const c = tankCenter(originX, originY);
  return { x: c.x + Math.cos(a) * GUN_LENGTH, y: c.y + Math.sin(a) * GUN_LENGTH };
}

/**
 * Aceleración por tick en vu/tick.
 * setForces(): (viento · velocidad / 2.5 · windFactor + gravedad · gravityFactor) / 70.
 */
export function shotAcceleration(
  wind: number,
  windFactor = 1,
  gravityFactor = 1,
): { ax: number; ay: number } {
  return {
    ax: (clamp(wind, -WIND_MAX, WIND_MAX) * WIND_SCALE * windFactor) / FORCE_DIVISOR,
    ay: (GRAVITY * gravityFactor) / FORCE_DIVISOR,
  };
}

/**
 * Simula un tiro hasta que pega en un tanque, en el suelo, sale del mapa o se agota.
 *
 * Paso fijo, Euler semi-implícito como PhysicsParticleObject::simulate():
 *   v += a;  p += v / 100
 * Después de mover se chequea, en este orden: tanques, bordes del mapa, suelo.
 * No hay paredes: si x sale de [0, width - 1] el tiro se pierde ("offmap").
 */
export function simulateShot(
  heights: Heightmap,
  params: ShotParams,
  tanks: readonly ShotTank[] = [],
  options: ShotOptions = {},
): ShotResult {
  assertFinite("originX", params.originX);
  assertFinite("originY", params.originY);
  assertFinite("angleDeg", params.angleDeg);
  assertFinite("power", params.power);
  assertFinite("wind", params.wind);

  const maxX = heights.length - 1;
  const maxTicks = options.maxTicks ?? MAX_SHOT_TICKS;
  const path = options.recordPath ? ([] as number[]) : undefined;

  let { x, y } = muzzlePosition(params.originX, params.originY, params.angleDeg);
  let { vx, vy } = launchVelocity(params.angleDeg, params.power);
  const { ax, ay } = shotAcceleration(params.wind, params.windFactor ?? 1, params.gravityFactor ?? 1);
  const r2 = TANK_RADIUS * TANK_RADIUS;

  path?.push(x, y);

  const done = (outcome: ShotOutcome, ticks: number, tankId?: string): ShotResult => {
    const result: ShotResult = { outcome, x, y, ticks };
    if (tankId !== undefined) result.tankId = tankId;
    if (path) result.path = path;
    return result;
  };

  for (let tick = 1; tick <= maxTicks; tick++) {
    vx += ax;
    vy += ay;
    x += vx * VELOCITY_TO_POSITION;
    y += vy * VELOCITY_TO_POSITION;
    path?.push(x, y);

    for (const t of tanks) {
      if (t.id === params.shooterId) continue;
      const c = tankCenter(t.x, t.y);
      const dx = x - c.x;
      const dy = y - c.y;
      if (dx * dx + dy * dy <= r2) return done("tank", tick, t.id);
    }

    if (x < 0 || x > maxX) return done("offmap", tick);
    if (y <= heightAt(heights, x)) return done("ground", tick);
  }
  return done("timeout", maxTicks);
}
