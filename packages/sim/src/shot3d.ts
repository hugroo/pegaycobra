// SPDX-License-Identifier: GPL-2.0-or-later
// Tiro en 3D. Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/tank/TankLib.cpp                  getVelocityVector(xy, yz), getGunPosition()
//   src/common/simactions/PlayMovesSimAction.cpp velocity = getVelocityVector(...) * (power + 1)
//   src/common/engine/PhysicsParticleObject.cpp  setForces() (viento vectorial + gravedad), simulate()
//   src/common/engine/Wind.cpp                   viento = dirección (sin a, cos a) × velocidad 0..5
//
// Mismas constantes y mismo paso que el perfil (projectile.ts): v += a; p += v / 100.
// Convención de ángulos (propia, el original usa rotXY y rotYZ con z hacia arriba):
//   yaw   0..360 alrededor del eje Y: 0° = +X, 90° = +Z.
//   pitch 0..90 sobre el horizonte: 0° = rasante, 90° = vertical.

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
import { terrainHeightAt, type Terrain } from "./terrain";

/** Viento en el piso (plano XZ). |viento| ≤ WIND_MAX. [unidad de viento] */
export interface Wind {
  x: number;
  z: number;
}

export interface Shot3DParams {
  /** Base del tanque que dispara. [wu] */
  originX: number;
  originY: number;
  originZ: number;
  /** [grados] cualquier valor; se normaliza a [0, 360). */
  yaw: number;
  /** [grados] se recorta a [0, 90]. */
  pitch: number;
  /** se recorta a [0, POWER_MAX]. */
  power: number;
  wind: Wind;
  windFactor?: number;
  gravityFactor?: number;
  shooterId?: string;
}

export interface ShotTank3D {
  id: string;
  x: number;
  y: number;
  z: number;
}

export type Shot3DOutcome = "ground" | "tank" | "offmap" | "timeout";

export interface Shot3DResult {
  outcome: Shot3DOutcome;
  x: number;
  y: number;
  z: number;
  ticks: number;
  tankId?: string;
  /** [x0, y0, z0, x1, y1, z1, ...] un trío por tick, desde la boca del cañón. [wu] */
  path?: number[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rad = (deg: number) => (deg * Math.PI) / 180;

export function normalizeYaw(yaw: number): number {
  return ((yaw % 360) + 360) % 360;
}

/** Dirección unitaria del cañón. */
export function aimDirection(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const y = rad(normalizeYaw(yaw));
  const p = rad(clamp(pitch, 0, 90));
  return { x: Math.cos(p) * Math.cos(y), y: Math.sin(p), z: Math.cos(p) * Math.sin(y) };
}

/** getVelocityVector() · (power + 1): dirección × 1.2/20 × (power + 1). [vu] */
export function launchVelocity3D(yaw: number, pitch: number, power: number): { vx: number; vy: number; vz: number } {
  const d = aimDirection(yaw, pitch);
  const s = POWER_TO_VELOCITY * (clamp(power, 0, POWER_MAX) + 1);
  return { vx: d.x * s, vy: d.y * s, vz: d.z * s };
}

/** Centro de la esfera del tanque + GUN_LENGTH en la dirección del cañón. [wu] */
export function muzzlePosition3D(x: number, y: number, z: number, yaw: number, pitch: number) {
  const d = aimDirection(yaw, pitch);
  return { x: x + d.x * GUN_LENGTH, y: y + TANK_RADIUS + d.y * GUN_LENGTH, z: z + d.z * GUN_LENGTH };
}

/** setForces(): (viento · 0.4 · windFactor + gravedad · gravityFactor) / 70, por tick. [vu/tick] */
export function shotAcceleration3D(wind: Wind, windFactor = 1, gravityFactor = 1) {
  let wx = Number.isFinite(wind.x) ? wind.x : 0;
  let wz = Number.isFinite(wind.z) ? wind.z : 0;
  const mag = Math.hypot(wx, wz);
  if (mag > WIND_MAX) {
    wx *= WIND_MAX / mag;
    wz *= WIND_MAX / mag;
  }
  return {
    ax: (wx * WIND_SCALE * windFactor) / FORCE_DIVISOR,
    ay: (GRAVITY * gravityFactor) / FORCE_DIVISOR,
    az: (wz * WIND_SCALE * windFactor) / FORCE_DIVISOR,
  };
}

/**
 * Simula el tiro hasta que pega en un tanque, en el suelo, sale del mapa o se agota.
 * Orden de chequeo después de cada paso: tanques, bordes, suelo (igual que el perfil).
 */
export function simulateShot3D(
  terrain: Terrain,
  params: Shot3DParams,
  tanks: readonly ShotTank3D[] = [],
  options: { recordPath?: boolean; maxTicks?: number } = {},
): Shot3DResult {
  for (const k of ["originX", "originY", "originZ", "yaw", "pitch", "power"] as const) {
    if (!Number.isFinite(params[k])) throw new RangeError(`${k} debe ser finito (recibido ${params[k]})`);
  }
  const maxX = terrain.width - 1;
  const maxZ = terrain.depth - 1;
  const maxTicks = options.maxTicks ?? MAX_SHOT_TICKS;
  const path = options.recordPath ? ([] as number[]) : undefined;

  let { x, y, z } = muzzlePosition3D(params.originX, params.originY, params.originZ, params.yaw, params.pitch);
  let { vx, vy, vz } = launchVelocity3D(params.yaw, params.pitch, params.power);
  const { ax, ay, az } = shotAcceleration3D(params.wind, params.windFactor ?? 1, params.gravityFactor ?? 1);
  const r2 = TANK_RADIUS * TANK_RADIUS;
  path?.push(x, y, z);

  const done = (outcome: Shot3DOutcome, ticks: number, tankId?: string): Shot3DResult => {
    const res: Shot3DResult = { outcome, x, y, z, ticks };
    if (tankId !== undefined) res.tankId = tankId;
    if (path) res.path = path;
    return res;
  };

  for (let tick = 1; tick <= maxTicks; tick++) {
    vx += ax;
    vy += ay;
    vz += az;
    x += vx * VELOCITY_TO_POSITION;
    y += vy * VELOCITY_TO_POSITION;
    z += vz * VELOCITY_TO_POSITION;
    path?.push(x, y, z);

    for (const t of tanks) {
      if (t.id === params.shooterId) continue;
      const dx = x - t.x;
      const dy = y - (t.y + TANK_RADIUS);
      const dz = z - t.z;
      if (dx * dx + dy * dy + dz * dz <= r2) return done("tank", tick, t.id);
    }
    if (x < 0 || x > maxX || z < 0 || z > maxZ) return done("offmap", tick);
    if (y <= terrainHeightAt(terrain, x, z)) return done("ground", tick);
  }
  return done("timeout", maxTicks);
}
