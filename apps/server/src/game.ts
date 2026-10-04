// SPDX-License-Identifier: GPL-2.0-or-later
// Lógica de la partida, sin Colyseus: lobby, rondas, turnos, tienda, reloj, salidas y ganador.
// Las reglas (tiro, cráter, fuego, daño, plata, tienda, nafta, puntaje) son de @pegaycobra/sim;
// acá solo se ordena el tiempo: quién juega, cuándo termina la ronda y cuándo abre la tienda.

import {
  burnTurn3D,
  buyItem,
  cannotBuy,
  cannotSell,
  createRng,
  DEFAULT_MAP,
  driftWind3D,
  emptyScoreboard,
  endRoundPayouts,
  matchWinners,
  MONEY_START,
  moveTank,
  parseMap,
  resolveTurn,
  ROUND_MAX_TURNS,
  ROUNDS_PER_MATCH,
  roundOver,
  scoreTurn,
  sellItem,
  SHOP_ITEMS,
  startingInventory,
  startRound3D,
  STEP_SECONDS,
  validateMove,
  type BurnEvent,
  type MapId,
  type MatchState3D,
  type Player,
  type RoundPayout,
  type Scoreboard,
  type ShopItemId,
  type Shot3DResult,
  type TurnResult3D,
  type WeaponId,
} from "@pegaycobra/sim";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const TURN_SECONDS = 20;
export const SHOP_SECONDS = 30;
/**
 * Lo que el anfitrión puede escribir en la espera: segundos de turno, segundos de tienda y rondas.
 * [mínimo, máximo], los dos incluidos.
 */
export const CLOCK_LIMITS = { turn: [10, 60], shop: [10, 90], rounds: [1, 9] } as const;

/** Un entero dentro del rango, o `fallback`: vacío, texto, con coma o afuera no rompen nada. */
function inRange(raw: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

/** Pasos de la espera: tanque, mapa y reloj. */
export const LOBBY_STEPS = 3;

/** El cliente reproduce el tiro 1.5× más rápido que el tiempo real del original. */
export const PLAYBACK_SPEED = 1.5;
/** Tope de la animación, por si un tiro dura muchísimo (p. ej. "timeout"). [ms] */
export const MAX_SHOT_MS = 8000;
export const NAME_MAX = 16;

/** Siluetas del tanque: solo cambian cómo se dibuja (caja, chato o torre). El tiro y el daño son los mismos. */
export const HULLS = ["box", "flat", "tower"] as const;
export type Hull = (typeof HULLS)[number];
export const DEFAULT_HULL: Hull = "box";

/** Lo que mandó el cliente → una silueta conocida, o null. */
export function parseHull(raw: unknown): Hull | null {
  return typeof raw === "string" && (HULLS as readonly string[]).includes(raw) ? (raw as Hull) : null;
}

/**
 * Colores de tanque que se pueden elegir (índices 0..COLOR_COUNT-1; la paleta la tiene el cliente).
 * Son más que asientos: siempre queda uno libre para el que eligió uno ya tomado.
 */
export const COLOR_COUNT = 8;

/** Lo que mandó el cliente → un color conocido, o null. */
export function parseColor(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < COLOR_COUNT ? raw : null;
}

export type Phase = "lobby" | "aiming" | "animating" | "shop" | "ended";

export interface Seat {
  id: string;
  name: string;
  /** 0..3: el lugar en la sala. Su color es el de quien no eligió (y el del bot). */
  slot: number;
  /** Color del tanque, 0..COLOR_COUNT-1: el elegido, o uno libre si ya estaba tomado. Nunca hay dos iguales en la sala. */
  color: number;
  /** Silueta del tanque. Se queda con el asiento, también en la revancha. */
  hull: Hull;
  connected: boolean;
}

/** Armas que el cliente puede pedir. La Baby Nuke no existe para el juego. */
const FIREABLE: readonly WeaponId[] = ["babyMissile", "missile", "roller", "napalm", "nuke", "dirt", "mirv", "leapfrog"];

export interface FireMessage {
  yaw: number;
  pitch: number;
  power: number;
  weapon: WeaponId;
}

/**
 * Del mensaje del cliente se leen solo yaw, pitch, power y weapon; cualquier otro campo (daño,
 * impacto, posición...) se ignora y no llega al sim. weapon puede faltar (= Baby Missile); si
 * nombra algo que no sea "babyMissile", "missile", "roller", "napalm", "nuke", "dirt", "mirv" o "leapfrog", el mensaje entero se descarta.
 */
export function parseFireMessage(raw: unknown): FireMessage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  let weapon: WeaponId = "babyMissile";
  for (const key of ["weapon", "weaponId"]) {
    if (!(key in msg)) continue;
    const w = msg[key];
    if (typeof w !== "string" || !FIREABLE.includes(w as WeaponId)) return null;
    weapon = w as WeaponId;
  }
  const { yaw, pitch, power } = msg;
  if (typeof yaw !== "number" || typeof pitch !== "number" || typeof power !== "number") return null;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(power)) return null;
  return { yaw, pitch, power, weapon }; // el sim normaliza yaw y recorta pitch [0, 90] y power [0, 1000]
}

