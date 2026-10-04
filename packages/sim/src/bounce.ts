// SPDX-License-Identifier: GPL-2.0-or-later
// Leap Frog: el arma que pica. Sale como un Missile, toca el piso y, en vez de explotar ahí, sigue:
// una sola vez, con menos fuerza. Explota donde termina el segundo tramo. No rueda y no se abre.
//
// Regla propia. El original tiene un Leap Frog (src/common/weapons/WeaponLeapFrog.cpp); acá el pique
// se escribió para este juego: uno solo, sin explosión en el primer golpe, y con una cuenta sin azar
// que hacen igual el server (turn3d.ts), la fantasma del cliente y los tests.

import { MAX_SHOT_TICKS } from "./constants";
import {
  flyShot3D,
  launchBody3D,
  shotAcceleration3D,
  type FlightEnd,
  type Shot3DOutcome,
  type Shot3DParams,
  type Shot3DResult,
  type ShotTank3D,
} from "./shot3d";
import { terrainHeightAt, type Terrain } from "./terrain";
import type { BounceSpec } from "./weapons";

/**
 * El tiro de un arma que pica. El primer tramo vuela como simulateShot3D. Si termina en el piso, pica
 * ahí (ver Shot3DResult.bounce): el proyectil queda apoyado en el piso, conserva el rumbo con
 * `bounce.keep` de la velocidad que traía, y lo que venía bajando ahora sube. No se refleja contra la
 * ladera: sigue para adelante, también cuesta arriba (si la ladera es más empinada que el pique,
 * vuelve a tocar ahí nomás). El segundo tramo vuela con el mismo viento y la misma gravedad hasta que
 * pega en un tanque, en el suelo, sale del mapa o se agota: ese final es el del tiro.
 * Si el primer tramo pega en un tanque, se va del mapa o se agota, no hay pique: el resultado es el
 * de un tiro común, sin `bounce`.
 */
export function simulateBounceShot3D(
  terrain: Terrain,
  bounce: BounceSpec,
  params: Shot3DParams,
  tanks: readonly ShotTank3D[] = [],
  options: { recordPath?: boolean; maxTicks?: number } = {},
): Shot3DResult {
  const maxTicks = options.maxTicks ?? MAX_SHOT_TICKS;
  const accel = shotAcceleration3D(params.wind, params.windFactor ?? 1, params.gravityFactor ?? 1);
  const body = launchBody3D(params);
  const path = options.recordPath ? [body.x, body.y, body.z] : undefined;
  const result = (end: FlightEnd, ticks: number): Shot3DResult => {
    const res: Shot3DResult = { outcome: end.outcome as Shot3DOutcome, x: body.x, y: body.y, z: body.z, ticks };
    if (end.tankId !== undefined) res.tankId = end.tankId;
    if (path) res.path = path;
    return res;
  };

  const first = flyShot3D(terrain, body, accel, tanks, { shooterId: params.shooterId, maxTicks, path });
  if (first.outcome !== "ground") return result(first, first.ticks);

  // El último punto del tramo quedó bajo el piso: el pique sale apoyado, y así sigue habiendo un
  // punto por tick.
  body.y = terrainHeightAt(terrain, body.x, body.z);
  if (path) path[path.length - 2] = body.y;
  const at = { x: body.x, y: body.y, z: body.z, tick: first.ticks };
  body.vx *= bounce.keep;
  body.vy = Math.abs(body.vy) * bounce.keep;
  body.vz *= bounce.keep;

  const second = flyShot3D(terrain, body, accel, tanks, { shooterId: params.shooterId, maxTicks: maxTicks - first.ticks, path });
  return { ...result(second, first.ticks + second.ticks), bounce: at };
}
