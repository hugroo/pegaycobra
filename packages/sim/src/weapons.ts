// SPDX-License-Identifier: GPL-2.0-or-later
// Parámetros de armas tomados de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   data/globalmods/none/data/accessories.xml  (<accessory> Baby Missile, Missile, Baby Nuke, Nuke)
// Campos que el XML no declara toman el default del parser:
//   src/common/weapons/WeaponProjectile.cpp (windFactor/gravityFactor = 1)
//   src/common/weapons/WeaponExplosion.cpp  (deformsize = size si no se declara)
//
// El MVP solo dispara la Baby Missile; las otras tres quedan documentadas para la tienda.

import { INFINITE_AMMO } from "./constants";

export type WeaponId = "babyMissile" | "missile" | "babyNuke" | "nuke";

export interface Weapon {
  readonly id: WeaponId;
  /** Nombre en el original. */
  readonly name: string;
  /**
   * <armslevel>: multiplica el premio por daño y por kill (TargetDamage.cpp).
   * Más alto = arma más "barata" de usar, paga más por punto de daño.
   */
  readonly armsLevel: number;
  /** <cost> por bundle. [$] */
  readonly cost: number;
  /** <bundlesize>: unidades por compra. [disparos] */
  readonly bundleSize: number;
  /** <startingnumber>: munición inicial; INFINITE_AMMO (-1) = nunca se gasta. [disparos] */
  readonly startingNumber: number;
  /** WeaponExplosion <size>: radio de daño. [wu] */
  readonly explosionRadius: number;
  /** WeaponExplosion <deformsize> (= size): radio del cráter. [wu] */
  readonly craterRadius: number;
  /** WeaponExplosion <hurtamount>: multiplicador del daño. [adimensional] */
  readonly hurtAmount: number;
  /** WeaponProjectile <windfactor>. [adimensional] */
  readonly windFactor: number;
  /** WeaponProjectile <gravityfactor>. [adimensional] */
  readonly gravityFactor: number;
}

export const WEAPONS: Readonly<Record<WeaponId, Weapon>> = Object.freeze({
  babyMissile: {
    id: "babyMissile",
    name: "Baby Missile",
    armsLevel: 10,
    cost: 0, // sin <cost> en el XML: no se vende, es el arma base
    bundleSize: 1, // sin <bundlesize> en el XML
    startingNumber: INFINITE_AMMO, // <startingnumber>-1</startingnumber>
    explosionRadius: 3.5,
    craterRadius: 3.5,
    hurtAmount: 1,
    windFactor: 1,
    gravityFactor: 1,
  },
  missile: {
    id: "missile",
    name: "Missile",
    armsLevel: 9,
    cost: 2000,
    bundleSize: 5,
    startingNumber: 0,
    explosionRadius: 6,
    craterRadius: 6,
    hurtAmount: 1,
    windFactor: 1,
    gravityFactor: 1,
  },
  babyNuke: {
    id: "babyNuke",
    name: "Baby Nuke",
    armsLevel: 6,
    cost: 8000,
    bundleSize: 3,
    startingNumber: 0,
    explosionRadius: 11,
    craterRadius: 11,
    hurtAmount: 1,
    windFactor: 1,
    gravityFactor: 1,
  },
  nuke: {
    id: "nuke",
    name: "Nuke",
    armsLevel: 4,
    cost: 12000,
    bundleSize: 2,
    startingNumber: 0,
    explosionRadius: 18,
    craterRadius: 18,
    hurtAmount: 1,
    windFactor: 1,
    gravityFactor: 1,
  },
});

/**
 * Armas que se pueden disparar: la Baby Missile (infinita, no se compra) y el Missile (se compra
 * en la tienda, ver campaign.ts). Baby Nuke y Nuke existen solo como datos.
 */
export const PLAYABLE_WEAPONS: readonly WeaponId[] = Object.freeze(["babyMissile", "missile"]);

export function isPlayable(id: WeaponId): boolean {
  return PLAYABLE_WEAPONS.includes(id);
}
