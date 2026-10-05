// SPDX-License-Identifier: GPL-2.0-or-later
// Sala de Colyseus: recibe mensajes, se los pasa a Game y copia el resultado al estado.
//
// Mensajes del cliente:  start · rematch · fillBots · lobbyStep { step } · map { map } · clock { turn, shop, rounds }
//                        fire { yaw, pitch, power, weapon }
//                        move { moveTo: { x, z } } · buy { item } · sell { item } · spawn { at: { x, z } }
//                        mound { at: { x, z } } · ready · chat { text }
// Los bots (bot.ts) no tienen conexión: la sala les pasa sus mensajes por los mismos métodos.
// Mensajes del server:   terrain (binario) · pristine (binario, solo al que vuelve) · shot · moved · mound · skip · burn · refuel · roundEnd · chat

//
// Si a uno se le cae la conexión sin avisar (refrescó la página), el asiento se le guarda
// rejoinSeconds: vuelve con el token de reconexión y sigue siendo el mismo id, con su tanque.

import { Room, type Client, type Delayed } from "@colyseus/core";
import { createRng, MAPS, MONEY_PER_ROUND, type TurnResult3D } from "@pegaycobra/sim";
import { BOT_NAME, botMovePick, botShopPick, botSpawnPick, pickBotShot } from "./bot";
import { Game, MAX_PLAYERS, MIN_PLAYERS, SHOP_SECONDS, TURN_SECONDS, type RoundSummary, type ShotMark } from "./game";
import { generateCode } from "./codes";
import { FireState, GameState, PlayerState } from "./schema";
import { changedRect, fullTerrain, terrainRect } from "./terrain-net";

/** Códigos en uso por salas vivas en este proceso. */
export const activeCodes = new Set<string>();

/** Mensaje "shot" que reciben todos los clientes para animar. */
export interface ShotBroadcast {
  shooterId: string;
  yaw: number;
  pitch: number;
  power: number;
  /** "babyMissile" | "missile" | "roller" | "napalm" | "nuke" | "dirt" | "mirv" | "leapfrog" */
  weapon: string;
  /**
   * "ground" | "tank" | "water" | "offmap" | "timeout". Con "offmap" todos muestran "se fue" y con
   * "water", "al agua". Con un Racimo abierto vale por el tiro entero: explotó si explotó alguna cabeza.
   */
  outcome: string;
  /**
   * [x0, y0, z0, x1, y1, z1, ...] en wu, redondeado a 0.01. Con el Roller incluye la rodada; con un
   * Racimo abierto llega hasta donde se abrió y sigue en `heads`; con un Rebote que picó trae los
   * dos tramos seguidos.
   */
  path: number[];
  /** Solo Rebote que picó: `path[tick]` es el punto donde tocó el piso. El tiro termina más adelante. */
  bounce?: { tick: number };
  /** Solo Rodillo que tocó el piso: desde `path[tick]` va rodando. Es para dibujarlo: el recorrido es el mismo. */
  roll?: { tick: number };
  /** Solo Racimo que se abrió: cada cabeza, desde el punto de apertura hasta donde terminó. */
  heads?: { path: number[]; outcome: string }[];
  /** Lo que dura la animación entera, hasta que cae la última cabeza. */
  durationMs: number;
  /** Dónde terminó el tiro: ahí va el cartel. Con un Racimo, la cabeza del medio (si se fue, la primera que explotó). [wu] */
  impact: { x: number; y: number; z: number };
  /** Daño total que hizo el tiro (explosión + caídas, de todas las cabezas), ya resuelto por el sim. [hp] */
  damage: number;
  /**
   * Tanques cuyo escudo absorbió el tiro. Con alguno, el cartel dice "bloqueado". Con el Nuke, siempre
   * vacío. Con el Racimo el escudo absorbe una cabeza: si otra le pegó, además hay daño.
   */
  blocked: string[];
  /** Tanques que este tiro dejó en el agua: murieron ahí, con escudo o paracaídas y todo. */
  drowned: string[];
  /**
   * Dónde chapotea el agua: uno grande (`big`) por cada tanque de `drowned`, donde quedó, y uno chico
   * por cada golpe que se hundió en el lago (el tiro, o cada cabeza de un Racimo). El cliente dibuja
   * estos y ninguno más. [wu]
   */
  splashes: Splash[];
}

