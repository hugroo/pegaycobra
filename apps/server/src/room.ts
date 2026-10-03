// SPDX-License-Identifier: GPL-2.0-or-later
// Sala de Colyseus: recibe mensajes, se los pasa a Game y copia el resultado al estado.
//
// Mensajes del cliente:  start · fillBots · fire { yaw, pitch, power, weapon }
//                        move { moveTo: { x, z } } · buy { item } · ready
// Los bots (bot.ts) no tienen conexión: la sala les pasa sus mensajes por los mismos métodos.
// Mensajes del server:   terrain (binario) · shot · moved · skip · roundEnd

import { Room, type Client } from "@colyseus/core";
import { createRng } from "@pegaycobra/sim";
import { BOT_NAME, botWantsMissile, pickBotShot } from "./bot";
import { Game, MAX_PLAYERS, MIN_PLAYERS } from "./game";
import { generateCode } from "./codes";
import { GameState, PlayerState } from "./schema";
import { changedRect, fullTerrain, terrainRect } from "./terrain-net";

/** Códigos en uso por salas vivas en este proceso. */
export const activeCodes = new Set<string>();

/** Mensaje "shot" que reciben todos los clientes para animar. */
export interface ShotBroadcast {
  shooterId: string;
  yaw: number;
  pitch: number;
  power: number;
  /** "babyMissile" | "missile" */
  weapon: string;
  /** "ground" | "tank" | "offmap" | "timeout". Con "offmap" todos muestran "se fue". */
  outcome: string;
  /** [x0, y0, z0, x1, y1, z1, ...] en wu, redondeado a 0.01. */
  path: number[];
  durationMs: number;
}

