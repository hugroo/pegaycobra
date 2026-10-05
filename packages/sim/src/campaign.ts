// SPDX-License-Identifier: GPL-2.0-or-later
// La partida completa: rondas, plata de fin de ronda, tienda, nafta y puntaje.
// Números del original, Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/common/OptionsGame.cpp           NumberOfRounds, MaxNumberOfRoundTurns, PlayerLives,
//                                                MoneyBuyOnRound, MoneyWonForRound, MoneyWonForLives,
//                                                MoneyInterest, ScorePerKill, ScorePerMoney (= 0)
//   src/common/simactions/ShowScoreSimAction.cpp premio a los que siguen vivos y después interés
//   src/common/target/TargetDamage.cpp           kill propio: kills - 1 y score - ScorePerKill
//   data/globalmods/none/data/accessories.xml    precios de Missile, Parachute y Fuel
//
// Reglas propias (pedidas para este juego, no del original):
//   - El puntaje es solo daño hecho a otros + kills. La plata no suma puntos (como ScorePerMoney = 0),
//     pero tampoco cuenta ScoreWonForRound: sobrevivir paga plata, no puntos.
//   - El Missile se vende de a 3 (el original lo vende de a 5).
//   - El paracaídas protege durante toda la ronda siguiente (el original gasta uno por caída).
//   - La nafta mueve el tanque antes de tirar (en el original mover reemplaza al tiro).
//   - El Roller (roller.ts) y el Escudo: precios y efecto propios. El escudo absorbe el próximo
//     tiro cuya explosión le iba a sacar vida al tanque y se gasta (turn3d.ts); no tapa la caída
//     cuando le sacan el piso sin alcanzarlo.
//   - El Napalm (napalm.ts): precio y efecto propios. Deja fuego hasta que termina la ronda; el
//     escudo no lo apaga.
//   - El Nuke se vende de a 1 (el original, de a 2) y el escudo no lo frena (turn3d.ts).
//   - La Dirt Ball se vende de a 1 (el original, de a 5) y no entierra: el tanque sube con la loma (turn3d.ts).
//   - El MIRV (mirv.ts) se vende de a 1 (el original, de a 3), con precio propio: las cabezas son más
//     chicas que las del original. El escudo absorbe una sola cabeza (turn3d.ts).
//   - El Leap Frog (bounce.ts): precio y efecto propios. Pica una vez y explota en el segundo golpe.
//   - En la tienda se vende lo que no usaste a la mitad del precio (sellItem). En el original también
//     se vende (<sellprice> de accessories.xml); acá la mitad es fija y el escudo no se vende.
//   - La plata está ajustada para este juego (constants.ts): se arranca con menos, pegar y sobrevivir
//     pagan menos y todos cobran un fijo por ronda. En el original sobra para comprar todo.

import { INTEREST_RATE, MONEY_PER_ROUND, MONEY_WON_FOR_ROUND, TANK_MAX_LIFE } from "./constants";
import { isAlive } from "./damage";
import { clampMoney, type Inventory } from "./economy";
import { DEFAULT_MAP, MAPS, type MapId } from "./maps";
import { generateTerrain, isWater, terrainHeightAt, type Terrain } from "./terrain";
import { createRng } from "./rng";
import { WEAPONS } from "./weapons";
import type { DamageEvent, Player } from "./turn";
import { placeTanks3D, rollWind3D, tanks3DAt, type MatchState3D } from "./turn3d";

// ---------------------------------------------------------------------------
// Rondas
// ---------------------------------------------------------------------------

