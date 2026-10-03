// SPDX-License-Identifier: GPL-2.0-or-later
// Lógica de la partida, sin Colyseus: lobby, rondas, turnos, tienda, reloj, salidas y ganador.
// Las reglas (tiro, cráter, daño, plata, tienda, nafta, puntaje) son de @pegaycobra/sim;
// acá solo se ordena el tiempo: quién juega, cuándo termina la ronda y cuándo abre la tienda.

import {
  buyItem,
  cannotBuy,
  emptyScoreboard,
  endRoundPayouts,
  matchWinners,
  MONEY_START,
  moveTank,
  resolveTurn,
  ROUND_MAX_TURNS,
  ROUNDS_PER_MATCH,
  roundOver,
  scoreTurn,
  SHOP_ITEMS,
  startingInventory,
  startRound3D,
  STEP_SECONDS,
  validateMove,
  type MatchState3D,
  type Player,
  type RoundPayout,
  type Scoreboard,
  type ShopItemId,
  type TurnResult3D,
  type WeaponId,
} from "@pegaycobra/sim";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const TURN_SECONDS = 30;
export const SHOP_SECONDS = 20;
/** El cliente reproduce el tiro 1.5× más rápido que el tiempo real del original. */
export const PLAYBACK_SPEED = 1.5;
/** Tope de la animación, por si un tiro dura muchísimo (p. ej. "timeout"). [ms] */
export const MAX_SHOT_MS = 8000;
export const NAME_MAX = 16;

export type Phase = "lobby" | "aiming" | "animating" | "shop" | "ended";

export interface Seat {
  id: string;
  name: string;
  /** 0..3, define el color. */
  slot: number;
  connected: boolean;
}

/** Armas que el cliente puede pedir. Baby Nuke y Nuke no existen para el juego. */
const FIREABLE: readonly WeaponId[] = ["babyMissile", "missile", "roller"];

export interface FireMessage {
  yaw: number;
  pitch: number;
  power: number;
  weapon: WeaponId;
}

/**
 * Del mensaje del cliente se leen solo yaw, pitch, power y weapon; cualquier otro campo (daño,
 * impacto, posición...) se ignora y no llega al sim. weapon puede faltar (= Baby Missile); si
 * nombra algo que no sea "babyMissile", "missile" o "roller", el mensaje entero se descarta.
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
  match: MatchState3D | null = null;
  turnId: string | null = null;
  /** Segundos que le quedan al turno o a la tienda. */
  timeLeft = 0;
  /** Ronda en curso (1..rounds). 0 = no empezó. */
  round = 0;
  readonly rounds = ROUNDS_PER_MATCH;
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
  /** Último yaw/pitch que usó cada jugador (solo para dibujar el cañón). */
  readonly aims = new Map<string, Aim>();
  private readonly turnsTaken = new Map<string, number>();
  private pending: { result: TurnResult3D; shooterId: string } | null = null;
  private baseSeed = 0;

  constructor(
    private readonly turnSeconds = TURN_SECONDS,
    private readonly shopSeconds = SHOP_SECONDS,
  ) {}

  get connectedSeats(): Seat[] {
    return this.seats.filter((s) => s.connected);
  }

  playerOf(id: string): Player | undefined {
    return this.match?.players.find((p) => p.id === id);
  }

  addPlayer(id: string, rawName: unknown): Seat {
    if (this.phase !== "lobby") throw new Error("la partida ya empezó");
    if (this.seats.length >= MAX_PLAYERS) throw new Error("la sala está llena");
    const used = new Set(this.seats.map((s) => s.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const seat: Seat = { id, name: sanitizeName(rawName, `Jugador ${slot + 1}`), slot, connected: true };
    this.seats.push(seat);
    this.hostId ??= id;
    return seat;
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

  /** Semilla de cada ronda: derivada de la del arranque, así una partida se puede reproducir. */
  private seedFor(round: number): number {
    return (this.baseSeed + Math.imul(round, 0x9e3779b1)) >>> 0;
  }

  private startRound(players: readonly Player[]): void {
    this.round++;
    this.roundSerial++;
    const gone = new Set(this.seats.filter((s) => !s.connected).map((s) => s.id));
    this.match = startRound3D(this.seedFor(this.round), players, gone);
    const { terrain, tanks } = this.match;
    // Cada cañón arranca mirando al centro del mapa, a 45°.
    const cx = (terrain.width - 1) / 2;
    const cz = (terrain.depth - 1) / 2;
    for (const t of tanks) {
      const yaw = ((Math.atan2(cz - t.z, cx - t.x) * 180) / Math.PI + 360) % 360;
      this.aims.set(t.id, { yaw, pitch: 45 });
    }
    this.turnsTaken.clear();
    this.ready.clear();
    this.movedThisTurn = false;
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
    this.movedThisTurn = true;
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
    // La munición se descuenta ya (todos ven el Missile gastado al disparar). El resto del
    // resultado (daño, plata, cráter, escudos gastados) se aplica recién en finishShot, cuando
    // cae el proyectil.
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
    if (!this.match) return;
    const next = roundOver(this.match) ? null : this.nextTurn();
    if (!next) {
      this.endRound();
      return;
    }
    this.turnId = next;
    this.phase = "aiming";
    this.timeLeft = this.turnSeconds;
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
    const { players, payouts } = endRoundPayouts(m.players, survivors);
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
