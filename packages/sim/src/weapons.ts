// SPDX-License-Identifier: GPL-2.0-or-later
// Parámetros de armas tomados de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   data/globalmods/none/data/accessories.xml  (<accessory> Baby Missile, Missile, Baby Nuke, Nuke, Dirt Ball, MIRV)
// Campos que el XML no declara toman el default del parser:
//   src/common/weapons/WeaponProjectile.cpp (windFactor/gravityFactor = 1)
//   src/common/weapons/WeaponExplosion.cpp  (deformsize = size si no se declara)
//
//
// El Roller es regla propia: el original tiene una familia de rollers (WeaponRoller.cpp), pero acá
// los números y la rodada (roller.ts) se escribieron para este juego, no se portaron.
// El Napalm también: el original lo tiene (WeaponNapalm.cpp, corre cuesta abajo y quema por tiempo);
// acá es un disco fijo que quema por turno (napalm.ts), con números de este juego.
// El Nuke usa los números del XML. Que el escudo no lo frene es regla propia (turn3d.ts).
// La Dirt Ball también usa los números del XML (<deform>up</deform>, <hurtamount>0.0</hurtamount>).
// Regla propia: en el original la tierra tapa al tanque; acá el tanque sube con la loma (turn3d.ts).
// Del MIRV se toman el armslevel y las 5 cabezas (<nowarheads>). El tamaño de cada cabeza, el precio
// y cómo se abren son de este juego (mirv.ts).
// El Leap Frog es regla propia: el original tiene uno (src/common/weapons/WeaponLeapFrog.cpp); acá
// pica una sola vez y explota recién en el segundo golpe (bounce.ts), con números de este juego.
// El alcance (`reach`) es regla propia: en el original todas las armas salen del cañón con la misma
// velocidad. Acá cada una tiene el suyo, y de ese número sale con cuánta fuerza sale (launchPower).

import { FORCE_DIVISOR, GRAVITY, INFINITE_AMMO, POWER_MAX, POWER_TO_VELOCITY, VELOCITY_TO_POSITION } from "./constants";

export type WeaponId = "babyMissile" | "missile" | "roller" | "napalm" | "babyNuke" | "nuke" | "dirt" | "mirv" | "leapfrog";

/** Arma que no explota donde cae: toca el piso y rueda cuesta abajo (roller.ts). */
export interface RollSpec {
  /** Lo máximo que rueda, medido sobre el piso (XZ). [celdas = wu] */
  readonly maxCells: number;
}

/** Arma que no explota: donde cae deja un disco de fuego hasta que termina la ronda (napalm.ts). */
export interface BurnSpec {
  /** Radio del disco de fuego, sobre el piso (XZ). [celdas = wu] */
  readonly radius: number;
  /** Vida que pierde un tanque parado en el disco, cada vez que empieza su turno. [hp / turno] */
  readonly damagePerTurn: number;
}

/** Arma que no explota: donde cae suma tierra y levanta una loma (applyMoundTerrain, terrain.ts). */
export interface MoundSpec {
  /** WeaponExplosion <size> con <deform>up</deform>: radio de la loma, sobre el piso (XZ). [wu] */
  readonly radius: number;
}

/** Arma que se abre en el aire: en la cima de la parábola se parte en cabezas, y explota cada una (mirv.ts). */
export interface SplitSpec {
  /** WeaponMirv <nowarheads>: cuántas cabezas salen, contando la que sigue el tiro apuntado. */
  readonly heads: number;
  /** A qué distancia de esa cae cada una de las otras, sobre el piso (XZ), en terreno llano. [celdas = wu] */
  readonly radius: number;
}