/** OptionsGame "NumberOfRounds" default 5. [rondas] */
export const ROUNDS_PER_MATCH = 5;
/** OptionsGame "MaxNumberOfRoundTurns" default 15: tiros por jugador antes de cortar la ronda. */
export const ROUND_MAX_TURNS = 15;
/** OptionsGame "MoneyBuyOnRound" default 2: la tienda abre antes de la ronda 2. */
export const FIRST_SHOP_ROUND = 2;
/** OptionsGame "PlayerLives" default 1. */
export const PLAYER_LIVES = 1;
/** OptionsGame "MoneyWonForLives", por cada vida que le queda al que sobrevive. El original da 5000. [$] */
export const MONEY_WON_FOR_LIVES = 1000;
/** Lo que cobra cada tanque vivo al terminar la ronda: MoneyWonForRound + MoneyWonForLives × vidas. [$] */
export const SURVIVOR_BONUS = MONEY_WON_FOR_ROUND + MONEY_WON_FOR_LIVES * PLAYER_LIVES;

/**
 * Arma la primera ronda de una partida sobre un terreno nuevo: el del mapa elegido (maps.ts; se
 * genera ese y ningún otro), viento sorteado (después se corre turno a turno, driftWind3D), tanques
 * con vida llena sobre el anillo del mapa. La plata y el inventario de cada jugador pasan tal cual.
 * Los que ya no están (`gone`) arrancan muertos.
 */
export function startRound3D(
  seed: number,
  players: readonly Player[],
  gone: ReadonlySet<string> = new Set(),
  map: MapId = DEFAULT_MAP,
): MatchState3D {
  return roundOn(generateTerrain(seed, MAPS[map].terrain), seed, players, gone, map);
}

/**
 * La ronda siguiente de la misma partida. Regla propia (el original genera un paisaje por ronda): se
 * juega sobre el piso como lo dejó `prev`, el mismo heightmap, con sus hoyos, sus lomas y el agua que
 * abrió algún cráter. Lo demás es como en startRound3D: viento sorteado de nuevo, vida llena, plata e
 * inventario tal cual, y tanques reubicados sobre el anillo. `pristine` es el terreno de la ronda 1,
 * sin tocar: con él se sabe qué es hoyo, y nadie nace en uno ni en el agua (placeTanks3D). El fuego
 * de la ronda anterior no pasa: el estado nuevo no tiene `fires`.
 * Con `spots` (uno por jugador, en el orden de `prev.players`) cada tanque nace ahí y no donde lo dejó
 * el sorteo: es lo que quedó de la tienda, el sorteo (nextRoundSpots) con lo que cada uno eligió
 * encima (validateSpawn). El viento es el mismo con o sin `spots`.
 */
export function nextRound3D(
  seed: number,
  prev: MatchState3D,
  pristine: Terrain,
  gone: ReadonlySet<string> = new Set(),
  map: MapId = DEFAULT_MAP,
  spots?: readonly { x: number; z: number }[],
): MatchState3D {
  return roundOn(prev.terrain, seed, prev.players, gone, map, pristine, spots);
}

/**
 * Dónde deja el sorteo a cada uno de los `count` tanques en la ronda siguiente, sobre `terrain` (el
 * piso como quedó): los mismos puntos que usa nextRound3D sin `spots`. Sirve para mostrarlos en la
 * tienda, antes de que la ronda empiece.
 */
export function nextRoundSpots(
  seed: number,
  terrain: Terrain,
  count: number,
  pristine: Terrain,
  map: MapId = DEFAULT_MAP,
): { x: number; z: number }[] {
  return drawRound(terrain, seed, count, map, pristine).spots;
}

/** El sorteo de una ronda: el viento y, después, dónde cae cada tanque. En ese orden salen del rng. */
function drawRound(terrain: Terrain, seed: number, count: number, map: MapId, pristine?: Terrain) {
  const rng = createRng(seed ^ 0x2545f491);
  // En float32, como viaja por la red: el server tira con el mismo número que ve el cliente.
  const rolled = rollWind3D(rng);
  const wind = { x: Math.fround(rolled.x), z: Math.fround(rolled.z) };
  return { wind, spots: placeTanks3D(terrain, count, rng, MAPS[map].startRing, pristine) };
}