export interface Splash {
  x: number;
  z: number;
  big: boolean;
}

/** Los chapuzones de un tiro ya resuelto: primero los ahogados, después los golpes que cayeron al lago. */
export function shotSplashes(result: TurnResult3D): Splash[] {
  const out: Splash[] = [];
  for (const d of result.damage) {
    const t = d.cause === "water" ? result.state.tanks.find((tk) => tk.id === d.targetId) : undefined;
    if (t) out.push({ x: round2(t.x), z: round2(t.z), big: true });
  }
  for (const hit of result.shot.split?.heads ?? [result.shot]) {
    if (hit.outcome === "water") out.push({ x: round2(hit.x), z: round2(hit.z), big: false });
  }
  return out;
}

/** Mensaje "burn": a un tanque le empezó el turno parado en el fuego. La vida nueva va en el estado. */
export interface BurnBroadcast {
  id: string;
  /** [hp] */
  damage: number;
  killed: boolean;
}

/**
 * Mensaje "mound": uno dejó una loma en la tienda. El piso nuevo ya salió en un "terrain"; esto es
 * para el polvo y el cartel. `y` es el piso de antes, donde se apoya el centro de la loma. [wu]
 */
export interface MoundBroadcast {
  id: string;
  x: number;
  y: number;
  z: number;
}

/** Mensaje "roundEnd": lo que cobró cada uno al terminar la ronda. */
export interface RoundEndBroadcast {
  round: number;
  survivors: string[];
  /**
   * La cuenta de cada uno: `damage` + `kill` + `water` (lo cobrado por pegar en la ronda: daño que
   * no mató, kills y kills de agua) + `survivor` + `interest` es todo lo que sumó desde que empezó la
   * ronda. `fixed` es la parte de `interest` que es el fijo, no un monto aparte.
   */
  payouts: { id: string; damage: number; kill: number; water: number; survivor: number; interest: number; fixed: number; after: number }[];
}

/** Mensaje "chat": lo que escribió uno de la sala. El nombre y el slot (el color del tanque) los pone el server. */
export interface ChatBroadcast {
  id: string;
  name: string;
  slot: number;
  text: string;
}

/** Largo máximo de un mensaje de chat. El `maxlength` del cliente es el mismo. [caracteres] */
export const CHAT_MAX = 120;

/**
 * El texto de un "chat" como lo va a ver la sala: una sola línea, sin caracteres de control ni de
 * dirección, recortada a CHAT_MAX. null si no queda nada que mostrar. Es texto plano: el cliente lo
 * pone con textContent, así que un "<b>" llega y se lee tal cual.
 */
export function chatText(message: unknown): string | null {
  const raw = (message as { text?: unknown } | null)?.text;
  if (typeof raw !== "string") return null;
  const line = raw
    .slice(0, CHAT_MAX * 8)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = [...line].slice(0, CHAT_MAX).join("").trim();
  return text || null;
}

const round2 =(v: number) => Math.round(v * 100) / 100;

export class GameRoom extends Room<{ state: GameState }> {
  /** Escala del retardo entre tiro y aplicación del resultado. Los tests la bajan. */
  static shotDelayScale = 1;
  static turnSeconds = TURN_SECONDS;
  static shopSeconds = SHOP_SECONDS;
  /** Semilla fija para tests reproducibles. null = al azar. */
  static seedOverride: number | null = null;
  /** Lo que tarda un bot en tirar o en tocar "listo". Los tests lo bajan. [ms] */
  static botDelayMs = 1500;
  /** Lo que se le guarda el asiento a uno que se cayó sin avisar. Los tests lo bajan. [s] */
  static rejoinSeconds = 60;

