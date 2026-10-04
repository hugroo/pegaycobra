// SPDX-License-Identifier: GPL-2.0-or-later
// MIRV: el arma que se abre en el aire. Sale como un Missile y, en la cima de la parábola, se parte
// en cabezas: una sigue el tiro tal como iba y las demás se abren alrededor. Cada cabeza explota
// donde cae, con su cráter.
//
// Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/actions/ShotProjectile.cpp  <apexcollision>: se abre cuando deja de subir (flyShot3D)
//   src/common/weapons/WeaponMirv.cpp      fireWeapon(): una cabeza con la velocidad del tiro
//                                          ("will fall where the original was aimed") y noWarheads - 1 más
// Regla propia: cómo se abren. En el original las otras cabezas salen en fila a lo largo del tiro
// (<vspreaddist>, velocidad vertical) con un desvío de costado al azar (<hspreaddist>). Acá no hay
// azar y el racimo cae siempre del mismo tamaño: las otras se reparten en ronda y reciben la
// velocidad justa para caer a `radius` de la del medio. Así el server, la fantasma del cliente y
// los tests hacen la misma cuenta y da lo mismo.

import { MAX_SHOT_TICKS, VELOCITY_TO_POSITION } from "./constants";
import {
  flyShot3D,
  launchBody3D,
  normalizeYaw,
  shotAcceleration3D,
  type Shot3DOutcome,
  type Shot3DParams,
  type Shot3DResult,
  type ShotBody,
  type ShotHead,
  type ShotTank3D,
} from "./shot3d";
import type { Terrain } from "./terrain";
import type { SplitSpec } from "./weapons";

/**
 * Tope de la velocidad horizontal que recibe una cabeza al abrirse. Con la cima muy cerca del piso
 * (menos de ~60 pasos de caída) no alcanza para llegar a `radius`: se abren menos, en vez de salir
 * disparadas de costado. [vu]
 */
export const SPLIT_MAX_KICK = 12;

/**
 * Hacia dónde se abre la cabeza `i`, en el piso (XZ): vector unitario, o (0, 0) para la 0, que
 * sigue el tiro. Las demás se reparten en ronda, en ángulos iguales alrededor del rumbo del tiro,
 * corridas media vuelta para que ninguna quede justo adelante ni justo atrás: con 5 cabezas son
 * las cuatro puntas de una X.
 */
export function splitDirection(heads: number, yaw: number, i: number): { x: number; z: number } {
  if (i <= 0 || heads < 2) return { x: 0, z: 0 };
  const a = (normalizeYaw(yaw) * Math.PI) / 180 + ((i - 0.5) * 2 * Math.PI) / (heads - 1);
  return { x: Math.cos(a), z: Math.sin(a) };
}

/**
 * El tiro de un arma que se abre. Vuela como simulateShot3D hasta la cima; ahí salen `split.heads`
 * cabezas desde ese punto y cada una sigue hasta que pega en un tanque, en el suelo, sale del mapa
 * o se agota (ver Shot3DResult.split). La 0 sigue con la velocidad que traía el tiro. Las demás
 * suman, cada una para su lado (splitDirection), la velocidad que en lo que tarda en caer la 0 las
 * aleja `split.radius` de ella (con tope SPLIT_MAX_KICK): en piso llano caen justo a esa distancia.
 * Todas vuelan sobre el terreno y los tanques de antes del tiro: el cráter de una no desvía a otra.
 * Si choca mientras sube (un cerro, un tanque) o nunca sube (pitch 0), no llega a abrirse: el
 * resultado es el de un tiro común, sin `split`.
 */
export function simulateSplitShot3D(
  terrain: Terrain,
  split: SplitSpec,
  params: Shot3DParams,
  tanks: readonly ShotTank3D[] = [],
  options: { recordPath?: boolean; maxTicks?: number } = {},
): Shot3DResult {
  const maxTicks = options.maxTicks ?? MAX_SHOT_TICKS;
  const accel = shotAcceleration3D(params.wind, params.windFactor ?? 1, params.gravityFactor ?? 1);
  const body = launchBody3D(params);
  const path = options.recordPath ? [body.x, body.y, body.z] : undefined;
  const flight = flyShot3D(terrain, body, accel, tanks, { shooterId: params.shooterId, maxTicks, path, untilApex: true });

  if (flight.outcome !== "apex") {
    const res: Shot3DResult = { outcome: flight.outcome, x: body.x, y: body.y, z: body.z, ticks: flight.ticks };
    if (flight.tankId !== undefined) res.tankId = flight.tankId;
    if (path) res.path = path;
    return res;
  }

  const fly = (head: ShotBody): ShotHead => {
    const headPath = path ? [body.x, body.y, body.z] : undefined;
    const end = flyShot3D(terrain, head, accel, tanks, { shooterId: params.shooterId, maxTicks: maxTicks - flight.ticks, path: headPath });
    const h: ShotHead = { outcome: end.outcome as Shot3DOutcome, x: head.x, y: head.y, z: head.z, ticks: flight.ticks + end.ticks };
    if (end.tankId !== undefined) h.tankId = end.tankId;
    if (headPath) h.path = headPath;
    return h;
  };
  const aimed = fly({ ...body });
  const fall = Math.max(1, aimed.ticks - flight.ticks);
  const kick = Math.min(SPLIT_MAX_KICK, split.radius / (fall * VELOCITY_TO_POSITION));
  const heads = [aimed];
  for (let i = 1; i < split.heads; i++) {
    const dir = splitDirection(split.heads, params.yaw, i);
    heads.push(fly({ ...body, vx: body.vx + dir.x * kick, vz: body.vz + dir.z * kick }));
  }

  const res: Shot3DResult = {
    outcome: aimed.outcome,
    x: aimed.x,
    y: aimed.y,
    z: aimed.z,
    ticks: Math.max(...heads.map((h) => h.ticks)),
    split: { x: body.x, y: body.y, z: body.z, tick: flight.ticks, heads },
  };
  if (aimed.tankId !== undefined) res.tankId = aimed.tankId;
  if (path) res.path = path;
  return res;
}

/**
 * Los golpes de un tiro, en el orden en que caen: uno solo, salvo un MIRV abierto, que da uno por
 * cabeza (las que caen en el mismo tick, en el orden en que salieron). Incluye los que se fueron
 * del mapa: el que llama mira `outcome`.
 */
export function shotImpacts(shot: Shot3DResult): readonly ShotHead[] {
  if (!shot.split) return [shot];
  return shot.split.heads.slice().sort((a, b) => a.ticks - b.ticks);
}
