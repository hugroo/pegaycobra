// SPDX-License-Identifier: GPL-2.0-or-later
// Economía. Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/target/TargetDamage.cpp            premio por daño y por kill (× armslevel, × daño/100)
//   src/common/simactions/ShowScoreSimAction.cpp  interés + MoneyPerRound al final de la ronda
//   src/common/tank/TankScore.cpp                 setMoney(): recorte a [0, 999999]
//   src/common/common/OptionsGame.cpp             valores por defecto (ver constants.ts)
//   data/globalmods/none/data/accessories.xml     Baby Missile con startingnumber -1 (infinita)

import {
  INFINITE_AMMO,
  INTEREST_RATE,
  MONEY_MAX,
  MONEY_PER_HEALTH_POINT,
  MONEY_PER_HIT_POINT,
  MONEY_PER_KILL_POINT,
  MONEY_PER_ROUND,
} from "./constants";
import { WEAPONS, type WeaponId } from "./weapons";

/** Recorta la plata a [0, MONEY_MAX] y la deja entera. TankScore::setMoney(). [$] */
export function clampMoney(money: number): number {
  if (!Number.isFinite(money)) throw new RangeError(`plata no finita: ${money}`);
  return Math.min(MONEY_MAX, Math.max(0, Math.trunc(money)));
}

export interface DamageReward {
  /** Daño efectivamente quitado (ya recortado a la vida del blanco). [hp] */
  damage: number;
  /** El daño mató al blanco. */
  killed: boolean;
  /** armslevel del arma que causó el daño. */
  armsLevel: number;
  /** Daño propio (o de equipo): el premio se resta en vez de sumarse. */
  friendly: boolean;
}

/**
 * Plata que gana (o pierde) quien disparó, por un evento de daño. [$]
 * TargetDamage::damageTarget():
 *   sin kill: MoneyWonPerHitPoint · armslevel
 *   con kill: MoneyWonPerKillPoint · armslevel
 *   si MoneyPerHealthPoint: · trunc(daño) / 100 (división entera)
 *   daño propio: negativo
 */
export function moneyForDamage({ damage, killed, armsLevel, friendly }: DamageReward): number {
  let money = (killed ? MONEY_PER_KILL_POINT : MONEY_PER_HIT_POINT) * armsLevel;
  if (MONEY_PER_HEALTH_POINT) money = Math.trunc((money * Math.trunc(damage)) / 100);
  return friendly ? -money : money;
}

/**
 * Plata al terminar la ronda: efectivo + trunc(efectivo · 15%) + MoneyPerRound. [$]
 * ShowScoreSimAction: `addMoney = (money * interest).asInt() + getMoneyPerRound()`.
 * El interés es sobre lo que no se gastó: se llama con la plata que quedó.
 */
export function endOfRoundMoney(money: number): number {
  const m = clampMoney(money);
  return clampMoney(m + Math.trunc(m * INTEREST_RATE) + MONEY_PER_ROUND);
}

/** Lo que puede haber en el inventario: armas y los accesorios de la tienda (campaign.ts). */
export type InventoryKey = WeaponId | "parachute" | "fuel" | "shield";

/** Cantidad por ítem. Armas: INFINITE_AMMO (-1) = infinita. Ausente = 0. */
export type Inventory = Readonly<Partial<Record<InventoryKey, number>>>;

/** Inventario al empezar la partida: <startingnumber> de cada arma. */
export function startingInventory(): Inventory {
  const inv: Partial<Record<InventoryKey, number>> = {};
  for (const w of Object.values(WEAPONS)) if (w.startingNumber !== 0) inv[w.id] = w.startingNumber;
  return inv;
}

export function ammoOf(inventory: Inventory, id: WeaponId): number {
  return inventory[id] ?? 0;
}

export function canFire(inventory: Inventory, id: WeaponId): boolean {
  const n = ammoOf(inventory, id);
  return n === INFINITE_AMMO || n > 0;
}

/** Gasta un disparo. La munición infinita no se toca. Sin munición, tira error. */
export function consumeAmmo(inventory: Inventory, id: WeaponId): Inventory {
  const n = ammoOf(inventory, id);
  if (n === INFINITE_AMMO) return inventory;
  if (n <= 0) throw new Error(`sin munición de ${id}`);
  return { ...inventory, [id]: n - 1 };
}
