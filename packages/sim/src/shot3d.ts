// SPDX-License-Identifier: GPL-2.0-or-later
// Tiro en 3D. Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/tank/TankLib.cpp                  getVelocityVector(xy, yz), getGunPosition()
//   src/common/simactions/PlayMovesSimAction.cpp velocity = getVelocityVector(...) * (power + 1)
//   src/common/engine/PhysicsParticleObject.cpp  setForces() (viento vectorial + gravedad), simulate()
//   src/common/engine/Wind.cpp                   viento = dirección (sin a, cos a) × velocidad 0..5
//   src/common/actions/ShotProjectile.cpp        la cima: venía subiendo (`up_`) y dejó de subir
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
  WATER_LEVEL,
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

/** "water": cayó al agua (WATER_LEVEL) y se hundió. No explota, no abre cráter y no deja nada. */
export type Shot3DOutcome = "ground" | "tank" | "water" | "offmap" | "timeout";

/** Una cabeza de un tiro que se abrió en el aire (mirv.ts): cómo terminó. */
export interface ShotHead {
  outcome: Shot3DOutcome;
  x: number;
  y: number;
  z: number;
  /** Contados desde la boca del cañón, como los del tiro. */
  ticks: number;
  tankId?: string;
  /** Un trío por tick, desde el punto donde se abrió (incluido) hasta donde terminó. [wu] */
  path?: number[];
}

export interface Shot3DResult {
  outcome: Shot3DOutcome;
  x: number;
  y: number;
  z: number;
  ticks: number;
  tankId?: string;
  /** [x0, y0, z0, x1, y1, z1, ...] un trío por tick, desde la boca del cañón. [wu] */
  path?: number[];
  /** Solo Roller: dónde tocó el piso antes de rodar. (x, y, z) del resultado es donde terminó. [wu] */
  landed?: { x: number; y: number; z: number };
  /**
   * Solo MIRV que llegó a abrirse: dónde y en qué tick, y cada cabeza. heads[0] es la que sigue el
   * tiro apuntado: outcome, (x, y, z) y tankId del resultado son los suyos. `ticks` es el de la
   * última cabeza en terminar, y `path` llega hasta el punto donde se abrió.
   */
  split?: { x: number; y: number; z: number; tick: number; heads: ShotHead[] };
  /**
   * Solo Leap Frog que picó (bounce.ts): dónde tocó el piso y en qué tick. (x, y, z) del resultado es
   * donde terminó el segundo tramo, y `ticks` y `path` incluyen los dos.
   */
  bounce?: { x: number; y: number; z: number; tick: number };
}

/** Un proyectil en vuelo: posición [wu] y velocidad [vu]. */
export interface ShotBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Cómo terminó un tramo de vuelo. "apex": dejó de subir sin haber chocado (solo con `untilApex`). */
export interface FlightEnd {
  outcome: Shot3DOutcome | "apex";
  ticks: number;
  tankId?: string;
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

/** El proyectil al salir de la boca del cañón. Tira RangeError si la puntería no es finita. */
export function launchBody3D(params: Shot3DParams): ShotBody {
  for (const k of ["originX", "originY", "originZ", "yaw", "pitch", "power"] as const) {
    if (!Number.isFinite(params[k])) throw new RangeError(`${k} debe ser finito (recibido ${params[k]})`);
  }
  return {
    ...muzzlePosition3D(params.originX, params.originY, params.originZ, params.yaw, params.pitch),
    ...launchVelocity3D(params.yaw, params.pitch, params.power),
  };
}

/**
 * Un tramo de vuelo: mueve `body` hasta que pega en un tanque, en el suelo (o en el agua), sale del
 * mapa o se agota, y lo deja con la posición y la velocidad del final. Con `path`, le agrega un trío por paso.
 * Orden de chequeo después de cada paso: tanques, bordes, suelo (igual que el perfil).
 * Con `untilApex` corta además en la cima: el primer paso en que ya no sube, habiendo subido antes
 * (ShotProjectile.cpp, `up_`). Un tiro que choca mientras sube no llega a la cima.
 */
export function flyShot3D(
  terrain: Terrain,
  body: ShotBody,
  accel: { ax: number; ay: number; az: number },
  tanks: readonly ShotTank3D[] = [],
  options: { shooterId?: string; maxTicks?: number; path?: number[]; untilApex?: boolean } = {},
): FlightEnd {
  const maxX = terrain.width - 1;
  const maxZ = terrain.depth - 1;
  const maxTicks = options.maxTicks ?? MAX_SHOT_TICKS;
  const { path, shooterId, untilApex } = options;
  const { ax, ay, az } = accel;
  const r2 = TANK_RADIUS * TANK_RADIUS;
  let { x, y, z, vx, vy, vz } = body;
  let up = false;

  const done = (outcome: FlightEnd["outcome"], ticks: number, tankId?: string): FlightEnd => {
    Object.assign(body, { x, y, z, vx, vy, vz });
    return tankId === undefined ? { outcome, ticks } : { outcome, ticks, tankId };
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
      if (t.id === shooterId) continue;
      const dx = x - t.x;
      const dy = y - (t.y + TANK_RADIUS);
      const dz = z - t.z;
      if (dx * dx + dy * dy + dz * dz <= r2) return done("tank", tick, t.id);
    }
    if (x < 0 || x > maxX || z < 0 || z > maxZ) return done("offmap", tick);
    const ground = terrainHeightAt(terrain, x, z);
    if (y <= ground) return done(ground <= WATER_LEVEL ? "water" : "ground", tick);
    if (vy > 0) up = true;
    else if (up && untilApex) return done("apex", tick);
  }
  return done("timeout", maxTicks);
}

/** Simula el tiro hasta que pega en un tanque, en el suelo, sale del mapa o se agota. */
export function simulateShot3D(
  terrain: Terrain,
  params: Shot3DParams,
  tanks: readonly ShotTank3D[] = [],
  options: { recordPath?: boolean; maxTicks?: number } = {},
): Shot3DResult {
  const body = launchBody3D(params);
  const path = options.recordPath ? [body.x, body.y, body.z] : undefined;
  const accel = shotAcceleration3D(params.wind, params.windFactor ?? 1, params.gravityFactor ?? 1);
  const end = flyShot3D(terrain, body, accel, tanks, { shooterId: params.shooterId, maxTicks: options.maxTicks, path });
  const res: Shot3DResult = { outcome: end.outcome as Shot3DOutcome, x: body.x, y: body.y, z: body.z, ticks: end.ticks };
  if (end.tankId !== undefined) res.tankId = end.tankId;
  if (path) res.path = path;
  return res;
}