function roundOn(
  terrain: Terrain,
  seed: number,
  players: readonly Player[],
  gone: ReadonlySet<string>,
  map: MapId,
  pristine?: Terrain,
  spots?: readonly { x: number; z: number }[],
): MatchState3D {
  const ids = players.map((p) => p.id);
  const draw = drawRound(terrain, seed, ids.length, map, pristine);
  const tanks = tanks3DAt(terrain, ids, spots ?? draw.spots, TANK_MAX_LIFE).map((t) => (gone.has(t.id) ? { ...t, life: 0 } : t));
  return { terrain, wind: draw.wind, tanks, players: players.slice() };
}

/** La ronda termina cuando queda uno vivo (o ninguno). */
export function roundOver(state: MatchState3D): boolean {
  return state.tanks.filter(isAlive).length <= 1;
}

export interface RoundPayout {
  id: string;
  /** Plata al terminar la ronda, antes de premios. [$] */
  before: number;
  /** SURVIVOR_BONUS si seguía vivo, 0 si no. [$] */
  survivor: number;
  /** trunc((before + survivor) · 15%) + MoneyPerRound. [$] */
  interest: number;
  after: number;
}

/**
 * Plata de fin de ronda, en el orden de ShowScoreSimAction: primero el premio a los que siguen
 * vivos, después el interés sobre lo que cada uno tiene. Lo gastado en la tienda ya no está en
 * `money`, así que no gana interés. Además vence el paracaídas (dura una ronda). El escudo no
 * vence: si nadie te pegó, lo seguís teniendo.
 */
export function endRoundPayouts(players: readonly Player[], survivors: ReadonlySet<string>): { players: Player[]; payouts: RoundPayout[] } {
  const payouts: RoundPayout[] = [];
  const out = players.map((p) => {
    const before = p.money;
    const survivor = survivors.has(p.id) ? SURVIVOR_BONUS : 0;
    const withBonus = clampMoney(before + survivor);
    const interest = Math.trunc(withBonus * INTEREST_RATE) + MONEY_PER_ROUND;
    const after = clampMoney(withBonus + interest);
    payouts.push({ id: p.id, before, survivor, interest: after - withBonus, after });
    const inventory: Inventory = { ...p.inventory, parachute: 0 };
    return { ...p, money: after, inventory };
  });
  return { players: out, payouts };
}

// ---------------------------------------------------------------------------
// Tienda
// ---------------------------------------------------------------------------

export type ShopItemId = "missile" | "roller" | "napalm" | "nuke" | "dirt" | "mirv" | "leapfrog" | "shield" | "parachute" | "fuel";

export interface ShopItem {
  id: ShopItemId;
  name: string;
  /** Precio del pack. [$] */
  price: number;
  /** Unidades que da cada compra. */
  pack: number;
  description: string;
}

/** Alcance de una carga de nafta, en el piso (XZ). [celdas = wu] */
export const FUEL_MOVE_RANGE = 20;
/** No se puede estacionar a menos de esto de otro tanque. [wu] */
export const FUEL_MIN_GAP = 4;

/**
 * La carta del Paracaídas, en una línea (la tienda la muestra tal cual). No promete más de lo que
 * hace: tapa la caída al cráter, no el agua (turn3d.ts: el que queda en el lago muere igual).
 */
export const PARACHUTE_LINE = "Caer al cráter no duele; el agua sí";