/** Arma que no explota donde cae: pica en el piso, sigue con menos fuerza y explota en el segundo golpe (bounce.ts). */
export interface BounceSpec {
  /** Con cuánta velocidad sale del pique, como fracción de la que traía al tocar el piso. [adimensional] */
  readonly keep: number;
}

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
  /**
   * Alcance: hasta dónde llega en piso llano y sin viento, con la potencia al máximo y el cañón a
   * 45°. Es el único número que dice qué tan lejos tira el arma; la cuenta la hace launchPower.
   * Para el Roller es hasta donde toca el piso (después rueda) y para el Leap Frog, hasta el pique.
   * Como medida: el mapa tiene 256 celdas de lado y los tanques nacen a 120–155 celdas uno de otro
   * en la Isla y el Valle, y a 155–195 en el Cerro (de a dos; con más jugadores, más cerca). [celdas = wu]
   */
  readonly reach: number;
  /** Solo el Roller: cómo rueda después de tocar el piso. */
  readonly roll?: RollSpec;
  /** Solo el Napalm: el fuego que deja donde cae. */
  readonly burn?: BurnSpec;
  /** Solo el Nuke: el escudo no absorbe su explosión ni se gasta. */
  readonly piercesShield?: boolean;
  /** Solo la Dirt Ball: la loma que levanta donde cae. */
  readonly mound?: MoundSpec;
  /** Solo el MIRV: cómo se abre en la cima. Los radios del arma son los de cada cabeza. */
  readonly split?: SplitSpec;
  /** Solo el Leap Frog: cómo pica. Los radios del arma son los del segundo golpe. */
  readonly bounce?: BounceSpec;
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
    // La que viene gratis llega menos que el Misil: cruza la Isla y el Valle, y en el Cerro alcanza
    // casi siempre, pero al tanque lejano detrás de un cerro alto ya no.
    reach: 200,
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
    // El tiro largo. Menos que el mapa entero (antes eran 252 para todas), y más que cualquier
    // distancia a la que nacen dos tanques.
    reach: 230,
  },
  roller: {
    id: "roller",
    name: "Roller",
    armsLevel: 8,
    cost: 1500,
    bundleSize: 2,
    startingNumber: 0,
    explosionRadius: 4.5,
    craterRadius: 2, // cráter chico: lo que lastima es llegar al tanque, no el hoyo
    hurtAmount: 1,
    windFactor: 1,
    gravityFactor: 1,
    // Vuela como un Misil: los tanques nacen a 155–195 celdas en el Cerro y tiene que pasar el cerro
    // del medio para rodar del otro lado (con 93 de alcance no lo pasaba).
    reach: 230,
    // El tope de rodada casi no se toca: en los terrenos de partida la bola se frena antes, en el
    // fondo del valle (mediana ~25 celdas).
    roll: { maxCells: 60 },
  },
  napalm: {
    id: "napalm",
    name: "Napalm",
    armsLevel: 7,
    cost: 2000,
    bundleSize: 1,
    startingNumber: 0,
    // No explota ni abre cráter: al caer no saca vida y el heightmap no cambia. Lo que lastima es
    // el fuego, turno a turno.
    explosionRadius: 0,
    craterRadius: 0,
    hurtAmount: 0,
    windFactor: 1,
    gravityFactor: 1,
    // Sale como un Misil.
    reach: 230,
    // Disco chico (el Missile explota con radio 6): hay que caer cerca. 25 por turno son cuatro
    // turnos para un tanque que no se mueve.
    burn: { radius: 5, damagePerTurn: 25 },
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
    reach: 150,
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
    // Pesa: llega a menos de la mitad que un Misil. Desde la playa de la Isla cae en la ladera de
    // enfrente y, con su radio de 18, no toca al de la costa opuesta (a unas 120 celdas). Es el hoyo,
    // no el tiro que llega a todos: hay que tener al otro cerca, o acercarse con nafta.
    reach: 95,
    piercesShield: true,
  },
  dirt: {
    id: "dirt",
    name: "Dirt Ball",
    armsLevel: 9,
    cost: 5750,
    bundleSize: 5,
    startingNumber: 0,
    // <hurtamount>0.0</hurtamount> y <deform>up</deform>: no saca vida ni abre cráter. El <size>
    // del XML es el radio de la loma, no el de una explosión.
    explosionRadius: 0,
    craterRadius: 0,
    hurtAmount: 0,
    windFactor: 1,
    gravityFactor: 1,
    // Cae como un Misil.
    reach: 230,
    mound: { radius: 10 }, // <size>10</size>
  },
  mirv: {
    id: "mirv",
    name: "MIRV",
    armsLevel: 6,
    // El XML dice <cost>16000</cost> por <bundlesize>3</bundlesize>, con cabezas de <size>6</size>
    // (un Missile cada una). Acá cada cabeza es más chica, y el precio acompaña.
    cost: 2500,
    bundleSize: 1,
    startingNumber: 0,
    // Cada cabeza explota como un Roller: lastima a 4.5 y deja un cráter chico. Con cráteres de
    // radio 6 las cinco abrían un solo hoyo grande.
    explosionRadius: 4.5,
    craterRadius: 2,
    hurtAmount: 1, // <hurtamount>1.0</hurtamount>
    windFactor: 1,
    gravityFactor: 1,
    // Sale como un Misil.
    reach: 230,
    // <nowarheads>5</nowarheads>. A 7 celdas los hoyos (3 de radio) quedan separados, y un tanque
    // parado entre dos cabezas las recibe a las dos.
    split: { heads: 5, radius: 7 },
  },
  leapfrog: {
    id: "leapfrog",
    name: "Leap Frog",
    armsLevel: 8,
    cost: 1600,
    bundleSize: 2,
    startingNumber: 0,
    // Explota como un Missile, una sola vez: donde termina el segundo tramo.
    explosionRadius: 6,
    craterRadius: 6,
    hurtAmount: 1,
    windFactor: 1,
    gravityFactor: 1,
    // Sale como un Misil: hasta el pique. Con el segundo tramo termina más lejos.
    reach: 230,
    // Sale del pique con la mitad de la velocidad: en piso llano el segundo tramo mide un cuarto
    // del primero.
    bounce: { keep: 0.5 },
  },
});

