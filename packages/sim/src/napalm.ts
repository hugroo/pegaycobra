// SPDX-License-Identifier: GPL-2.0-or-later
// Napalm: el arma que no explota. Vuela como un Missile y, donde cae, prende un disco de fuego que
// queda hasta que termina la ronda. No abre cráter (el heightmap no cambia) y al caer no saca vida:
// lastima el fuego, cada vez que empieza el turno de un tanque que sigue parado adentro.
//
// Regla propia. El original tiene napalm (src/common/weapons/WeaponNapalm.cpp) que corre cuesta
// abajo y quema por tiempo real; acá el disco es fijo y el reloj es el turno. Las dos funciones de
// este archivo son la única cuenta del fuego: las usan el server (turn3d.ts) y, en el cliente, la
// fantasma y el HUD.

import type { Shot3DResult } from "./shot3d";
import type { Weapon, WeaponId } from "./weapons";

/** Un fuego prendido en el piso. Vive en MatchState3D.fires hasta que termina la ronda. */
export interface Fire {
  /** Centro del disco, en el piso (XZ). [wu] */
  readonly x: number;
  readonly z: number;
  /** [wu] */
  readonly radius: number;
  /** Vida que le saca al tanque que empieza su turno adentro. [hp / turno] */
  readonly damagePerTurn: number;
  /** Quién lo prendió: cobra el daño que haga (y lo paga si se quema él). */
  readonly ownerId: string;
  /** Con qué arma, para el armslevel del premio. */
  readonly weaponId: WeaponId;
}

/**
 * El fuego que deja un tiro, o null si no deja ninguno: el arma no quema, o el tiro se fue del mapa.
 * El centro es donde terminó el tiro (si pegó en un tanque, debajo de ese punto).
 */
export function fireFromShot(weapon: Weapon, shot: Shot3DResult, ownerId: string): Fire | null {
  if (!weapon.burn) return null;
  if (shot.outcome !== "ground" && shot.outcome !== "tank") return null;
  return {
    x: shot.x,
    z: shot.z,
    radius: weapon.burn.radius,
    damagePerTurn: weapon.burn.damagePerTurn,
    ownerId,
    weaponId: weapon.id,
  };
}

/**
 * ¿(x, z) está adentro del disco? Se mide en el piso, sin altura, y con la base del tanque como un
 * punto: el disco que se dibuja es exactamente donde quema.
 */
export function inFire(fire: { x: number; z: number; radius: number }, at: { x: number; z: number }): boolean {
  return Math.hypot(at.x - fire.x, at.z - fire.z) <= fire.radius;
}