export const SHOP_ITEMS: Readonly<Record<ShopItemId, ShopItem>> = Object.freeze({
  missile: {
    id: "missile",
    name: "Misil",
    // accessories.xml: <cost>2000</cost> por <bundlesize>5</bundlesize> → 400 c/u; pack de 3.
    price: 1200,
    pack: 3,
    description: "El tiro largo: llega más lejos que la Chispa, y explota con radio 6 (la Chispa es 3.5). Se gasta uno por tiro.",
  },
  roller: {
    id: "roller",
    name: "Rodillo",
    price: WEAPONS.roller.cost,
    pack: WEAPONS.roller.bundleSize,
    description: `Toca el piso y rueda cuesta abajo hasta ${WEAPONS.roller.roll!.maxCells} celdas o hasta un tanque. Cráter chico.`,
  },
  napalm: {
    id: "napalm",
    name: "Quema",
    price: WEAPONS.napalm.cost,
    pack: WEAPONS.napalm.bundleSize,
    description:
      `No explota ni abre cráter: deja fuego en un disco de radio ${WEAPONS.napalm.burn!.radius} el resto de la ronda. ` +
      `El tanque que empieza su turno ahí pierde ${WEAPONS.napalm.burn!.damagePerTurn} de vida. El escudo no lo apaga.`,
  },
  nuke: {
    id: "nuke",
    name: "Bombazo",
    // accessories.xml: <cost>12000</cost> por <bundlesize>2</bundlesize> → 6000 c/u; se vende de a 1.
    price: WEAPONS.nuke.cost / WEAPONS.nuke.bundleSize,
    pack: 1,
    description:
      `Un Misil enorme: explosión y cráter de radio ${WEAPONS.nuke.explosionRadius} (el Misil es ${WEAPONS.missile.explosionRadius}). ` +
      "Pesa: llega a menos de la mitad que un Misil, así que hay que tener al otro cerca. " +
      "El escudo no lo frena ni se gasta.",
  },
  dirt: {
    id: "dirt",
    name: "Tierra",
    // accessories.xml Dirt Ball: <cost>5750</cost> por <bundlesize>5</bundlesize> → 1150 c/u; se vende de a 1.
    price: WEAPONS.dirt.cost / WEAPONS.dirt.bundleSize,
    pack: 1,
    description:
      `Cae como un Misil, pero suma tierra: levanta una loma de radio ${WEAPONS.dirt.mound!.radius}. No saca vida y el escudo no la frena. ` +
      "El tanque que queda debajo sube con ella.",
  },
  mirv: {
    id: "mirv",
    name: "Racimo",
    price: WEAPONS.mirv.cost,
    pack: WEAPONS.mirv.bundleSize,
    description:
      `Sale como un Misil y, en la cima, se abre en ${WEAPONS.mirv.split!.heads}: cada cabeza cae cerca y explota por su cuenta ` +
      `(radio ${WEAPONS.mirv.explosionRadius}, cráter chico). El escudo frena una sola.`,
  },
  leapfrog: {
    id: "leapfrog",
    name: "Rebote",
    price: WEAPONS.leapfrog.cost,
    pack: WEAPONS.leapfrog.bundleSize,
    description:
      "Sale como un Misil, pica en el piso y sigue una vez, con menos fuerza. Explota en el segundo golpe " +
      `(radio ${WEAPONS.leapfrog.explosionRadius}). Si el pique da en un tanque, explota ahí.`,
  },
  shield: {
    id: "shield",
    name: "Escudo",
    price: 2000,
    pack: 1,
    description:
      "Absorbe el próximo tiro que te alcance (explosión o Rodillo) y se gasta. Si te sacan el piso, caés igual. Al Bombazo no lo frena, y del Racimo frena una sola cabeza.",
  },
  parachute: {
    id: "parachute",
    name: "Paracaídas",
    // accessories.xml: <cost>10000</cost> por <bundlesize>8</bundlesize> → 1250 c/u.
    price: 1250,
    pack: 1,
    description: `${PARACHUTE_LINE}: si el hoyo llega al lago, te morís igual. Dura la ronda que viene.`,
  },
  fuel: {
    id: "fuel",
    name: "Nafta",
    // accessories.xml Fuel: <cost>6000</cost> por <bundlesize>40</bundlesize> → 150 por celda;
    // una carga = FUEL_MOVE_RANGE celdas.
    price: 150 * FUEL_MOVE_RANGE,
    pack: 1,
    description: `Antes de tirar, mové el tanque hasta ${FUEL_MOVE_RANGE} celdas.`,
  },
});

/** Por qué no se puede comprar, o null si se puede. */
export function cannotBuy(player: Player, item: ShopItemId): string | null {
  const it = SHOP_ITEMS[item];
  if (!it) return "ese ítem no existe";
  if (player.money < it.price) return "no alcanza la plata";
  if (item === "parachute" && (player.inventory.parachute ?? 0) > 0) return "ya tenés paracaídas para la ronda";
  if (item === "shield" && (player.inventory.shield ?? 0) > 0) return "ya tenés un escudo";
  return null;
}