/** { moveTo: { x, z } } → destino, o null. Si trae otra cosa, se ignora. */
export function parseMoveMessage(raw: unknown): { x: number; z: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const to = (raw as Record<string, unknown>).moveTo;
  if (typeof to !== "object" || to === null) return null;
  const { x, z } = to as Record<string, unknown>;
  if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

export function parseBuyMessage(raw: unknown): ShopItemId | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = (raw as Record<string, unknown>).item;
  return typeof item === "string" && item in SHOP_ITEMS ? (item as ShopItemId) : null;
}

export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const name = raw.replace(/[\u0000-\u001f]/g, "").trim().slice(0, NAME_MAX);
  return name || fallback;
}

/** Duración de la animación de un tiro de `ticks` pasos. [ms] */
export function shotDurationMs(ticks: number): number {
  return Math.min(MAX_SHOT_MS, Math.round((ticks * STEP_SECONDS * 1000) / PLAYBACK_SPEED));
}

export interface ShotEvent {
  result: TurnResult3D;
  shooterId: string;
  yaw: number;
  pitch: number;
  power: number;
  weapon: WeaponId;
  durationMs: number;
}

/**
 * Marca del último tiro de un tanque: lo que queda a la vista cuando cayó, para corregir el siguiente.
 * La arma el server y viaja en el estado, así todas las pestañas ven la misma.
 */
export interface ShotMark {
  /** Recorrido [x, y, z, ...], raleado. Con un Racimo llega hasta donde se abrió: una línea, no una por cabeza. [wu] */
  path: number[];
  /**
   * Dónde cayó: un trío [x, z, agua] por golpe (uno, o uno por cabeza de un Racimo). agua = 1: se
   * hundió en el lago; la marca queda ahí, sobre el agua, sin hoyo. Lo que se fue del mapa no deja punto.
   */
  spots: number[];
}

/** Tramos de la línea de una marca: alcanzan para que se lea la curva. */
const MARK_SEGMENTS = 40;

export function shotMark(shot: Shot3DResult): ShotMark {
  const src = shot.path ?? [];
  const n = src.length / 3;
  const step = Math.max(1, Math.ceil((n - 1) / MARK_SEGMENTS));
  const path: number[] = [];
  for (let i = 0; i < n; i++) {
    // El pique de un Rebote es una esquina del recorrido: no se saltea.
    if (i % step === 0 || i === n - 1 || i === shot.bounce?.tick) path.push(src[i * 3]!, src[i * 3 + 1]!, src[i * 3 + 2]!);
  }
  const spots: number[] = [];
  for (const hit of shot.split?.heads ?? [shot]) {
    if (hit.outcome === "offmap" || hit.outcome === "timeout") continue;
    spots.push(hit.x, hit.z, hit.outcome === "water" ? 1 : 0);
  }
  return { path, spots };
}