/** Mensaje "roundEnd": lo que cobró cada uno al terminar la ronda. */
export interface RoundEndBroadcast {
  round: number;
  survivors: string[];
  payouts: { id: string; survivor: number; interest: number; after: number }[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export class GameRoom extends Room<{ state: GameState }> {
  /** Escala del retardo entre tiro y aplicación del resultado. Los tests la bajan. */
  static shotDelayScale = 1;
  static turnSeconds = 30;
  static shopSeconds = 20;
  /** Semilla fija para tests reproducibles. null = al azar. */
  static seedOverride: number | null = null;
  /** Lo que tarda un bot en tirar o en tocar "listo". Los tests lo bajan. [ms] */
  static botDelayMs = 1500;

  maxClients = 4;
  private game = new Game(GameRoom.turnSeconds, GameRoom.shopSeconds);
  private sentRoundSerial = 0;
  private sentRoundEnd: object | null = null;
  /** Asientos que son bots. */
  private readonly bots = new Set<string>();
  private botSerial = 0;
  private botRng: () => number = Math.random;
  private botPending = false;

  onCreate(): void {
    this.roomId = generateCode(activeCodes);
    activeCodes.add(this.roomId);
    this.setState(new GameState());
    this.state.code = this.roomId;

    this.onMessage("start", (client) => {
      const seed = GameRoom.seedOverride ?? Math.floor(Math.random() * 2 ** 31);
      if (!this.game.start(client.sessionId, seed)) return;
      this.botRng = createRng(seed ^ 0x51ed270b);
      void this.lock(); // nadie más entra una vez arrancada
      this.flush();
    });

    this.onMessage("fillBots", (client) => {
      if (this.game.phase !== "lobby" || client.sessionId !== this.game.hostId) return;
      while (this.game.seats.length < MIN_PLAYERS) {
        const id = `bot-${++this.botSerial}`;
        this.game.addPlayer(id, BOT_NAME);
        this.bots.add(id);
        this.log(`entra ${BOT_NAME}`);
      }
      this.flush();
    });

    this.onMessage("move", (client, message: unknown) => {
      const to = this.game.move(client.sessionId, message);
      if (!to) return; // ignorado
      this.broadcast("moved", { id: client.sessionId, ...to });
      this.log(`${this.nameOf(client.sessionId)} usa nafta -> (${to.x.toFixed(1)}, ${to.z.toFixed(1)})`);
      this.flush();
    });

    this.onMessage("fire", (client, message: unknown) => this.onFire(client.sessionId, message));
    this.onMessage("buy", (client, message: unknown) => this.onBuy(client.sessionId, message));
    this.onMessage("ready", (client) => this.onReady(client.sessionId));

    this.clock.setInterval(() => {
      if (this.game.phase !== "aiming" && this.game.phase !== "shop") return;
      const before = this.game.turnId;
      const timedOut = this.game.tickSecond();
      if (timedOut) {
        this.broadcast("skip", {});
        this.log(`${this.nameOf(before ?? "")} no tiro a tiempo: tiro nulo`);
      }
      this.flush();
    }, 1000);
  }

  private onFire(id: string, message: unknown): void {
    const shot = this.game.fire(id, message);
    if (!shot) return; // ignorado
    const r = shot.result.shot;
    const payload: ShotBroadcast = {
      shooterId: shot.shooterId,
      yaw: shot.yaw,
      pitch: shot.pitch,
      power: shot.power,
      weapon: shot.weapon,
      outcome: r.outcome,
      path: (r.path ?? []).map(round2),
      durationMs: shot.durationMs,
    };
    this.flush();
    this.broadcast("shot", payload);
    const hits = shot.result.damage
      .map((d) => `${this.nameOf(d.targetId)} -${d.damage.toFixed(1)}${d.killed ? " (muere)" : ""} [${d.cause}]`)
      .join(", ");
    this.log(
      `tira ${this.nameOf(shot.shooterId)} ${shot.weapon} yaw ${shot.yaw.toFixed(0)} pitch ${shot.pitch.toFixed(0)} ` +
        `pot ${shot.power.toFixed(0)} -> ${payload.outcome} (${r.x.toFixed(1)}, ${r.z.toFixed(1)})${hits ? ` | ${hits}` : ""}`,
    );
    this.clock.setTimeout(() => {
      const before = this.game.match?.terrain;
      const serial = this.game.roundSerial;
      this.game.finishShot();
      // El cráter llega a todos recién ahora, junto con la vida y las posiciones nuevas.
      const after = this.game.match?.terrain;
      if (before && after && serial === this.game.roundSerial) {
        const rect = changedRect(before, after);
        if (rect) this.broadcast("terrain", terrainRect(after, rect.x0, rect.z0, rect.w, rect.d));
      }
      this.flush();
    }, (shot.durationMs + 250) * GameRoom.shotDelayScale);
  }

  private onBuy(id: string, message: unknown): void {
    if (!this.game.buy(id, message)) return;
    const item = (message as { item?: string }).item;
    this.log(`${this.nameOf(id)} compra ${item}`);
    this.flush();
  }

  private onReady(id: string): void {
    this.game.setReady(id);
    this.flush();
  }

  /** Si le toca a un bot (tirar, o comprar y dar el listo), lo agenda para dentro de botDelayMs. */
  private driveBots(): void {
    if (this.botPending || this.bots.size === 0) return;
    const g = this.game;
    const due =
      (g.phase === "aiming" && g.turnId !== null && this.bots.has(g.turnId)) ||
      (g.phase === "shop" && [...this.bots].some((id) => !g.ready.has(id)));
    if (!due) return;
    this.botPending = true;
    this.clock.setTimeout(() => {
      this.botPending = false;
      this.botAct();
    }, GameRoom.botDelayMs);
  }

  private botAct(): void {
    const g = this.game;
    if (g.phase === "aiming" && g.turnId !== null && this.bots.has(g.turnId) && g.match) {
      const shot = pickBotShot(g.match, g.turnId, this.botRng);
      if (shot) this.onFire(g.turnId, { yaw: shot.yaw, pitch: shot.pitch, power: shot.power, weapon: shot.weapon });
    } else if (g.phase === "shop") {
      for (const id of this.bots) {
        if (g.ready.has(id)) continue;
        const player = g.playerOf(id);
        if (player && botWantsMissile(player)) this.onBuy(id, { item: "missile" });
        this.onReady(id);
      }
    }
  }

  onJoin(client: Client, options?: { name?: unknown }): void {
    // Un bot le deja el lugar a un humano si la sala pasaría de MAX_PLAYERS.
    const bot = [...this.bots][0];
    if (bot && this.game.phase === "lobby" && this.game.seats.length >= MAX_PLAYERS) {
      this.game.removePlayer(bot);
      this.bots.delete(bot);
      this.log(`sale ${BOT_NAME}`);
    }
    const seat = this.game.addPlayer(client.sessionId, options?.name); // tira si ya empezó o está llena
    this.sync();
    this.log(`entra ${seat.name}`);
  }

  onLeave(client: Client): void {
    const name = this.nameOf(client.sessionId);
    this.game.removePlayer(client.sessionId);
    // Un bot no puede quedar de anfitrión: no arranca la partida.
    if (this.game.hostId && this.bots.has(this.game.hostId)) {
      this.game.hostId = this.game.connectedSeats.find((s) => !this.bots.has(s.id))?.id ?? null;
    }
    this.log(`sale ${name}`);
    this.flush();
  }

  onDispose(): void {
    activeCodes.delete(this.roomId);
  }

  /**
   * Después de cada cambio: si terminó una ronda, manda el resumen; si empezó una, manda el
   * terreno nuevo completo; después sincroniza el estado.
   */
  private flush(): void {
    const g = this.game;
    if (g.lastRound && g.lastRound !== this.sentRoundEnd) {
      this.sentRoundEnd = g.lastRound;
      const msg: RoundEndBroadcast = {
        round: g.lastRound.round,
        survivors: g.lastRound.survivors,
        payouts: g.lastRound.payouts.map(({ id, survivor, interest, after }) => ({ id, survivor, interest, after })),
      };
      this.broadcast("roundEnd", msg);
      this.log(
        `fin de ronda ${msg.round}: ` +
          msg.payouts.map((p) => `${this.nameOf(p.id)} +${p.survivor} sobrevivir +${p.interest} interes = ${p.after}`).join(", "),
      );
    }
    if (g.match && g.roundSerial !== this.sentRoundSerial) {
      this.sentRoundSerial = g.roundSerial;
      this.broadcast("terrain", fullTerrain(g.match.terrain));
      const w = g.match.wind;
      this.log(`ronda ${g.round}/${g.rounds}, viento (${w.x.toFixed(1)}, ${w.z.toFixed(1)})`);
    }
    const before = `${this.state.phase}:${this.state.turnId}`;
    this.sync();
    if (`${this.state.phase}:${this.state.turnId}` !== before) this.logTurn();
    this.driveBots();
  }

  private nameOf(id: string): string {
    return this.game.seats.find((s) => s.id === id)?.name ?? id;
  }

  private log(msg: string): void {
    if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
    console.log(`[${this.roomId}] ${msg}`);
  }

  private logTurn(): void {
    const g = this.game;
    if (g.phase === "ended") {
      const pts = g.seats.map((s) => `${s.name} ${g.board[s.id]?.points ?? 0}`).join(", ");
      this.log(`fin de la partida (${g.endReason}): ${g.winnerId ? `gana ${this.nameOf(g.winnerId)}` : "empate"} | ${pts}`);
    } else if (g.phase === "shop") this.log(`tienda (${g.timeLeft} s)`);
    else if (g.turnId && g.phase === "aiming") this.log(`turno de ${this.nameOf(g.turnId)}`);
  }

  /** Copia Game → schema. Solo escribe lo que cambió, así los parches son chicos. */
  private sync(): void {
    const g = this.game;
    const s = this.state;
    s.phase = g.phase;
    s.hostId = g.hostId ?? "";
    s.turnId = g.turnId ?? "";
    s.timeLeft = g.timeLeft;
    s.round = g.round;
    s.rounds = g.rounds;
    s.moved = g.movedThisTurn;
    s.winnerId = g.winnerId ?? "";
    s.endReason = g.endReason ?? "";
    if (s.winners.length !== g.winners.length || g.winners.some((w, i) => s.winners[i] !== w)) {
      s.winners.splice(0, s.winners.length, ...g.winners);
    }

    const ids = g.seats.map((seat) => seat.id);
    if (s.order.length !== ids.length || ids.some((id, i) => s.order[i] !== id)) {
      s.order.splice(0, s.order.length, ...ids);
    }
    for (const key of [...s.players.keys()]) if (!ids.includes(key)) s.players.delete(key);

    for (const seat of g.seats) {
      let p = s.players.get(seat.id);
      if (!p) {
        p = new PlayerState();
        p.id = seat.id;
        s.players.set(seat.id, p);
      }
      p.name = seat.name;
      p.slot = seat.slot;
      p.connected = seat.connected;
      p.ready = g.ready.has(seat.id);
      const aim = g.aims.get(seat.id);
      if (aim) {
        p.yaw = aim.yaw;
        p.pitch = aim.pitch;
      }
      const tank = g.match?.tanks.find((tk) => tk.id === seat.id);
      if (tank) {
        p.x = tank.x;
        p.y = tank.y;
        p.z = tank.z;
        p.life = tank.life;
      }
      const player = g.playerOf(seat.id);
      if (player) {
        p.money = player.money;
        p.missiles = Math.max(0, player.inventory.missile ?? 0);
        p.parachute = player.inventory.parachute ?? 0;
        p.fuel = player.inventory.fuel ?? 0;
      }
      const score = g.board[seat.id];
      if (score) {
        p.points = score.points;
        p.kills = score.kills;
        p.damage = score.damage;
      }
    }

    if (g.match) {
      s.windX = g.match.wind.x;
      s.windZ = g.match.wind.z;
      s.mapWidth = g.match.terrain.width;
      s.mapDepth = g.match.terrain.depth;
    }
  }
}