  maxClients = 4;
  private game = new Game(GameRoom.turnSeconds, GameRoom.shopSeconds);
  private ticker?: Delayed;
  /** La cuenta que está corriendo (fase, turno y ronda); "" si no hay ninguna. */
  private counting = "";
  private sentRoundSerial = 0;
  private sentRoundEnd: object | null = null;
  /** Asientos que son bots. */
  private readonly bots = new Set<string>();
  private botSerial = 0;
  private botRng: () => number = Math.random;
  private botPending = false;
  /** Bots a los que otro les pegó en la ronda (daño, o tiro que les gastó el escudo). Se vacía al empezar la siguiente. */
  private readonly botsHit = new Set<string>();
  /** Asientos guardados: se les cayó la conexión y todavía pueden volver. */
  private readonly away = new Set<string>();
  /** La marca de cada asiento que ya está copiada en el estado. */
  private readonly sentMarks = new Map<string, ShotMark | undefined>();

  onCreate(): void {
    this.roomId = generateCode(activeCodes);
    activeCodes.add(this.roomId);
    this.setState(new GameState());
    this.state.code = this.roomId;

    // "rematch" es el "Otra vez" del final: otra partida con los mismos asientos, sin pasar por el lobby.
    for (const type of ["start", "rematch"] as const) {
      this.onMessage(type, (client) => {
        const seed = GameRoom.seedOverride ?? Math.floor(Math.random() * 2 ** 31);
        if (!this.game[type](client.sessionId, seed)) return;
        this.botRng = createRng(seed ^ 0x51ed270b);
        void this.lock(); // nadie más entra una vez arrancada
        this.flush();
      });
    }

    this.onMessage("fillBots", (client) => {
      if (this.game.phase !== "lobby" || client.sessionId !== this.game.hostId) return;
      while (this.game.seats.length < MIN_PLAYERS) {
        const id = `bot-${++this.botSerial}`;
        this.game.addPlayer(id, BOT_NAME, "box"); // el bot usa Caja y el color de su asiento
        this.bots.add(id);
        this.log(`entra ${BOT_NAME}`);
      }
      this.flush();
    });

    this.onMessage("move", (client, message: unknown) => void this.onMove(client.sessionId, message));
    this.onMessage("fire", (client, message: unknown) => this.onFire(client.sessionId, message));
    this.onMessage("buy", (client, message: unknown) => this.onBuy(client.sessionId, message));
    this.onMessage("sell", (client, message: unknown) => {
      if (!this.game.sell(client.sessionId, message)) return; // ignorado
      this.log(`${this.nameOf(client.sessionId)} vende ${(message as { item?: string }).item}`);
      this.flush();
    });
    // Nacimiento de la ronda que viene: { at: { x, z } }, solo en la tienda. La marca va en el estado.
    this.onMessage("spawn", (client, message: unknown) => this.onSpawn(client.sessionId, message));
    // Loma en el piso: { at: { x, z } }, solo en la tienda y una por tienda. El bot no la deja (botAct).
    this.onMessage("mound", (client, message: unknown) => this.onMound(client.sessionId, message));
    this.onMessage("ready", (client) => this.onReady(client.sessionId));
    // Silueta: { hull: "box" | "flat" | "tower" }, solo en la espera.
    this.onMessage("hull", (client, message: unknown) => {
      if (!this.game.setHull(client.sessionId, (message as { hull?: unknown } | null)?.hull)) return; // ignorado
      this.flush();
    });
    // Color: { color: 0..COLOR_COUNT-1 }, solo en la espera y si nadie lo tiene.
    this.onMessage("color", (client, message: unknown) => {
      if (!this.game.setColor(client.sessionId, (message as { color?: unknown } | null)?.color)) return; // ignorado
      this.flush();
    });

    // Mapa: { map: "valley" | "island" | "hill" }, solo el anfitrión y solo antes de arrancar.
    this.onMessage("map", (client, message: unknown) => {
      if (!this.game.setMap(client.sessionId, (message as { map?: unknown } | null)?.map)) return; // ignorado
      this.log(`mapa: ${MAPS[this.game.map].name}`);
      this.flush();
    });

    // Paso de la espera: { step: 1 | 2 | 3 }, solo el anfitrión y solo antes de arrancar. Los demás ven ese paso.
    this.onMessage("lobbyStep", (client, message: unknown) => {
      if (!this.game.setLobbyStep(client.sessionId, (message as { step?: unknown } | null)?.step)) return; // ignorado
      this.flush();
    });

    // Reloj: { turn, shop, rounds }, solo el anfitrión y solo antes de arrancar. Un número inválido vuelve al de siempre.
    this.onMessage("clock", (client, message: unknown) => {
      if (!this.game.setClock(client.sessionId, message)) return; // ignorado
      this.log(`reloj: turno ${this.game.turnSeconds} s, tienda ${this.game.shopSeconds} s, ${this.game.rounds} rondas`);
      this.flush();
    });

    // Chat de sala: en cualquier fase. Sale para todos en el orden en que llegó acá; no se guarda.
    this.onMessage("chat", (client, message: unknown) => {
      const seat = this.game.seats.find((s) => s.id === client.sessionId);
      const text = chatText(message);
      if (!seat || !text) return; // ignorado
      const msg: ChatBroadcast = { id: seat.id, name: seat.name, slot: seat.slot, text };
      this.broadcast("chat", msg);
    });

    this.startClock();
  }