/** La vida de todos los tanques, sumada. [hp] */
const totalLife = (m: MatchState3D): number => m.tanks.reduce((sum, t) => sum + Math.max(0, t.life), 0);

export interface Aim {
  yaw: number;
  pitch: number;
}

export interface RoundSummary {
  round: number;
  survivors: string[];
  payouts: RoundPayout[];
}

export class Game {
  phase: Phase = "lobby";
  seats: Seat[] = [];
  hostId: string | null = null;
  /** El mapa de la partida. Lo elige el anfitrión en la espera; al arrancar queda fijo, también para la revancha. */
  map: MapId = DEFAULT_MAP;
  /** Paso de la espera en el que está el anfitrión: 1 tanque, 2 mapa, 3 reloj. Los demás ven ese. */
  lobbyStep = 1;
  match: MatchState3D | null = null;
  turnId: string | null = null;
  /** Segundos que le quedan al turno o a la tienda. */
  timeLeft = 0;
  /** Ronda en curso (1..rounds). 0 = no empezó. */
  round = 0;
  rounds = ROUNDS_PER_MATCH;
  /** Lo que dura un turno y lo que dura la tienda. Como `rounds`, los escribe el anfitrión en la espera (setClock). [s] */
  turnSeconds: number;
  shopSeconds: number;
  board: Scoreboard = {};
  /** Con phase "ended": ganadores por puntos (varios si empatan en todo). */
  winners: string[] = [];
  /** Con phase "ended": el ganador si es uno solo, null si fue empate. */
  winnerId: string | null = null;
  endReason: "rounds" | "forfeit" | null = null;
  /** Resumen de la última ronda terminada (lo que cobró cada uno). */
  lastRound: RoundSummary | null = null;
  /** Sube cada vez que empieza una ronda (el server manda el terreno nuevo). */
  roundSerial = 0;
  /** Jugadores que tocaron "listo" en la tienda. */
  readonly ready = new Set<string>();
  /** El del turno ya usó nafta en este turno. */
  movedThisTurn = false;
  /** El del turno ya dio el paso gratis en este turno. */
  private steppedThisTurn = false;
  /** Último yaw/pitch que usó cada jugador (solo para dibujar el cañón). */
  readonly aims = new Map<string, Aim>();
  /** Marca del último tiro de cada tanque en la ronda: aparece cuando cae y dura hasta que ese jugador tira de nuevo. */
  readonly marks = new Map<string, ShotMark>();
  private readonly turnsTaken = new Map<string, number>();
  private pending: { result: TurnResult3D; shooterId: string } | null = null;
  /** Lo que quemó el fuego desde la última vez que la sala lo leyó (takeBurns). */
  private burned: BurnEvent[] = [];
  /** Los que ya jugaron en la vuelta en curso. Una vuelta se cierra cuando jugaron todos los vivos. */
  private readonly lapPlayed = new Set<string>();
  /** Vida de todos los tanques, sumada, al empezar la vuelta: si al cerrarla es la misma, nadie perdió vida. [hp] */
  private lapLife = 0;
  /** Los que tienen sin gastar la Nafta de una vuelta sin daño: mientras la tengan no reciben otra, y no pasa a la tienda. */
  private readonly giftFuel = new Set<string>();
  /** Los que recibieron esa Nafta desde la última vez que la sala lo leyó (takeRefuel). */
  private refueled: string[] = [];
  private baseSeed = 0;
  /** De acá sale cuánto se corre el viento en cada turno. Se rearma con la semilla de cada ronda. */
  private windRng: () => number = Math.random;

  /** Los relojes con los que nace la sala: son también los que quedan si el anfitrión escribe uno inválido. */
  constructor(
    private readonly defaultTurnSeconds = TURN_SECONDS,
    private readonly defaultShopSeconds = SHOP_SECONDS,
  ) {
    this.turnSeconds = defaultTurnSeconds;
    this.shopSeconds = defaultShopSeconds;
  }

