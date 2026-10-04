// SPDX-License-Identifier: GPL-2.0-or-later
import { launchPower, WEAPONS, type WeaponId } from "../src";

/**
 * La potencia que hay que apuntar con `weapon` para que el tiro salga del cañón con `launch`: la
 * inversa de launchPower (weapons.ts). Varios escenarios ponen al rival a 93 celdas, que es donde
 * cae un tiro a 45° que sale con potencia 600; con esto cada arma cae ahí, tenga el alcance que tenga.
 */
export function dial(weapon: WeaponId, launch: number): number {
  return launch / launchPower(WEAPONS[weapon], 1);
}