  /**
   * El reloj de turno y de tienda. Se rearma cada vez que empieza una cuenta (ver sync), así el
   * primer segundo dura un segundo entero: los segundos de turno y de tienda son reales.
   */
  private startClock(): void {
    this.ticker?.clear();
    this.ticker = this.clock.setInterval(() => {
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

  /** Nafta: la de la casa en el primer turno de la ronda, o una suya. false = ignorado. */
  private onMove(id: string, message: unknown): boolean {
    const house = this.game.houseLeft;
    const to = this.game.move(id, message);
    if (!to) return false;
    this.broadcast("moved", { id, ...to });
    this.log(`${this.nameOf(id)} usa nafta${house ? " de la casa" : ""} -> (${to.x.toFixed(1)}, ${to.z.toFixed(1)})`);
    this.flush();
    return true;
  }

  private onFire(id: string, message: unknown): void {
    const shot = this.game.fire(id, message);
    if (!shot) return; // ignorado
    for (const hit of [...shot.result.damage.map((d) => d.targetId), ...shot.result.blocked]) {
      if (hit !== shot.shooterId && this.bots.has(hit)) this.botsHit.add(hit);
    }
    const shotResult = shot.result.shot;
    // Lo que representa al tiro (cartel, "se fue"): él mismo, o la primera cabeza que explotó si la del medio se fue.
    const heads = shotResult.split?.heads;
    const r = heads?.find((h) => h.outcome === "ground" || h.outcome === "tank") ?? shotResult;
    const payload: ShotBroadcast = {
      shooterId: shot.shooterId,
      yaw: shot.yaw,
      pitch: shot.pitch,
      power: shot.power,
      weapon: shot.weapon,
      outcome: r.outcome,
      path: (shotResult.path ?? []).map(round2),
      durationMs: shot.durationMs,
      impact: { x: round2(r.x), y: round2(r.y), z: round2(r.z) },
      damage: round2(shot.result.damage.reduce((sum, d) => sum + d.damage, 0)),
      blocked: shot.result.blocked,
      drowned: shot.result.damage.filter((d) => d.cause === "water").map((d) => d.targetId),
      splashes: shotSplashes(shot.result),
    };
    if (heads) payload.heads = heads.map((h) => ({ path: (h.path ?? []).map(round2), outcome: h.outcome }));
    if (shotResult.bounce) payload.bounce = { tick: shotResult.bounce.tick };
    if (shotResult.landed) payload.roll = { tick: shotResult.landed.tick };
    this.flush();
    this.broadcast("shot", payload);
    const hits = shot.result.damage
      .map((d) => `${this.nameOf(d.targetId)} -${d.damage.toFixed(1)}${d.killed ? " (muere)" : ""} [${d.cause}]`)
      .concat(shot.result.blocked.map((id) => `${this.nameOf(id)} bloqueado [escudo]`))
      .join(", ");
    this.log(
      `tira ${this.nameOf(shot.shooterId)} ${shot.weapon} yaw ${shot.yaw.toFixed(0)} pitch ${shot.pitch.toFixed(0)} ` +
        `pot ${shot.power.toFixed(0)} -> ${payload.outcome} (${r.x.toFixed(1)}, ${r.z.toFixed(1)})${hits ? ` | ${hits}` : ""}`,
    );
    this.clock.setTimeout(() => {
      const before = this.game.match?.terrain;
      const serial = this.game.roundSerial;
      this.game.finishShot();
      // El cráter (o la loma) llega a todos recién ahora, junto con la vida y las posiciones nuevas.
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

  private onSpawn(id: string, message: unknown): void {
    if (!this.game.chooseSpawn(id, message)) return; // ignorado
    const at = this.game.spawns.get(id)!;
    this.log(`${this.nameOf(id)} elige nacer en (${at.x.toFixed(1)}, ${at.z.toFixed(1)})`);
    this.flush();
  }

  /** La loma de la tienda sube ya: el parche del piso sale para todos en el momento, no al abrir la ronda. */
  private onMound(id: string, message: unknown): void {
    const before = this.game.match?.terrain;
    const at = this.game.leaveMound(id, message);
    const after = this.game.match?.terrain;
    if (!at || !before || !after) return; // ignorado
    const rect = changedRect(before, after);
    if (rect) this.broadcast("terrain", terrainRect(after, rect.x0, rect.z0, rect.w, rect.d));
    const msg: MoundBroadcast = { id, x: round2(at.x), y: round2(at.y), z: round2(at.z) };
    this.broadcast("mound", msg);
    this.log(`${this.nameOf(id)} deja una loma en (${at.x.toFixed(1)}, ${at.z.toFixed(1)})`);
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
      // Con un cerro de por medio, primero sube, una vez por turno: en su primer turno de la ronda
      // con la Nafta de la casa (no la guarda), y después con la suya. El flush de onMove lo agenda
      // de nuevo y ahí tira.
      const to = g.movesThisTurn === 0 ? botMovePick(g.match, g.turnId) : null;
      if (to && this.onMove(g.turnId, { moveTo: to })) return;
      const shot = pickBotShot(g.match, g.turnId, this.botRng);
      if (shot) this.onFire(g.turnId, { yaw: shot.yaw, pitch: shot.pitch, power: shot.power, weapon: shot.weapon });
    } else if (g.phase === "shop") {
      for (const id of this.bots) {
        if (g.ready.has(id)) continue;
        const player = g.playerOf(id);
        const item = player && botShopPick(player, this.botRng, this.botsHit.has(id));
        if (item) this.onBuy(id, { item });
        // Del piso, el bot elige dónde nace y nada más: no deja loma (onMound), tenga Tierra o no.
        const at = g.match && g.pristine && botSpawnPick(g.match.terrain, g.pristine, g.spawnRivals(id));
        if (at) this.onSpawn(id, { at });
        this.onReady(id);
      }
    }
  }

  onJoin(client: Client, options?: { name?: unknown; hull?: unknown; color?: unknown }): void {
    // Un bot le deja el lugar a un humano si la sala pasaría de MAX_PLAYERS.
    const bot = [...this.bots][0];
    if (bot && this.game.phase === "lobby" && this.game.seats.length >= MAX_PLAYERS) {
      this.game.removePlayer(bot);
      this.bots.delete(bot);
      this.log(`sale ${BOT_NAME}`);
    }
    const seat = this.game.addPlayer(client.sessionId, options?.name, options?.hull, options?.color); // tira si ya empezó o está llena
    // Entró con la partida terminada, a esperar la revancha: ve el terreno como quedó.
    if (this.game.match) client.send("terrain", fullTerrain(this.game.match.terrain));
    this.sync();
    this.log(`entra ${seat.name}`);
  }

  /**
   * Se cayó sin avisar: para la partida sigue sentado (el reloj de su turno corre igual) hasta que
   * vuelva o se le venza el plazo; recién ahí pasa por onLeave. Con la partida terminada no se guarda nada.
   */
  onDrop(client: Client): void {
    if (this.game.phase === "ended") return;
    this.away.add(client.sessionId);
    // Si no se puede guardar (se cayó sin terminar de entrar, o la sala se está cerrando), sigue por onLeave.
    this.allowReconnection(client, GameRoom.rejoinSeconds).catch(() => {});
    this.log(`${this.nameOf(client.sessionId)} se cayo: se le guarda el asiento ${GameRoom.rejoinSeconds} s`);
    this.flush();
  }

  /**
   * Volvió el mismo id. El terreno y el resumen de la ronda no están en el estado: se le mandan de
   * nuevo. Y el terreno de la ronda 1 ("pristine"), que el que recargó la página ya no tiene: sin él
   * no sabe qué es hoyo cuando elige dónde nacer.
   */
  onReconnect(client: Client): void {
    this.away.delete(client.sessionId);
    const g = this.game;
    if (g.match) client.send("terrain", fullTerrain(g.match.terrain));
    if (g.pristine && g.phase !== "ended") client.send("pristine", fullTerrain(g.pristine));
    if (g.lastRound) client.send("roundEnd", this.roundEndMsg(g.lastRound));
    this.log(`vuelve ${this.nameOf(client.sessionId)}`);
    this.flush();
  }

  onLeave(client: Client): void {
    this.away.delete(client.sessionId);
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
   * Después de cada cambio: si el fuego quemó a alguien, lo avisa; si una vuelta sin daño dejó Nafta, también; si terminó una ronda, manda el
   * resumen; si empezó una, manda el terreno completo (en la ronda 1, recién generado; después, el
   * mismo piso como quedó: al cliente le sirve de aviso de ronda nueva); después sincroniza el estado.
   */
  private flush(): void {
    const g = this.game;
    for (const b of g.takeBurns()) {
      const msg: BurnBroadcast = { id: b.targetId, damage: round2(b.damage), killed: b.killed };
      this.broadcast("burn", msg);
      this.log(`${this.nameOf(b.targetId)} se quema -${b.damage.toFixed(1)}${b.killed ? " (muere)" : ""} [fuego de ${this.nameOf(b.ownerId)}]`);
    }
    // Vuelta entera sin daño: los que recibieron una Nafta. La carga va en el estado.
    const refueled = g.takeRefuel();
    if (refueled.length > 0) {
      this.broadcast("refuel", { ids: refueled });
      this.log(`vuelta sin daño: nafta para ${refueled.map((id) => this.nameOf(id)).join(", ")}`);
    }
    if (g.lastRound && g.lastRound !== this.sentRoundEnd) {
      this.sentRoundEnd = g.lastRound;
      const msg = this.roundEndMsg(g.lastRound);
      this.broadcast("roundEnd", msg);
      this.log(
        `fin de ronda ${msg.round}: ` +
          msg.payouts
            .map((p) => `${this.nameOf(p.id)} +${p.damage} daño +${p.kill} kill +${p.water} agua +${p.survivor} sobrevivir +${p.interest} interes = ${p.after}`)
            .join(", "),
      );
    }
    if (g.match && g.roundSerial !== this.sentRoundSerial) {
      this.sentRoundSerial = g.roundSerial;
      this.botsHit.clear();
      this.broadcast("terrain", fullTerrain(g.match.terrain));
      const w = g.match.wind;
      this.log(`ronda ${g.round}/${g.rounds} en ${MAPS[g.map].name}, viento (${w.x.toFixed(1)}, ${w.z.toFixed(1)})`);
    }
    const before = `${this.state.phase}:${this.state.turnId}`;
    this.sync();
    if (`${this.state.phase}:${this.state.turnId}` !== before) this.logTurn();
    // Terminada, la sala se abre de nuevo: si falta gente para la revancha, se entra con el código.
    if (g.phase === "ended" && this.locked) void this.unlock();
    this.driveBots();
  }

  private roundEndMsg(r: RoundSummary): RoundEndBroadcast {
    return {
      round: r.round,
      survivors: r.survivors,
      payouts: r.payouts.map(({ id, survivor, interest, after }) => ({
        id,
        damage: r.earned[id]?.damage ?? 0,
        kill: r.earned[id]?.kill ?? 0,
        water: r.earned[id]?.water ?? 0,
        survivor,
        interest,
        fixed: Math.min(MONEY_PER_ROUND, interest),
        after,
      })),
    };
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
    const counting = g.phase === "aiming" || g.phase === "shop" ? `${g.phase}|${g.turnId}|${g.round}` : "";
    if (counting !== this.counting) {
      this.counting = counting;
      if (counting) this.startClock();
    }
    s.phase = g.phase;
    s.hostId = g.hostId ?? "";
    s.map = g.map;
    s.lobbyStep = g.lobbyStep;
    s.turnId = g.turnId ?? "";
    s.timeLeft = g.timeLeft;
    s.round = g.round;
    s.rounds = g.rounds;
    s.turnSeconds = g.turnSeconds;
    s.shopSeconds = g.shopSeconds;
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
      p.color = seat.color;
      p.hull = seat.hull;
      p.connected = seat.connected && !this.away.has(seat.id);
      p.ready = g.ready.has(seat.id);
      // El nacimiento del que se fue no se muestra ni cuenta para la separación (Game.spawnRivals).
      const spawn = seat.connected ? g.spawns.get(seat.id) : undefined;
      p.spawnX = spawn?.x ?? -1;
      p.spawnZ = spawn?.z ?? -1;
      p.spawnPicked = spawn?.picked ?? false;
      p.mound = g.mounded.has(seat.id);
      const aim = g.aims.get(seat.id);
      if (aim) {
        p.yaw = aim.yaw;
        p.pitch = aim.pitch;
      }
      const mark = g.marks.get(seat.id);
      if (this.sentMarks.get(seat.id) !== mark) {
        this.sentMarks.set(seat.id, mark);
        p.markPath.splice(0, p.markPath.length, ...(mark?.path ?? []));
        p.markSpots.splice(0, p.markSpots.length, ...(mark?.spots ?? []));
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
        p.rollers = Math.max(0, player.inventory.roller ?? 0);
        p.napalms = Math.max(0, player.inventory.napalm ?? 0);
        p.nukes = Math.max(0, player.inventory.nuke ?? 0);
        p.dirts = Math.max(0, player.inventory.dirt ?? 0);
        p.mirvs = Math.max(0, player.inventory.mirv ?? 0);
        p.leapfrogs = Math.max(0, player.inventory.leapfrog ?? 0);
        p.shield = player.inventory.shield ?? 0;
        p.parachute = player.inventory.parachute ?? 0;
        p.fuel = player.inventory.fuel ?? 0;
        p.house = g.hasHouseFuel(seat.id);
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

    // Fuegos: dentro de una ronda solo se agregan; si hay menos que antes, es una ronda nueva.
    const fires = g.match?.fires ?? [];
    if (s.fires.length > fires.length) s.fires.clear();
    for (const f of fires.slice(s.fires.length)) {
      const fs = new FireState();
      fs.x = f.x;
      fs.z = f.z;
      fs.radius = f.radius;
      s.fires.push(fs);
    }
  }
}