  get connectedSeats(): Seat[] {
    return this.seats.filter((s) => s.connected);
  }

  playerOf(id: string): Player | undefined {
    return this.match?.players.find((p) => p.id === id);
  }

  addPlayer(id: string, rawName: unknown, rawHull?: unknown, rawColor?: unknown): Seat {
    if (this.phase !== "lobby" && this.phase !== "ended") throw new Error("la partida ya empezó");
    // Con la partida terminada, el que se fue no vuelve: si hace falta el lugar, se libera.
    if (this.phase === "ended" && this.seats.length >= MAX_PLAYERS) this.seats = this.connectedSeats;
    if (this.seats.length >= MAX_PLAYERS) throw new Error("la sala está llena");
    const used = new Set(this.seats.map((s) => s.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const seat: Seat = { id, name: sanitizeName(rawName, `Jugador ${slot + 1}`), slot, color: this.freeColor(parseColor(rawColor) ?? slot), hull: parseHull(rawHull) ?? DEFAULT_HULL, connected: true };
    this.seats.push(seat);
    this.hostId ??= id;
    return seat;
  }

  /** El color pedido si nadie lo tiene; si no, el primero libre. */
  private freeColor(wanted: number): number {
    const used = new Set(this.seats.map((s) => s.color));
    if (!used.has(wanted)) return wanted;
    let color = 0;
    while (used.has(color)) color++;
    return color;
  }

  /** Cambia de color mientras se espera. Uno que ya tiene otro no se puede: se queda con el suyo. */
  setColor(id: string, raw: unknown): boolean {
    const seat = this.seats.find((s) => s.id === id);
    const color = parseColor(raw);
    if (!seat || color === null || (this.phase !== "lobby" && this.phase !== "ended")) return false;
    if (this.seats.some((s) => s.color === color)) return false;
    seat.color = color;
    return true;
  }

  /** Cambia de silueta mientras se espera (antes de arrancar o con la partida terminada). */
  setHull(id: string, raw: unknown): boolean {
    const seat = this.seats.find((s) => s.id === id);
    const hull = parseHull(raw);
    if (!seat || !hull || (this.phase !== "lobby" && this.phase !== "ended") || seat.hull === hull) return false;
    seat.hull = hull;
    return true;
  }

  /** El anfitrión elige el mapa antes de arrancar. De otro, o con la partida ya arrancada, se ignora. */
  setMap(byId: string, raw: unknown): boolean {
    const map = parseMap(raw);
    if (!map || this.phase !== "lobby" || byId !== this.hostId || map === this.map) return false;
    this.map = map;
    return true;
  }

  /** El anfitrión pasa de paso en la espera (1..LOBBY_STEPS). De otro, o con la partida ya arrancada, se ignora. */
  setLobbyStep(byId: string, raw: unknown): boolean {
    const step = inRange(raw, [1, LOBBY_STEPS], 0);
    if (!step || this.phase !== "lobby" || byId !== this.hostId || step === this.lobbyStep) return false;
    this.lobbyStep = step;
    return true;
  }

  /**
   * El anfitrión escribe el reloj antes de arrancar: { turn, shop, rounds }. Cada número que falte,
   * no sea entero o caiga fuera de CLOCK_LIMITS vuelve al de siempre. De otro, o con la partida ya
   * arrancada, se ignora: la revancha juega con los mismos.
   */
  setClock(byId: string, raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null || this.phase !== "lobby" || byId !== this.hostId) return false;
    const msg = raw as Record<string, unknown>;
    const turn = inRange(msg.turn, CLOCK_LIMITS.turn, this.defaultTurnSeconds);
    const shop = inRange(msg.shop, CLOCK_LIMITS.shop, this.defaultShopSeconds);
    const rounds = inRange(msg.rounds, CLOCK_LIMITS.rounds, ROUNDS_PER_MATCH);
    if (turn === this.turnSeconds && shop === this.shopSeconds && rounds === this.rounds) return false;
    this.turnSeconds = turn;
    this.shopSeconds = shop;
    this.rounds = rounds;
    return true;
  }

  canStart(byId: string): boolean {
    return this.phase === "lobby" && byId === this.hostId && this.seats.length >= MIN_PLAYERS;
  }

  start(byId: string, seed: number): boolean {
    if (!this.canStart(byId)) return false;
    this.baseSeed = seed >>> 0;
    const ids = this.seats.map((s) => s.id);
    this.board = emptyScoreboard(ids);
    const players = ids.map((id) => ({ id, money: MONEY_START, inventory: startingInventory() }));
    this.startRound(players);
    return true;
  }

  canRematch(byId: string): boolean {
    return this.phase === "ended" && byId === this.hostId && this.connectedSeats.length >= MIN_PLAYERS;
  }

  /**
   * Revancha en la misma sala: los que quedan siguen en su asiento (mismo id, nombre y color) y la
   * partida arranca de cero, como un start, en el mismo mapa y con el mismo reloj. Los asientos de los que se fueron se sueltan.
   */
  rematch(byId: string, seed: number): boolean {
    if (!this.canRematch(byId)) return false;
    this.seats = this.connectedSeats;
    this.round = 0;
    this.winners = [];
    this.winnerId = null;
    this.endReason = null;
    this.lastRound = null;
    this.burned = [];
    this.phase = "lobby";
    return this.start(byId, seed);
  }

  /** Semilla de cada ronda: derivada de la del arranque, así una partida se puede reproducir. */
  private seedFor(round: number): number {
    return (this.baseSeed + Math.imul(round, 0x9e3779b1)) >>> 0;
  }

  private startRound(players: readonly Player[]): void {
    this.round++;
    this.roundSerial++;
    const gone = new Set(this.seats.filter((s) => !s.connected).map((s) => s.id));
    this.match = startRound3D(this.seedFor(this.round), players, gone, this.map);
    this.windRng = createRng(this.seedFor(this.round) ^ 0x7f4a7c15);
    const { terrain, tanks } = this.match;
    // Cada cañón arranca mirando al centro del mapa, a 45°.
    const cx = (terrain.width - 1) / 2;
    const cz = (terrain.depth - 1) / 2;
    for (const t of tanks) {
      const yaw = ((Math.atan2(cz - t.z, cx - t.x) * 180) / Math.PI + 360) % 360;
      this.aims.set(t.id, { yaw, pitch: 45 });
    }
    this.turnsTaken.clear();
    this.marks.clear(); // terreno y posiciones nuevos: las marcas de la ronda anterior no dicen nada
    this.ready.clear();
    this.movedThisTurn = false;
    this.steppedThisTurn = false;
    this.lapPlayed.clear();
    this.lapLife = totalLife(this.match);
    this.giftFuel.clear();
    this.refueled = [];
    // Empieza un jugador distinto cada ronda.
    const n = this.seats.length;
    const alive = new Set(tanks.filter((t) => t.life > 0).map((t) => t.id));
    this.turnId = null;
    for (let k = 0; k < n; k++) {
      const seat = this.seats[(this.round - 1 + k) % n]!;
      if (alive.has(seat.id)) {
        this.turnId = seat.id;
        break;
      }
    }
    this.phase = "aiming";
    this.timeLeft = this.turnSeconds;
  }

  /** Nafta: mueve el tanque del turno antes de tirar. null = ignorado. */
  move(byId: string, raw: unknown): { x: number; y: number; z: number } | null {
    if (this.phase !== "aiming" || byId !== this.turnId || !this.match || this.movedThisTurn) return null;
    const to = parseMoveMessage(raw);
    if (!to || !validateMove(this.match, byId, to).ok) return null;
    this.match = moveTank(this.match, byId, to);
    this.giftFuel.delete(byId); // la regalada se gasta primero
    this.movedThisTurn = true;
    const t = this.match.tanks.find((tk) => tk.id === byId)!;
    return { x: t.x, y: t.y, z: t.z };
  }

  /**
   * El del turno todavía tiene el paso gratis: es su primer turno de la ronda y no lo dio. No se
   * guarda: si tira (o se le va el reloj) sin usarlo, lo pierde.
   */
  get stepLeft(): boolean {
    return this.phase === "aiming" && this.turnId !== null && !this.steppedThisTurn && (this.turnsTaken.get(this.turnId) ?? 0) === 0;
  }

  /** Paso gratis: como move, pero sin nafta y hasta FREE_STEP_RANGE. null = ignorado. */
  step(byId: string, raw: unknown): { x: number; y: number; z: number } | null {
    if (byId !== this.turnId || !this.match || !this.stepLeft) return null;
    const to = parseMoveMessage(raw);
    if (!to || !validateMove(this.match, byId, to, true).ok) return null;
    this.match = moveTank(this.match, byId, to, true);
    this.steppedThisTurn = true;
    const t = this.match.tanks.find((tk) => tk.id === byId)!;
    return { x: t.x, y: t.y, z: t.z };
  }

  /** null = mensaje ignorado (no es su turno, fase incorrecta, mensaje inválido o sin munición). */
  fire(byId: string, raw: unknown): ShotEvent | null {
    if (this.phase !== "aiming" || byId !== this.turnId || !this.match) return null;
    const msg = parseFireMessage(raw);
    if (!msg) return null;
    let result: TurnResult3D;
    try {
      // Solo estos cuatro datos llegan al sim; el sim valida arma y munición.
      result = resolveTurn(
        this.match,
        { playerId: byId, yaw: msg.yaw, pitch: msg.pitch, power: msg.power, weaponId: msg.weapon },
        { recordPath: true },
      );
    } catch {
      return null;
    }
    this.pending = { result, shooterId: byId };
    this.marks.delete(byId); // tira de nuevo: su marca vieja se va; la nueva llega cuando caiga
    // La munición se descuenta ya (todos ven el Missile gastado al disparar). El resto del
    // resultado (daño, plata, cráter o loma, fuego, escudos gastados) se aplica recién en finishShot,
    // cuando cae el proyectil.
    const left = result.state.players.find((p) => p.id === byId)!.inventory[msg.weapon];
    this.match = {
      ...this.match,
      players: this.match.players.map((p) => (p.id === byId ? { ...p, inventory: { ...p.inventory, [msg.weapon]: left } } : p)),
    };
    this.phase = "animating";
    this.turnsTaken.set(byId, (this.turnsTaken.get(byId) ?? 0) + 1);
    this.aims.set(byId, { yaw: ((msg.yaw % 360) + 360) % 360, pitch: Math.min(90, Math.max(0, msg.pitch)) });
    return { result, shooterId: byId, ...msg, durationMs: shotDurationMs(result.shot.ticks) };
  }

  /** Aplica el resultado del tiro cuando terminó la animación y pasa el turno. */
  finishShot(): void {
    if (this.phase !== "animating" || !this.pending || !this.match) return;
    this.match = this.withLeaversDead(this.pending.result.state);
    this.board = scoreTurn(this.board, this.pending.shooterId, this.pending.result.damage);
    this.marks.set(this.pending.shooterId, shotMark(this.pending.result.shot));
    this.pending = null;
    this.afterTurn();
  }

  buy(byId: string, raw: unknown): boolean {
    if (this.phase !== "shop" || !this.match) return false;
    const item = parseBuyMessage(raw);
    const player = this.playerOf(byId);
    if (!item || !player || cannotBuy(player, item)) return false;
    const bought = buyItem(player, item);
    this.match = { ...this.match, players: this.match.players.map((p) => (p.id === byId ? bought : p)) };
    return true;
  }

  /** Vender en la tienda, a la mitad. En las demás fases se ignora: lo que ya salió no vuelve. */
  sell(byId: string, raw: unknown): boolean {
    if (this.phase !== "shop" || !this.match) return false;
    const item = parseBuyMessage(raw);
    const player = this.playerOf(byId);
    if (!item || !player || cannotSell(player, item)) return false;
    const sold = sellItem(player, item);
    this.match = { ...this.match, players: this.match.players.map((p) => (p.id === byId ? sold : p)) };
    return true;
  }

  setReady(byId: string): void {
    if (this.phase !== "shop") return;
    this.ready.add(byId);
    if (this.connectedSeats.every((s) => this.ready.has(s.id))) this.startRound(this.match!.players);
  }

  /** Llamar una vez por segundo. Devuelve true si el jugador del turno perdió el turno por tiempo. */
  tickSecond(): boolean {
    if (this.phase === "shop") {
      this.timeLeft = Math.max(0, this.timeLeft - 1);
      if (this.timeLeft === 0) this.startRound(this.match!.players);
      return false;
    }
    if (this.phase !== "aiming") return false;
    this.timeLeft = Math.max(0, this.timeLeft - 1);
    if (this.timeLeft > 0) return false;
    // Tiro nulo: no dispara, no gasta nada, pasa el turno (y cuenta como turno jugado).
    if (this.turnId) this.turnsTaken.set(this.turnId, (this.turnsTaken.get(this.turnId) ?? 0) + 1);
    this.afterTurn();
    return true;
  }

  removePlayer(id: string): void {
    const seat = this.seats.find((s) => s.id === id);
    if (!seat) return;
    if (this.phase === "lobby") {
      this.seats = this.seats.filter((s) => s.id !== id);
    } else if (this.phase !== "ended") {
      seat.connected = false;
      if (this.connectedSeats.length < MIN_PLAYERS) {
        this.finish("forfeit"); // si se van todos menos uno, ese gana
      } else if (this.match) {
        this.match = this.withLeaversDead(this.match);
        if (this.phase === "aiming") {
          if (this.turnId === id) this.afterTurn();
          else if (roundOver(this.match)) this.endRound();
        } else if (this.phase === "shop") {
          this.ready.delete(id);
          if (this.connectedSeats.every((s) => this.ready.has(s.id))) this.startRound(this.match.players);
        }
        // En "animating", finishShot() vuelve a matar a los que se fueron y decide.
      }
    } else {
      seat.connected = false;
    }
    if (this.hostId === id) this.hostId = this.connectedSeats[0]?.id ?? null;
  }

  private withLeaversDead(match: MatchState3D): MatchState3D {
    const gone = new Set(this.seats.filter((s) => !s.connected).map((s) => s.id));
    if (gone.size === 0) return match;
    return { ...match, tanks: match.tanks.map((t) => (gone.has(t.id) && t.life > 0 ? { ...t, life: 0 } : t)) };
  }

  private afterTurn(): void {
    this.movedThisTurn = false;
    this.steppedThisTurn = false;
    if (!this.match) return;
    // El fuego de más abajo ya es de la vuelta que sigue: la que termina se cierra antes.
    const quietLap = this.closeLap();
    // Si al que le toca lo mata el fuego al empezar, el turno sigue de largo al próximo.
    for (;;) {
      const next = roundOver(this.match) ? null : this.nextTurn();
      if (!next) {
        this.endRound();
        return;
      }
      this.turnId = next;
      if (this.burn(next)) break;
    }
    if (quietLap) this.refuel();
    // Turno nuevo, viento nuevo: se corre desde el anterior. El primer turno de la ronda juega con el sorteado.
    this.match = { ...this.match, wind: driftWind3D(this.match.wind, this.windRng) };
    this.phase = "aiming";
    this.timeLeft = this.turnSeconds;
  }

  /**
   * Fuego de la ronda (Napalm): el que empieza su turno parado en un disco pierde vida, y los
   * puntos son del que lo prendió. Devuelve si sigue vivo para jugar el turno.
   */
  private burn(id: string): boolean {
    const { state, burns } = burnTurn3D(this.match!, id);
    this.match = state;
    for (const b of burns) this.board = scoreTurn(this.board, b.ownerId, [b]);
    this.burned.push(...burns);
    return state.tanks.some((t) => t.id === id && t.life > 0);
  }

  /**
   * Anota al que acaba de jugar. Si con él ya jugaron todos los vivos, se cerró una vuelta: devuelve
   * si en esa vuelta nadie perdió vida (tiro, caída, fuego o agua), y empieza a contar la siguiente.
   */
  private closeLap(): boolean {
    if (this.turnId) this.lapPlayed.add(this.turnId);
    const m = this.match!;
    if (m.tanks.some((t) => t.life > 0 && !this.lapPlayed.has(t.id))) return false;
    const life = totalLife(m);
    const quiet = life >= this.lapLife;
    this.lapPlayed.clear();
    this.lapLife = life;
    return quiet;
  }

  /**
   * Vuelta sin daño: cada tanque vivo recibe una Nafta, la haya comprado o no, para acercarse. No se
   * apila: el que todavía tiene la de una vuelta anterior no recibe otra. Se usa como la de la tienda.
   */
  private refuel(): void {
    const got = new Set(this.match!.tanks.filter((t) => t.life > 0 && !this.giftFuel.has(t.id)).map((t) => t.id));
    if (got.size === 0) return;
    this.match = {
      ...this.match!,
      players: this.match!.players.map((p) => (got.has(p.id) ? { ...p, inventory: { ...p.inventory, fuel: (p.inventory.fuel ?? 0) + 1 } } : p)),
    };
    for (const id of got) this.giftFuel.add(id);
    this.refueled.push(...got);
  }

  /** Entrega (y vacía) los que recibieron la Nafta de una vuelta sin daño: la sala lo manda como "refuel". */
  takeRefuel(): string[] {
    const out = this.refueled;
    this.refueled = [];
    return out;
  }

  /** Entrega (y vacía) lo que quemó el fuego: la sala lo manda como "burn". */
  takeBurns(): BurnEvent[] {
    const out = this.burned;
    this.burned = [];
    return out;
  }

  /** Siguiente asiento, en orden de llegada, vivo y con tiros disponibles en la ronda. */
  private nextTurn(): string | null {
    const alive = new Set(this.match!.tanks.filter((t) => t.life > 0).map((t) => t.id));
    const n = this.seats.length;
    const from = this.seats.findIndex((s) => s.id === this.turnId);
    for (let k = 1; k <= n; k++) {
      const seat = this.seats[(from + k + n) % n]!;
      if (alive.has(seat.id) && (this.turnsTaken.get(seat.id) ?? 0) < ROUND_MAX_TURNS) return seat.id;
    }
    return null;
  }

  /** Fin de ronda: cobran los que siguen vivos, todos cobran interés; tienda o fin de partida. */
  private endRound(): void {
    const m = this.match!;
    const survivors = new Set(m.tanks.filter((t) => t.life > 0).map((t) => t.id));
    // La Nafta regalada que nadie usó se queda en la ronda: a la tienda llega solo la comprada.
    const kept = m.players.map((p) => (this.giftFuel.has(p.id) ? { ...p, inventory: { ...p.inventory, fuel: (p.inventory.fuel ?? 0) - 1 } } : p));
    this.giftFuel.clear();
    this.refueled = [];
    const { players, payouts } = endRoundPayouts(kept, survivors);
    this.match = { ...m, players };
    this.lastRound = { round: this.round, survivors: [...survivors], payouts };
    this.turnId = null;
    if (this.round >= this.rounds) {
      this.finish("rounds");
      return;
    }
    this.phase = "shop";
    this.timeLeft = this.shopSeconds;
    this.ready.clear();
  }

  private finish(reason: "rounds" | "forfeit"): void {
    this.phase = "ended";
    this.endReason = reason;
    this.turnId = null;
    this.timeLeft = 0;
    this.pending = null;
    this.winners =
      reason === "forfeit"
        ? this.connectedSeats.map((s) => s.id)
        : matchWinners(
            this.board,
            this.seats.map((s) => s.id),
          );
    this.winnerId = this.winners.length === 1 ? this.winners[0]! : null;
  }
}