/** Compra un pack. Tira error si no alcanza la plata (no se puede comprar de más). */
export function buyItem(player: Player, item: ShopItemId): Player {
  const why = cannotBuy(player, item);
  if (why) throw new Error(why);
  const it = SHOP_ITEMS[item];
  const have = player.inventory[item] ?? 0;
  return { ...player, money: clampMoney(player.money - it.price), inventory: { ...player.inventory, [item]: have + it.pack } };
}

/** Lo que devuelve la tienda al vender: la mitad de lo que costó. Regla propia. [fracción] */
export const SELL_FRACTION = 1 / 2;

/** Unidades que se van en una venta: un pack, o lo que quede de él si ya tiraste alguno. */
export function sellUnits(player: Player, item: ShopItemId): number {
  const it = SHOP_ITEMS[item];
  return it ? Math.min(it.pack, Math.max(0, player.inventory[item] ?? 0)) : 0;
}

/** Plata que vuelve por esa venta: la mitad del precio de cada unidad. Lo que ya tiraste no vuelve. [$] */
export function sellValue(player: Player, item: ShopItemId): number {
  const it = SHOP_ITEMS[item];
  return it ? Math.trunc((it.price / it.pack) * sellUnits(player, item) * SELL_FRACTION) : 0;
}

/**
 * Por qué no se puede vender, o null si se puede. La Chispa no está en la tienda, así que no llega
 * acá. El escudo queda puesto en el tanque desde que se compra: no se vende.
 */
export function cannotSell(player: Player, item: ShopItemId): string | null {
  if (!SHOP_ITEMS[item]) return "ese ítem no existe";
  if (item === "shield") return "el escudo ya está puesto";
  if (sellUnits(player, item) <= 0) return "no tenés ninguno";
  return null;
}

/** Vende un pack (o lo que quede de él) a la mitad. Tira error si no hay nada para vender. */
export function sellItem(player: Player, item: ShopItemId): Player {
  const why = cannotSell(player, item);
  if (why) throw new Error(why);
  const have = player.inventory[item] ?? 0;
  return {
    ...player,
    money: clampMoney(player.money + sellValue(player, item)),
    inventory: { ...player.inventory, [item]: have - sellUnits(player, item) },
  };
}

// ---------------------------------------------------------------------------
// Nafta: mover el tanque antes de tirar
// ---------------------------------------------------------------------------

export type MoveCheck = { ok: true; x: number; y: number; z: number } | { ok: false; reason: string };

/**
 * Valida un destino de nafta. Lo usan el server (autoridad) y el cliente (para no mandar
 * movimientos que el server va a rechazar):
 *   tener nafta, tanque vivo, destino dentro del mapa, a ≤ FUEL_MOVE_RANGE en XZ, y a ≥ FUEL_MIN_GAP
 *   de cualquier otro tanque vivo, y sobre piso firme: al agua no se entra. El tanque queda apoyado
 *   en el suelo del destino.
 * No hay chequeo de pendiente (el original limita con MaxClimbingDistance por casillero).
 */
export function validateMove(state: MatchState3D, playerId: string, to: { x: number; z: number }): MoveCheck {
  const player = state.players.find((p) => p.id === playerId);
  const tank = state.tanks.find((t) => t.id === playerId);
  if (!player || !tank) return { ok: false, reason: "jugador desconocido" };
  if (!isAlive(tank)) return { ok: false, reason: "tanque muerto" };
  if ((player.inventory.fuel ?? 0) <= 0) return { ok: false, reason: "sin nafta" };
  if (!Number.isFinite(to.x) || !Number.isFinite(to.z)) return { ok: false, reason: "destino inválido" };
  const { width, depth } = state.terrain;
  if (to.x < 1 || to.z < 1 || to.x > width - 2 || to.z > depth - 2) return { ok: false, reason: "fuera del mapa" };
  if (isWater(state.terrain, to.x, to.z)) return { ok: false, reason: "ahí hay agua" };
  if (Math.hypot(to.x - tank.x, to.z - tank.z) > FUEL_MOVE_RANGE) return { ok: false, reason: `más lejos de ${FUEL_MOVE_RANGE}` };
  for (const other of state.tanks) {
    if (other.id === playerId || !isAlive(other)) continue;
    if (Math.hypot(to.x - other.x, to.z - other.z) < FUEL_MIN_GAP) return { ok: false, reason: "pegado a otro tanque" };
  }
  return { ok: true, x: to.x, y: terrainHeightAt(state.terrain, to.x, to.z), z: to.z };
}

