// SPDX-License-Identifier: GPL-2.0-or-later
// Roller: el arma que no termina donde cae. Vuela como un Missile, toca el piso y, en vez de explotar
// ahí, rueda cuesta abajo hasta que llega a un tanque, se queda sin pendiente o recorre su máximo
// de celdas. Recién ahí explota.
//
// Regla propia. El original tiene rollers (src/common/weapons/WeaponRoller.cpp) que ruedan como
// partícula con rebote; acá la rodada es un descenso por el gradiente del terreno, en pasos fijos:
// determinista, sin inercia, y la misma función corre en el server (turn3d.ts), en la fantasma del
// cliente y en el bot.

import { POWER_MAX, TANK_RADIUS } from "./constants";
import { simulateSplitShot3D } from "./mirv";
import { simulateShot3D, type Shot3DParams, type Shot3DResult, type ShotTank3D } from "./shot3d";
import { terrainHeightAt, type Terrain } from "./terrain";
import type { Weapon } from "./weapons";

/** Radio de la bola: rueda con el centro a esta altura del piso y toca un tanque a TANK_RADIUS + esto. [wu] */
export const ROLLER_RADIUS = 0.5;
/** Lo que avanza por paso, sobre el piso (XZ). Un paso dura lo mismo que un tick de vuelo. [wu / paso] */
export const ROLL_STEP = 0.12;
/** Pendiente mínima para seguir rodando: con menos, la bola se queda y explota. [wu / wu] */
export const ROLL_MIN_SLOPE = 0.03;

export interface RollResult {
  /** "tank": llegó a un tanque. "ground": se quedó sin pendiente, sin celdas o llegó al borde. */
  outcome: "ground" | "tank";
  /** Dónde terminó; y es la altura del piso ahí. [wu] */
  x: number;
  y: number;
  z: number;
  steps: number;
  tankId?: string;
  /** [x, y, z, ...] un trío por paso; y es el centro de la bola (piso + ROLLER_RADIUS). [wu] */
  path?: number[];
}

/**
 * Rueda desde `from` siguiendo la bajada más empinada. Corta, en este orden: al tocar un tanque
 * (cualquiera de `tanks`, también el que disparó: si vuelve rodando, te pega), al recorrer
 * `maxCells`, cuando la pendiente es menor que ROLL_MIN_SLOPE, en el borde del mapa, o cuando el
 * paso siguiente no baja (fondo de un valle o de un cráter).
 */
export function simulateRoll(
  terrain: Terrain,
  from: { x: number; z: number },
  maxCells: number,
  tanks: readonly ShotTank3D[] = [],
  options: { recordPath?: boolean } = {},
): RollResult {
  const path = options.recordPath ? ([] as number[]) : undefined;
  const maxSteps = Math.floor(maxCells / ROLL_STEP);
  const reach2 = (TANK_RADIUS + ROLLER_RADIUS) ** 2;
  let { x, z } = from;
  let h = terrainHeightAt(terrain, x, z);

  const done = (outcome: RollResult["outcome"], steps: number, tankId?: string): RollResult => {
    const res: RollResult = { outcome, x, y: h, z, steps };
    if (tankId !== undefined) res.tankId = tankId;
    if (path) res.path = path;
    return res;
  };

  for (let step = 0; ; step++) {
    path?.push(x, h + ROLLER_RADIUS, z);
    for (const t of tanks) {
      const dx = x - t.x;
      const dy = h + ROLLER_RADIUS - (t.y + TANK_RADIUS);
      const dz = z - t.z;
      if (dx * dx + dy * dy + dz * dz <= reach2) return done("tank", step, t.id);
    }
    if (step >= maxSteps) return done("ground", step);

    // Gradiente por diferencias centrales a media celda: suaviza los quiebres de la interpolación bilineal.
    const gx = terrainHeightAt(terrain, x + 0.5, z) - terrainHeightAt(terrain, x - 0.5, z);
    const gz = terrainHeightAt(terrain, x, z + 0.5) - terrainHeightAt(terrain, x, z - 0.5);
    const slope = Math.hypot(gx, gz);
    if (slope < ROLL_MIN_SLOPE) return done("ground", step);
    const nx = x - (gx / slope) * ROLL_STEP;
    const nz = z - (gz / slope) * ROLL_STEP;
    if (nx < 1 || nz < 1 || nx > terrain.width - 2 || nz > terrain.depth - 2) return done("ground", step);
    const nh = terrainHeightAt(terrain, nx, nz);
    if (!(nh < h)) return done("ground", step);
    x = nx;
    z = nz;
    h = nh;
  }
}

/**
 * El tiro de un arma, de la boca del cañón a donde explota. Para Baby Missile y Missile es
 * simulateShot3D con los factores del arma. Para el Roller, la potencia se multiplica por
 * `roll.powerFactor` y, si el vuelo termina en el piso, sigue la rodada: `landed` es donde tocó,
 * (x, y, z) donde terminó, y `ticks` y `path` incluyen los pasos rodando. Para el MIRV, el vuelo se
 * abre en la cima (simulateSplitShot3D, mirv.ts) y el resultado trae `split`.
 * `params.windFactor` y `params.gravityFactor` se ignoran: salen del arma.
 */
export function simulateWeaponShot3D(
  terrain: Terrain,
  weapon: Weapon,
  params: Shot3DParams,
  tanks: readonly ShotTank3D[] = [],
  options: { recordPath?: boolean; maxTicks?: number } = {},
): Shot3DResult {
  const roll = weapon.roll;
  const power = roll ? Math.min(POWER_MAX, Math.max(0, params.power)) * roll.powerFactor : params.power;
  const launch = { ...params, power, windFactor: weapon.windFactor, gravityFactor: weapon.gravityFactor };
  if (weapon.split) return simulateSplitShot3D(terrain, weapon.split, launch, tanks, options);
  const flight = simulateShot3D(terrain, launch, tanks, options);
  if (!roll || flight.outcome !== "ground") return flight;

  const r = simulateRoll(terrain, flight, roll.maxCells, tanks, options);
  const out: Shot3DResult = {
    outcome: r.outcome,
    x: r.x,
    y: r.y,
    z: r.z,
    ticks: flight.ticks + r.steps,
    landed: { x: flight.x, y: terrainHeightAt(terrain, flight.x, flight.z), z: flight.z },
  };
  if (r.tankId !== undefined) out.tankId = r.tankId;
  // El último punto del vuelo (ya bajo el piso) se cambia por el primero de la rodada, apoyado en
  // el piso: así sigue habiendo un punto por tick.
  if (flight.path && r.path) out.path = flight.path.slice(0, -3).concat(r.path);
  return out;
}