/**
 * Armas que se pueden disparar: la Baby Missile (infinita, no se compra), y el Missile, el Roller,
 * el Napalm, el Nuke, la Dirt Ball, el MIRV y el Leap Frog (se compran en la tienda, ver
 * campaign.ts). La Baby Nuke existe solo como datos.
 */
export const PLAYABLE_WEAPONS: readonly WeaponId[] = Object.freeze(["babyMissile", "missile", "roller", "napalm", "nuke", "dirt", "mirv", "leapfrog"]);

export function isPlayable(id: WeaponId): boolean {
  return PLAYABLE_WEAPONS.includes(id);
}

/**
 * Alcance en piso llano de un tiro a 45° que sale con potencia POWER_MAX sin recortar: lo que
 * llegaban todas las armas antes de que cada una tuviera el suyo. Sale de las constantes del tiro
 * (shot3d.ts): alcance = v² · VELOCITY_TO_POSITION · FORCE_DIVISOR / |GRAVITY|. [celdas = wu]
 */
export const FULL_REACH = ((POWER_TO_VELOCITY * (POWER_MAX + 1)) ** 2 * VELOCITY_TO_POSITION * FORCE_DIVISOR) / -GRAVITY;

/**
 * La cuenta del alcance, una sola para todos: con qué potencia sale del cañón un tiro apuntado con
 * `power`. La potencia que elige el jugador (0..POWER_MAX) se achica lo justo para que, al máximo,
 * el arma llegue a `weapon.reach` y no más: el alcance crece con el cuadrado de la velocidad, así
 * que el factor es la raíz. Un arma más pesada (gravityFactor) necesita salir más fuerte para llegar
 * igual. La usan simulateWeaponShot3D (el server, la fantasma del cliente y el bot) y el perfil (turn.ts).
 */
export function launchPower(weapon: Weapon, power: number): number {
  const aimed = Math.min(POWER_MAX, Math.max(0, power));
  return aimed * Math.sqrt((weapon.reach * weapon.gravityFactor) / FULL_REACH);
}