/** Mueve el tanque (gasta una carga de nafta). Tira error si el destino no es válido. */
export function moveTank(state: MatchState3D, playerId: string, to: { x: number; z: number }): MatchState3D {
  const check = validateMove(state, playerId, to);
  if (!check.ok) throw new Error(check.reason);
  const tanks = state.tanks.map((t) => (t.id === playerId ? { ...t, x: check.x, y: check.y, z: check.z } : t));
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, inventory: { ...p.inventory, fuel: (p.inventory.fuel ?? 0) - 1 } } : p,
  );
  return { ...state, tanks, players };
}

// ---------------------------------------------------------------------------
// Puntaje
// ---------------------------------------------------------------------------

/** Puntos por cada punto de vida que le sacás a otro. Regla propia (el puntaje es daño + kills). */
export const SCORE_PER_DAMAGE = 1;
/** OptionsGame "ScorePerKill" default 10. */
export const SCORE_PER_KILL = 10;

export interface Score {
  points: number;
  kills: number;
  /** Daño hecho a otros. [hp] */
  damage: number;
}

export type Scoreboard = Readonly<Record<string, Score>>;

export function emptyScoreboard(ids: readonly string[]): Scoreboard {
  return Object.fromEntries(ids.map((id) => [id, { points: 0, kills: 0, damage: 0 }]));
}

/**
 * Suma los eventos de daño de un tiro al que disparó. Daño a otros: SCORE_PER_DAMAGE por hp
 * (redondeado). Kill a otro: +SCORE_PER_KILL. Matarse a uno mismo: kills - 1 y -SCORE_PER_KILL
 * (TargetDamage.cpp). El daño propio no suma ni resta.
 */
export function scoreTurn(board: Scoreboard, shooterId: string, events: readonly DamageEvent[]): Scoreboard {
  const prev = board[shooterId] ?? { points: 0, kills: 0, damage: 0 };
  const next = { ...prev };
  for (const e of events) {
    if (e.targetId === shooterId) {
      if (e.killed) {
        next.kills -= 1;
        next.points -= SCORE_PER_KILL;
      }
      continue;
    }
    const hp = Math.round(e.damage);
    next.damage += hp;
    next.points += hp * SCORE_PER_DAMAGE;
    if (e.killed) {
      next.kills += 1;
      next.points += SCORE_PER_KILL;
    }
  }
  return { ...board, [shooterId]: next };
}

export interface Standing extends Score {
  id: string;
  /** 1 = primero. Empatados comparten puesto. */
  rank: number;
}

/** Tabla final: más puntos primero; desempata kills y después daño. */
export function standings(board: Scoreboard, ids: readonly string[]): Standing[] {
  const rows = ids.map((id) => ({ id, ...(board[id] ?? { points: 0, kills: 0, damage: 0 }) }));
  rows.sort((a, b) => b.points - a.points || b.kills - a.kills || b.damage - a.damage);
  let rank = 0;
  return rows.map((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.points !== r.points || prev.kills !== r.kills || prev.damage !== r.damage) rank = i + 1;
    return { ...r, rank };
  });
}

/** Ganadores por puntos (varios si empatan en todo). */
export function matchWinners(board: Scoreboard, ids: readonly string[]): string[] {
  return standings(board, ids)
    .filter((s) => s.rank === 1)
    .map((s) => s.id);
}
