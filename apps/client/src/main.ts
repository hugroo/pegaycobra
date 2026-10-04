// SPDX-License-Identifier: GPL-2.0-or-later
// Pantallas (HTML), conexión con el server, entrada y loop de Three.js.
// El cliente manda { yaw, pitch, power, weapon }, { moveTo }, { item }, "listo" y "fillBots". Nada más:
// daño, impacto, fuego, plata y puntaje los decide el server.

import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import {
  cannotBuy,
  fireFromShot,
  FUEL_MOVE_RANGE,
  inFire,
  POWER_MAX,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  terrainHeightAt,
  validateMove,
  WEAPONS,
  type MatchState3D,
  type ShopItemId,
  type Terrain,
} from "@pegaycobra/sim";
import { play, toggleMute } from "./audio";
import { Minimap, type MiniModel } from "./minimap";
import { LINGER_MS, SLOT_COLORS, World, type GhostModel, type MoveModel, type ShotModel, type TankModel } from "./scene3d";

const ROOM_NAME = "pegaycobra";
// En el build de producción el server sirve esta web, así que el WebSocket va al mismo dominio.
// En desarrollo la web sale de Vite (5173) y el server está en el 2567.
const WS = location.protocol === "https:" ? "wss" : "ws";
const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? (import.meta.env.PROD ? `${WS}://${location.host}` : `${WS}://${location.hostname}:2567`);
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const screens = { home: $("screen-home"), lobby: $("screen-lobby"), game: $("screen-game") };
const ui = {
  name: $<HTMLInputElement>("name"),
  code: $<HTMLInputElement>("code"),
  create: $<HTMLButtonElement>("btn-create"),
  join: $<HTMLButtonElement>("btn-join"),
  homeError: $("home-error"),
  lobbyCode: $("lobby-code"),
  lobbyPlayers: $("lobby-players"),
  start: $<HTMLButtonElement>("btn-start"),
  fillBots: $<HTMLButtonElement>("btn-bots"),
  lobbyWait: $("lobby-wait"),
  lobbyLeave: $<HTMLButtonElement>("btn-lobby-leave"),
  hudRound: $("hud-round"),
  turnPill: $("turn-pill"),
  hudTurn: $("hud-turn"),
  hudTurnDot: $("hud-turn-dot"),
  hudTime: $("hud-time"),
  hudWind: $("hud-wind"),
  hudMoney: $("hud-money"),
  hudInv: $("hud-inv"),
  hudCode: $("hud-code"),
  hudPlayers: $("hud-players"),
  banner: $("banner"),
  dock: $("dock"),
  shop: $("shop"),
  shopTitle: $("shop-title"),
  shopSummary: $("shop-summary"),
  shopMoney: $("shop-money"),
  shopItems: $("shop-items"),
  ready: $<HTMLButtonElement>("btn-ready"),
  overlay: $("overlay"),
  overlayTitle: $("overlay-title"),
  overlaySub: $("overlay-sub"),
  scoresBody: $("scores-body"),
  back: $<HTMLButtonElement>("btn-back"),
  wBaby: $<HTMLButtonElement>("w-baby"),
  wMissile: $<HTMLButtonElement>("w-missile"),
  wMissileN: $("w-missile-n"),
  wRoller: $<HTMLButtonElement>("w-roller"),
  wRollerN: $("w-roller-n"),
  wNapalm: $<HTMLButtonElement>("w-napalm"),
  wNapalmN: $("w-napalm-n"),
  wNuke: $<HTMLButtonElement>("w-nuke"),
  wNukeN: $("w-nuke-n"),
  fuelBtn: $<HTMLButtonElement>("btn-fuel"),
  fuelN: $("fuel-n"),
  aimPad: $("aim-pad"),
  powerCtl: $("power-ctl"),
  yawOut: $("yaw-out"),
  pitchOut: $("pitch-out"),
  power: $<HTMLInputElement>("power"),
  powerOut: $("power-out"),
  fire: $<HTMLButtonElement>("btn-fire"),
  viewport: $("viewport"),
  minimap: $<HTMLCanvasElement>("minimap"),
};

const client = new Client(SERVER_URL);
let world: World | null = null; // se crea al entrar a la primera partida (WebGL recién ahí)
const minimap = new Minimap(ui.minimap);

let room: Room<any> | null = null;
/** Las armas que se pueden pedir en un "fire". */
type Fireable = "babyMissile" | "missile" | "roller" | "napalm" | "nuke";
let aim = { yaw: 0, pitch: 45, power: 500 };
let weapon: Fireable = "babyMissile";
let moveMode = false;
let moveHover: MoveModel["hover"] = null;
let terrain: Terrain | null = null;
let shotAnim: ShotModel | null = null;
/** Dónde terminó el último tiro real (último punto del "shot" del server). Lo usa el minimapa. */
let lastImpact: (NonNullable<MiniModel["impact"]> & { at: number }) | null = null;
let leavingOnPurpose = false;
/** Se apaga la fantasma desde que apretás Tirar hasta tu próximo turno. */
let ghostOff = false;
let lastTurnKey = "";
let bannerTimer = 0;
/** Sube con cada mensaje "terrain": invalida la fantasma cacheada. */
let terrainVersion = 0;

interface RoundEndMsg {
  round: number;
  survivors: string[];
  payouts: { id: string; survivor: number; interest: number; after: number }[];
}
let lastRoundEnd: RoundEndMsg | null = null;

try {
  ui.name.value = localStorage.getItem("pyc:name") ?? "";
} catch {
  /* sin storage */
}

const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;

// ---------------------------------------------------------------------------
// Pantallas y sala
// ---------------------------------------------------------------------------

function show(which: keyof typeof screens): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== which;
  if (which === "game") {
    world ??= new World(ui.viewport);
    world.resize();
  }
}

function setBusy(busy: boolean): void {
  ui.create.disabled = busy;
  ui.join.disabled = busy;
}

function playerName(): string {
  const n = ui.name.value.trim();
  try {
    localStorage.setItem("pyc:name", n);
  } catch {
    /* ignorado */
  }
  return n;
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|no rooms|invalid/i.test(msg)) return "No existe una sala con ese código.";
  if (/locked|full|empez|llena/i.test(msg)) return "Esa sala ya empezó o está llena.";
  if (/ECONNREFUSED|failed|network|websocket|fetch/i.test(msg)) return `No se pudo conectar al server (${SERVER_URL}).`;
  return msg;
}

async function enter(action: () => Promise<Room<any>>): Promise<void> {
  ui.homeError.textContent = "";
  setBusy(true);
  try {
    attach(await action());
  } catch (err) {
    ui.homeError.textContent = errorText(err);
  } finally {
    setBusy(false);
  }
}

ui.create.addEventListener("click", () => enter(() => client.create(ROOM_NAME, { name: playerName() })));

function joinWithCode(): void {
  const code = ui.code.value.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    ui.homeError.textContent = "El código son 4 letras (sin O ni I).";
    return;
  }
  void enter(() => client.joinById(code, { name: playerName() }));
}
ui.join.addEventListener("click", joinWithCode);
ui.code.addEventListener("input", () => (ui.code.value = ui.code.value.toUpperCase()));
ui.code.addEventListener("keydown", (e) => e.key === "Enter" && joinWithCode());
ui.start.addEventListener("click", () => room?.send("start"));
ui.fillBots.addEventListener("click", () => room?.send("fillBots"));
ui.lobbyLeave.addEventListener("click", () => void leave());
ui.back.addEventListener("click", () => void leave());
ui.ready.addEventListener("click", () => room?.send("ready"));

async function leave(): Promise<void> {
  leavingOnPurpose = true;
  const r = room;
  room = null;
  shotAnim = null;
  show("home");
  try {
    await r?.leave();
  } catch {
    /* ya estaba cerrada */
  }
}

interface TerrainMessage {
  width: number;
  depth: number;
  x0: number;
  z0: number;
  w: number;
  d: number;
  data: Uint8Array;
}

/** Aplica un mensaje "terrain": completo (ronda nueva) o solo el rectángulo del cráter. */
function onTerrain(m: TerrainMessage): void {
  if (!terrain || terrain.width !== m.width || terrain.depth !== m.depth) {
    terrain = { width: m.width, depth: m.depth, heights: new Float32Array(m.width * m.depth) };
  }
  const src = new Float32Array(m.data.slice().buffer); // copia alineada
  for (let z = 0; z < m.d; z++) {
    terrain.heights.set(src.subarray(z * m.w, (z + 1) * m.w), (m.z0 + z) * m.width + m.x0);
  }
  terrainVersion++;
  const full = m.w === m.width && m.d === m.depth;
  if (full) lastImpact = null; // ronda nueva
  world ??= new World(ui.viewport);
  world.setTerrain(terrain, full ? undefined : { x0: m.x0, z0: m.z0, w: m.w, d: m.d }, full);
}

function showBanner(text: string, ms: number): void {
  ui.banner.textContent = text;
  ui.banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => (ui.banner.hidden = true), ms);
}

function attach(r: Room<any>): void {
  room = r;
  leavingOnPurpose = false;
  shotAnim = null;
  lastImpact = null;
  terrain = null;
  ghostOff = false;
  lastTurnKey = "";
  lastRoundEnd = null;
  weapon = "babyMissile";
  moveMode = false;
  ui.lobbyCode.textContent = r.roomId;
  ui.hudCode.textContent = r.roomId;
  show("lobby");

  r.onStateChange(() => {
    if (room === r) onState();
  });
  r.onMessage("terrain", (m: TerrainMessage) => {
    if (room === r) onTerrain(m);
  });
  r.onMessage(
    "shot",
    (m: {
      path: number[];
      durationMs: number;
      shooterId: string;
      outcome: string;
      weapon: Fireable;
      impact: { x: number; y: number; z: number };
      damage: number;
      blocked: string[];
    }) => {
      const shooter = r.state.players.get(m.shooterId);
      const lands = m.outcome === "ground" || m.outcome === "tank";
      const w = WEAPONS[m.weapon] ?? WEAPONS.babyMissile;
      shotAnim = {
        path: m.path,
        durationMs: m.durationMs,
        start: performance.now(),
        slot: shooter?.slot ?? 0,
        explodes: lands,
        // El Napalm no explota: el fogonazo tiene el tamaño del disco que queda prendido.
        radius: w.burn?.radius ?? w.explosionRadius,
        impact: m.impact,
        // El número y el "bloqueado" son del server; acá solo se redondea para mostrarlo.
        label: lands && w.burn ? "fuego" : impactLabel(lands, m.damage, (m.blocked?.length ?? 0) > 0),
      };
      play("fire");
      window.setTimeout(() => {
        if (room !== r) return;
        if (lands) play("boom");
        if (m.damage > 0) play("hit");
      }, m.durationMs);
      const n = m.path.length;
      lastImpact =
        n >= 3
          ? { x: m.path[n - 3]!, z: m.path[n - 1]!, lands: shotAnim.explodes, slot: shotAnim.slot, at: shotAnim.start + m.durationMs }
          : null;
      if (m.weapon !== "babyMissile") showBanner(`${shooter?.name ?? "?"} manda ${SHOP_ITEMS[m.weapon]?.name ?? m.weapon}`, 1400);
      if (m.outcome === "offmap" || m.outcome === "timeout") {
        // Todas las pestañas reciben el mismo "shot": todas muestran que se fue.
        window.setTimeout(() => room === r && showBanner("¡Malardo, se fue!", 2500), m.durationMs);
      }
    },
  );
  r.onMessage("moved", (m: { id: string }) => {
    const p = r.state.players.get(m.id);
    if (p) showBanner(`${p.name} usó nafta`, 1400);
  });
  r.onMessage("skip", () => {
    if (room === r) showBanner("Se colgó: turno perdido", 1500);
  });
  r.onMessage("burn", (m: { id: string; damage: number; killed: boolean }) => {
    if (room !== r) return;
    // Llega pegado al final de un tiro o a un turno perdido: se suma al cartel que esté, no lo pisa.
    const text = `${r.state.players.get(m.id)?.name ?? "?"} se quema: -${Math.max(1, Math.round(m.damage))}`;
    showBanner(ui.banner.hidden ? text : `${ui.banner.textContent} · ${text}`, 2200);
    play("hit");
  });
  r.onMessage("roundEnd", (m: RoundEndMsg) => {
    lastRoundEnd = m;
  });
  r.onLeave(() => {
    if (room !== r) return;
    room = null;
    show("home");
    if (!leavingOnPurpose) ui.homeError.textContent = "Se cortó la conexión con la sala.";
  });
  onState();
}

/** Cartel en el punto de impacto: "se fue", el daño, o "bloqueado" si un escudo se comió el tiro (al Nuke no: dice el daño). */
function impactLabel(lands: boolean, damage: number, blocked: boolean): string {
  if (!lands) return "se fue";
  const hurt = damage > 0 ? `-${Math.max(1, Math.round(damage))}` : "0";
  if (!blocked) return hurt;
  return damage > 0 ? `bloqueado · ${hurt}` : "bloqueado"; // con daño: además lastimó a otro tanque
}

const isMe = (id: string) => room?.sessionId === id;
const me = (): any => room?.state.players.get(room.sessionId);

function playersInOrder(): any[] {
  if (!room) return [];
  const s = room.state;
  const out: any[] = [];
  for (const id of s.order ?? []) {
    const p = s.players.get(id);
    if (p) out.push(p);
  }
  return out;
}

function onState(): void {
  if (!room) return;
  const phase: string = room.state.phase ?? "lobby";
  if (phase === "lobby") {
    show("lobby");
    renderLobby();
    return;
  }
  if (screens.game.hidden) show("game");
  renderHud(phase);
  renderShop(phase);
  renderEnd(phase);
  // Las flechas de rivales fuera de cámara no se meten debajo de lo que esté abierto abajo.
  const open = !ui.dock.hidden ? ui.dock : !ui.shop.hidden ? ui.shop : null;
  if (world) world.edgeBottomInset = open ? open.offsetHeight + 12 : 0;
}

function renderLobby(): void {
  const s = room!.state;
  const players = playersInOrder();
  ui.lobbyPlayers.replaceChildren(
    ...players.map((p) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = SLOT_COLORS[p.slot] ?? "#ccc";
      const name = document.createElement("span");
      name.textContent = p.name + (isMe(p.id) ? " (vos)" : "");
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = p.id === s.hostId ? "anfitrión" : "";
      li.append(dot, name, tag);
      return li;
    }),
  );
  const host = isMe(s.hostId);
  ui.start.hidden = !host;
  ui.start.disabled = players.length < 2;
  // Los bots completan hasta 2: con 2 o más ya no hay nada que llenar.
  ui.fillBots.hidden = !host;
  ui.fillBots.disabled = players.length >= 2;
  ui.lobbyWait.textContent = host
    ? players.length < 2
      ? "Esperando a que entre al menos otro jugador…"
      : `${players.length} jugadores. Dale, arrancá.`
    : "Esperando a que el anfitrión arranque…";
}

function chip(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "chip";
  el.textContent = text;
  return el;
}

/** Lo que tenés y no está ya en los botones de arma o de nafta. */
function gearChips(p: any): HTMLSpanElement[] {
  const out: HTMLSpanElement[] = [];
  if (p.shield > 0) out.push(chip("Escudo"));
  if (p.parachute > 0) out.push(chip("Paracaídas"));
  return out;
}

function renderHud(phase: string): void {
  const s = room!.state;
  const players = playersInOrder();
  const turnPlayer = s.players.get(s.turnId);
  const mine = phase === "aiming" && isMe(s.turnId);
  const mp = me();
  const fires = firesOf(s);

  // En tu turno aparece la barra de tiro; en el ajeno queda solo quién juega, el tiempo y el viento.
  screens.game.classList.toggle("mine", mine);
  screens.game.classList.toggle("shopping", phase === "shop");
  if (mine && ui.dock.hidden) dockShownAt = performance.now();
  ui.dock.hidden = !mine;
  ui.turnPill.classList.toggle("mine", mine);
  ui.hudRound.textContent = `${s.round}/${s.rounds}`;
  if (phase === "ended") {
    ui.hudTurn.textContent = "Partida terminada";
  } else if (phase === "shop") {
    ui.hudTurn.textContent = "Tienda";
  } else {
    const who = turnPlayer ? turnPlayer.name : "…";
    ui.hudTurn.textContent = phase === "animating" ? `Disparo de ${who}` : mine ? "Te toca" : `Turno de ${who}`;
  }
  const playing = (phase === "aiming" || phase === "animating") && turnPlayer;
  ui.hudTurnDot.hidden = !playing;
  if (playing) ui.hudTurnDot.style.background = SLOT_COLORS[turnPlayer.slot] ?? "#888";
  ui.hudTime.parentElement!.hidden = phase !== "aiming" && phase !== "shop";
  ui.hudTime.textContent = String(s.timeLeft);
  ui.hudTime.parentElement!.classList.toggle("low", phase === "aiming" && s.timeLeft <= 5);
  const speed = Math.hypot(s.windX ?? 0, s.windZ ?? 0);
  ui.hudWind.textContent = speed < 0.05 ? "calma" : speed.toFixed(1);
  if (mp) {
    ui.hudMoney.textContent = fmtMoney(mp.money);
    ui.hudInv.replaceChildren(...gearChips(mp));
  }

  ui.hudPlayers.replaceChildren(
    ...players.map((p) => {
      const li = document.createElement("li");
      if (p.life <= 0) li.classList.add("dead");
      if (p.id === s.turnId && (phase === "aiming" || phase === "animating")) li.classList.add("turn");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = SLOT_COLORS[p.slot] ?? "#ccc";
      const name = document.createElement("span");
      name.textContent = p.name + (isMe(p.id) ? " (vos)" : "") + (p.connected ? "" : " · se fue");
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, p.life))}%`;
      fill.style.background = SLOT_COLORS[p.slot] ?? "#ccc";
      bar.append(fill);
      const life = document.createElement("span");
      life.textContent = String(Math.ceil(Math.max(0, p.life)));
      const extra = document.createElement("span");
      extra.className = "extra";
      extra.textContent =
        `${p.points} pts · M×${p.missiles}${p.rollers > 0 ? ` · R×${p.rollers}` : ""}${p.napalms > 0 ? ` · Quema×${p.napalms}` : ""}${p.nukes > 0 ? ` · Bombazo×${p.nukes}` : ""}` +
        `${p.shield > 0 ? " · escudo" : ""}${p.parachute > 0 ? " · ☂" : ""}${p.fuel > 0 ? ` · N×${p.fuel}` : ""}` +
        // Parado en un fuego (inFire, la misma cuenta del server): va a perder vida al empezar su turno.
        `${p.life > 0 && fires.some((f) => inFire(f, p)) ? " · en el fuego" : ""}`;
      li.append(dot, name, bar, life, extra);
      return li;
    }),
  );

  // Barra de controles.
  const missiles = mp?.missiles ?? 0;
  const rollers = mp?.rollers ?? 0;
  const napalms = mp?.napalms ?? 0;
  const nukes = mp?.nukes ?? 0;
  if (
    (weapon === "missile" && missiles <= 0) ||
    (weapon === "roller" && rollers <= 0) ||
    (weapon === "napalm" && napalms <= 0) ||
    (weapon === "nuke" && nukes <= 0)
  ) {
    weapon = "babyMissile";
  }
  ui.wMissileN.textContent = `×${missiles}`;
  ui.wRollerN.textContent = `×${rollers}`;
  ui.wNapalmN.textContent = `×${napalms}`;
  ui.wNukeN.textContent = `×${nukes}`;
  // Un arma sin munición no ocupa lugar en la barra.
  ui.wMissile.hidden = missiles <= 0;
  ui.wRoller.hidden = rollers <= 0;
  ui.wNapalm.hidden = napalms <= 0;
  ui.wNuke.hidden = nukes <= 0;
  for (const [btn, id] of [[ui.wBaby, "babyMissile"], [ui.wMissile, "missile"], [ui.wRoller, "roller"], [ui.wNapalm, "napalm"], [ui.wNuke, "nuke"]] as const) {
    btn.classList.toggle("on", weapon === id);
    btn.setAttribute("aria-checked", String(weapon === id));
  }
  const fuel = mp?.fuel ?? 0;
  ui.fuelN.textContent = `×${fuel}`;
  const canMove = mine && fuel > 0 && !s.moved;
  if (!canMove) moveMode = false;
  ui.fuelBtn.hidden = fuel <= 0;
  ui.fuelBtn.disabled = !canMove;
  ui.fuelBtn.classList.toggle("on", moveMode);
}

/** Qué hace cada cosa de la tienda, en una línea. La descripción larga del sim queda de tooltip. */
const SHOP_LINE: Record<ShopItemId, string> = {
  missile: `Explosión de radio ${WEAPONS.missile.explosionRadius}`,
  roller: "Rueda cuesta abajo",
  napalm: "Fuego toda la ronda",
  nuke: "El escudo no lo frena",
  shield: "Frena el próximo tiro",
  parachute: "Caer no te hace daño",
  fuel: "Mové el tanque",
};

function renderShop(phase: string): void {
  if (phase !== "shop") {
    ui.shop.hidden = true;
    return;
  }
  const s = room!.state;
  const mp = me();
  ui.shop.hidden = false;
  ui.shopTitle.textContent = `Antes de la ronda ${s.round + 1}/${s.rounds}`;

  // Resumen de la ronda y la plata de cada uno (la ven todos).
  const pay = new Map((lastRoundEnd?.payouts ?? []).map((p) => [p.id, p]));
  ui.shopSummary.replaceChildren(
    ...playersInOrder().map((p) => {
      const who = document.createElement("span");
      who.className = "who";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = SLOT_COLORS[p.slot] ?? "#ccc";
      const name = document.createElement("span");
      name.textContent = isMe(p.id) ? "Vos" : p.name;
      const money = document.createElement("b");
      money.textContent = fmtMoney(p.money);
      who.append(dot, name, money);
      const po = pay.get(p.id);
      if (po) {
        const gain = document.createElement("span");
        gain.className = "gain";
        gain.textContent = `+${fmtMoney(po.survivor + po.interest)}`;
        who.title = `${lastRoundEnd?.survivors.includes(p.id) ? "Sobrevivió · " : ""}+${fmtMoney(po.survivor)} vivo · +${fmtMoney(po.interest)} interés`;
        who.append(gain);
      }
      if (p.ready) {
        const ready = document.createElement("span");
        ready.className = "ready";
        ready.textContent = "listo";
        who.append(ready);
      }
      return who;
    }),
  );
  if (!mp) return;
  ui.shopMoney.textContent = fmtMoney(mp.money);
  ui.ready.disabled = !!mp.ready;
  ui.ready.textContent = mp.ready ? "Esperando…" : "Listo";

  // Cartas: la validación de plata es la misma del server (cannotBuy del sim). Se redibujan solo
  // si cambió la plata o el inventario, así un clic no cae sobre una carta recién reemplazada.
  const inventory = { parachute: mp.parachute, fuel: mp.fuel, missile: mp.missiles, roller: mp.rollers, napalm: mp.napalms, nuke: mp.nukes, shield: mp.shield };
  const asPlayer = { id: mp.id, money: mp.money, inventory };
  const itemsKey = `${mp.money}|${mp.parachute}|${mp.fuel}|${mp.missiles}|${mp.rollers}|${mp.napalms}|${mp.nukes}|${mp.shield}`;
  if (ui.shopItems.dataset.key === itemsKey) return;
  ui.shopItems.dataset.key = itemsKey;
  ui.shopItems.replaceChildren(
    ...(Object.keys(SHOP_ITEMS) as ShopItemId[]).map((id) => {
      const it = SHOP_ITEMS[id];
      const why = cannotBuy(asPlayer, id);
      const card = document.createElement("button");
      card.className = "item";
      card.disabled = why !== null;
      card.title = why ? `${it.description} (${why})` : it.description;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = it.name;
      if (it.pack > 1) {
        const pack = document.createElement("small");
        pack.textContent = `×${it.pack}`;
        name.append(pack);
      }
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = SHOP_LINE[id];
      const foot = document.createElement("span");
      foot.className = "foot";
      const price = document.createElement("span");
      price.className = "price";
      price.textContent = fmtMoney(it.price);
      const have = document.createElement("span");
      have.className = "have";
      // El motivo completo (el del sim) va en el tooltip; en la carta, dos palabras.
      have.textContent = why ? (mp.money < it.price ? "no alcanza" : "ya tenés") : inventory[id] > 0 ? `tenés ${inventory[id]}` : "";
      foot.append(price, have);
      card.append(name, desc, foot);
      card.addEventListener("click", () => room?.send("buy", { item: id }));
      return card;
    }),
  );
}

function renderEnd(phase: string): void {
  if (phase !== "ended") {
    ui.overlay.hidden = true;
    return;
  }
  const s = room!.state;
  const winners: string[] = [...(s.winners ?? [])];
  const winner = s.winnerId ? s.players.get(s.winnerId) : null;
  ui.overlayTitle.textContent = winner ? (isMe(winner.id) ? "¡Ganaste, buenardo!" : `Ganó ${winner.name}`) : "Empate";
  ui.overlaySub.textContent =
    s.endReason === "forfeit"
      ? "Se fueron los demás."
      : `Después de ${s.rounds} rondas, por puntos (daño + kills).`;
  const rows = playersInOrder()
    .slice()
    .sort((a, b) => b.points - a.points || b.kills - a.kills || b.damage - a.damage);
  ui.scoresBody.replaceChildren(
    ...rows.map((p, i) => {
      const tr = document.createElement("tr");
      if (winners.includes(p.id)) tr.className = "win";
      for (const v of [String(i + 1), `${p.name}${isMe(p.id) ? " (vos)" : ""}`, String(p.points), String(p.kills), String(p.damage), fmtMoney(p.money)]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      return tr;
    }),
  );
  if (ui.overlay.hidden && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  ui.overlay.hidden = false;
}

// ---------------------------------------------------------------------------
// Apuntar, elegir arma, nafta y tirar
// ---------------------------------------------------------------------------

function myTurn(): boolean {
  return !!room && room.state.phase === "aiming" && isMe(room.state.turnId);
}

function setAim(next: Partial<typeof aim>): void {
  const yaw = next.yaw ?? aim.yaw;
  aim = {
    yaw: ((Math.round(yaw) % 360) + 360) % 360,
    pitch: Math.round(Math.min(90, Math.max(0, next.pitch ?? aim.pitch))),
    power: Math.round(Math.min(POWER_MAX, Math.max(0, next.power ?? aim.power))),
  };
  ui.yawOut.textContent = `${aim.yaw}°`;
  ui.pitchOut.textContent = `${aim.pitch}°`;
  ui.power.value = String(aim.power);
  ui.powerOut.textContent = String(aim.power);
}
setAim(aim);

function selectWeapon(w: Fireable): void {
  if (!myTurn()) return;
  if (w === "missile" && (me()?.missiles ?? 0) <= 0) return;
  if (w === "roller" && (me()?.rollers ?? 0) <= 0) return;
  if (w === "napalm" && (me()?.napalms ?? 0) <= 0) return;
  if (w === "nuke" && (me()?.nukes ?? 0) <= 0) return;
  weapon = w;
  onState();
}
ui.wBaby.addEventListener("click", () => selectWeapon("babyMissile"));
ui.wMissile.addEventListener("click", () => selectWeapon("missile"));
ui.wRoller.addEventListener("click", () => selectWeapon("roller"));
ui.wNapalm.addEventListener("click", () => selectWeapon("napalm"));
ui.wNuke.addEventListener("click", () => selectWeapon("nuke"));

function toggleMoveMode(): void {
  if (!myTurn() || (me()?.fuel ?? 0) <= 0 || room?.state.moved) return;
  moveMode = !moveMode;
  moveHover = null;
  onState();
}
ui.fuelBtn.addEventListener("click", toggleMoveMode);

function fire(): void {
  if (!myTurn() || !room) return;
  room.send("fire", { yaw: aim.yaw, pitch: aim.pitch, power: aim.power, weapon });
  ghostOff = true;
  moveMode = false;
  ui.fire.blur();
}
/** Cuándo apareció la barra de tiro. Tirar queda donde un instante antes estaba la tienda. */
let dockShownAt = 0;
// Un toque que venía para una carta de la tienda y cae sobre Tirar recién aparecido no es un tiro.
ui.fire.addEventListener("click", () => {
  if (performance.now() - dockShownAt > 500) fire();
});
ui.power.addEventListener("input", () => setAim({ power: Number(ui.power.value) }));

// Pantalla chica (teléfono): giro y elevación van en el control de la izquierda, la potencia en el
// de la derecha, y en el cerro un dedo solo toca; la cámara es de dos dedos. Misma consulta que el CSS.
const compact = window.matchMedia("(max-width: 760px), (pointer: coarse) and (max-height: 520px)");

/** Para que arrastrar a la derecha mueva la punta del cañón hacia la derecha de la pantalla. */
function yawSign(): number {
  if (!world) return 1;
  const r = world.screenRight();
  const y = (aim.yaw * Math.PI) / 180;
  return -Math.sin(y) * r.x + Math.cos(y) * r.z >= 0 ? 1 : -1;
}

/** Control de arrastre relativo: importa cuánto se mueve el dedo, no dónde apoya. Solo en pantalla chica. */
function relDrag(el: HTMLElement, onDelta: (dx: number, dy: number) => void): void {
  let held: { id: number; x: number; y: number } | null = null;
  el.addEventListener("pointerdown", (e) => {
    if (!compact.matches || held) return;
    held = { id: e.pointerId, x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
    el.classList.add("held");
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (held?.id !== e.pointerId) return;
    onDelta(e.clientX - held.x, e.clientY - held.y);
    held.x = e.clientX;
    held.y = e.clientY;
  });
  const end = (e: PointerEvent) => {
    if (held?.id !== e.pointerId) return;
    held = null;
    el.classList.remove("held");
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// Lo que el dedo movió y todavía no llega a un grado (o a un paso de potencia): se guarda, así
// arrastrar despacio ajusta fino en vez de no hacer nada.
const padRest = { yaw: 0, pitch: 0, power: 0 };
relDrag(ui.aimPad, (dx, dy) => {
  if (!myTurn()) return;
  padRest.yaw += yawSign() * dx * 0.4;
  padRest.pitch -= dy * 0.3;
  const dYaw = Math.trunc(padRest.yaw);
  const dPitch = Math.trunc(padRest.pitch);
  padRest.yaw -= dYaw;
  padRest.pitch -= dPitch;
  if (dYaw || dPitch) setAim({ yaw: aim.yaw + dYaw, pitch: aim.pitch + dPitch });
});
const POWER_STEP = Number(ui.power.step);
relDrag(ui.powerCtl, (dx) => {
  if (!myTurn()) return;
  padRest.power += dx * 2.5;
  const steps = Math.trunc(padRest.power / POWER_STEP);
  padRest.power -= steps * POWER_STEP;
  if (steps) setAim({ power: aim.power + steps * POWER_STEP });
});

/** Estado mínimo del sim armado con lo que llega del server, para validar la nafta en el cliente. */
function simView(): MatchState3D | null {
  if (!room || !terrain) return null;
  const ps = playersInOrder();
  return {
    terrain,
    wind: { x: room.state.windX, z: room.state.windZ },
    tanks: ps.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, life: p.life })),
    players: ps.map((p) => ({ id: p.id, money: p.money, inventory: { fuel: p.fuel } })),
  };
}

function pickGround(e: PointerEvent): { x: number; z: number } | null {
  if (!world) return null;
  const rect = ui.viewport.getBoundingClientRect();
  const hit = world.pick(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  return hit ? { x: hit.x, z: hit.z } : null;
}

// Mouse: izquierdo arrastra el cañón (horizontal = giro, vertical = elevación); en modo nafta,
// un clic en el piso elige el destino. Derecho orbita la cámara. Rueda = potencia en tu turno.
// Dedo en pantalla chica: uno solo toca (destino de la nafta); dos orbitan y, al separarse, hacen zoom.
let drag: { button: number; x: number; y: number; moved: number } | null = null;
const fingers = new Map<number, { x: number; y: number }>();
/** El toque de un solo dedo, mientras no se le sume otro. */
let tap: { id: number; moved: number } | null = null;
const byFinger = (e: PointerEvent) => compact.matches && e.pointerType !== "mouse";

/** Clic (o toque) en el piso con la nafta elegida: mueve el tanque si el sim lo deja. */
function moveTo(e: PointerEvent): void {
  if (!moveMode || !myTurn() || !room) return;
  const to = pickGround(e);
  const view = simView();
  if (!to || !view) return;
  const check = validateMove(view, room.sessionId, to);
  if (!check.ok) {
    showBanner(`No: ${check.reason}`, 1500);
    return;
  }
  room.send("move", { moveTo: to });
  moveMode = false;
  moveHover = null;
}

ui.viewport.addEventListener("contextmenu", (e) => e.preventDefault());
ui.viewport.addEventListener("pointerdown", (e) => {
  ui.viewport.setPointerCapture(e.pointerId);
  if (byFinger(e)) {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tap = fingers.size === 1 ? { id: e.pointerId, moved: 0 } : null;
    return;
  }
  drag = { button: e.button, x: e.clientX, y: e.clientY, moved: 0 };
  ui.viewport.classList.add("dragging");
});
ui.viewport.addEventListener("pointerup", (e) => {
  if (fingers.delete(e.pointerId)) {
    const wasTap = tap?.id === e.pointerId && tap.moved < 12;
    tap = null;
    if (wasTap) moveTo(e);
    return;
  }
  const wasClick = drag && drag.button === 0 && drag.moved < 5;
  drag = null;
  ui.viewport.classList.remove("dragging");
  if (wasClick) moveTo(e);
});
ui.viewport.addEventListener("pointercancel", (e) => {
  if (fingers.delete(e.pointerId)) {
    tap = null;
    return;
  }
  drag = null;
  ui.viewport.classList.remove("dragging");
});
ui.viewport.addEventListener("pointermove", (e) => {
  const finger = fingers.get(e.pointerId);
  if (finger) {
    const dx = e.clientX - finger.x;
    const dy = e.clientY - finger.y;
    const [a, b] = [...fingers.values()];
    const before = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    finger.x = e.clientX;
    finger.y = e.clientY;
    if (tap) tap.moved += Math.abs(dx) + Math.abs(dy);
    if (!a || !b || !world) return;
    // La cámara sigue al punto medio entre los dos dedos; la distancia entre ellos es el zoom.
    world.orbit((dx / 2) * 0.006, (dy / 2) * 0.005);
    const after = Math.hypot(a.x - b.x, a.y - b.y);
    if (before > 0 && after > 0) world.zoom(before / after);
    return;
  }
  if (moveMode && myTurn() && room && !drag) {
    const to = pickGround(e);
    const view = simView();
    if (to && view) {
      const ok = validateMove(view, room.sessionId, to).ok;
      moveHover = { x: to.x, y: terrainHeightAt(view.terrain, to.x, to.z), z: to.z, ok };
    } else moveHover = null;
  }
  if (!drag || !world) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  if (drag.button === 0 && myTurn() && !moveMode) {
    setAim({ yaw: aim.yaw + yawSign() * dx * 0.35, pitch: aim.pitch - dy * 0.3 });
  } else if (drag.button === 2 || drag.button === 1 || (drag.button === 0 && !myTurn())) {
    world.orbit(dx * 0.006, dy * 0.005);
  }
});
ui.viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (!world) return;
    if (myTurn() && !e.shiftKey) setAim({ power: aim.power - Math.sign(e.deltaY) * 20 });
    else world.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  if (screens.game.hidden) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
  if (e.key === "+" || e.key === "=") return world?.zoom(1 / 1.15);
  if (e.key === "-") return world?.zoom(1.15);
  if (e.key === "m" || e.key === "M") return showBanner(toggleMute() ? "Sonido cortado (M)" : "Sonido activado (M)", 1200);
  if (!myTurn()) return;
  if (e.target instanceof HTMLButtonElement) e.target.blur();
  const step = e.shiftKey ? 5 : 1;
  switch (e.key) {
    case "ArrowLeft":
      setAim({ yaw: aim.yaw + 2 * step });
      break;
    case "ArrowRight":
      setAim({ yaw: aim.yaw - 2 * step });
      break;
    case "ArrowUp":
      setAim({ pitch: aim.pitch + step });
      break;
    case "ArrowDown":
      setAim({ pitch: aim.pitch - step });
      break;
    case "PageUp":
      setAim({ power: aim.power + 10 * step });
      break;
    case "PageDown":
      setAim({ power: aim.power - 10 * step });
      break;
    case "1":
      selectWeapon("babyMissile");
      break;
    case "2":
      selectWeapon("missile");
      break;
    case "3":
      selectWeapon("roller");
      break;
    case "4":
      selectWeapon("napalm");
      break;
    case "5":
      selectWeapon("nuke");
      break;
    case "n":
    case "N":
      toggleMoveMode();
      break;
    case "Escape":
      moveMode = false;
      onState();
      break;
    case " ":
    case "Enter":
      fire();
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** Los fuegos de la ronda, como llegan en el estado: discos { x, z, radius } en el piso. */
function firesOf(s: any): { x: number; z: number; radius: number }[] {
  return Array.from(s.fires ?? [], (f: any) => ({ x: f.x, z: f.z, radius: f.radius }));
}

/**
 * Fantasma: el mismo simulateWeaponShot3D que usa el server, corrido acá solo para dibujar. Con el
 * Roller el recorrido sigue por el piso hasta donde termina la rodada. Con el Napalm el anillo es
 * el disco que quedaría prendido, sacado del mismo fireFromShot que usa el server.
 * Se recalcula únicamente cuando cambia la puntería, el arma, el terreno o la posición.
 */
let ghostKey = "";
let ghostCache: GhostModel | null = null;
function computeGhost(mine: TankModel | undefined, tanks: TankModel[], wind: { x: number; z: number }): GhostModel | null {
  if (!terrain || !mine || ghostOff || !myTurn() || mine.life <= 0) return null;
  const w = WEAPONS[weapon];
  const key = `${aim.yaw}|${aim.pitch}|${aim.power}|${weapon}|${mine.x}|${mine.y}|${mine.z}|${wind.x}|${wind.z}|${terrainVersion}`;
  if (key !== ghostKey) {
    ghostKey = key;
    const r = simulateWeaponShot3D(
      terrain,
      w,
      { originX: mine.x, originY: mine.y, originZ: mine.z, yaw: aim.yaw, pitch: aim.pitch, power: aim.power, wind, shooterId: mine.id },
      tanks.filter((t) => t.life > 0),
      { recordPath: true },
    );
    const lands = r.outcome === "ground" || r.outcome === "tank";
    const fire = fireFromShot(w, r, mine.id);
    ghostCache = {
      path: r.path ?? [],
      // El fuego queda en el piso aunque el tiro haya pegado en un tanque, más arriba.
      impact: fire ? { x: fire.x, y: terrainHeightAt(terrain, fire.x, fire.z), z: fire.z } : lands ? { x: r.x, y: r.y, z: r.z } : null,
      gone: !lands,
      shooter: mine,
      radius: fire ? fire.radius : w.explosionRadius,
    };
  }
  if (ghostCache) ghostCache.shooter = mine;
  return ghostCache;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!room || screens.game.hidden || !world || !world.hasTerrain) return;
  const s = room.state;
  const mine = myTurn();

  // Al empezar un turno: si es el mío, el cañón arranca donde lo dejé y la cámara se pone detrás.
  const turnKey = `${s.round}:${s.phase}:${s.turnId}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    if (s.phase === "aiming") {
      if (mine) play("turn");
      ghostOff = false;
      moveMode = false;
      const tp = s.players.get(s.turnId);
      if (tp) {
        if (mine) setAim({ yaw: tp.yaw, pitch: tp.pitch });
        world.lookAlong(mine ? aim.yaw : tp.yaw);
      }
    }
  }

  const tanks: TankModel[] = playersInOrder().map((p) => ({
    id: p.id,
    name: p.name,
    slot: p.slot,
    x: p.x,
    y: p.y,
    z: p.z,
    life: p.life,
    shield: p.shield > 0,
    yaw: mine && isMe(p.id) ? aim.yaw : p.yaw,
    pitch: mine && isMe(p.id) ? aim.pitch : p.pitch,
    isTurn: (s.phase === "aiming" || s.phase === "animating") && p.id === s.turnId,
    isMe: isMe(p.id),
  }));
  const wind = { x: s.windX ?? 0, z: s.windZ ?? 0 };
  if (shotAnim && now - shotAnim.start > shotAnim.durationMs + LINGER_MS && s.phase !== "animating") shotAnim = null;

  const myTank = tanks.find((t) => t.isMe);
  const ghost = moveMode ? null : computeGhost(myTank, tanks, wind);
  const fires = firesOf(s);
  world.render({
    tanks,
    ghost,
    shot: shotAnim,
    wind,
    fires,
    move: moveMode && myTank ? { center: { x: myTank.x, z: myTank.z }, range: FUEL_MOVE_RANGE, hover: moveHover } : null,
    now,
  });

  // Minimapa: mismo terreno, mismos tanques y el mismo "shot" que la vista 3D.
  let ball: MiniModel["ball"] = null;
  if (shotAnim && shotAnim.path.length >= 3 && now < shotAnim.start + shotAnim.durationMs) {
    const n = shotAnim.path.length / 3;
    const i = Math.min(n - 1, Math.floor(((now - shotAnim.start) / Math.max(1, shotAnim.durationMs)) * (n - 1)));
    ball = { x: shotAnim.path[i * 3]!, z: shotAnim.path[i * 3 + 2]! };
  }
  minimap.draw({
    terrain: terrain!,
    terrainVersion,
    tanks: tanks.map((t) => ({ x: t.x, z: t.z, slot: t.slot, alive: t.life > 0, isMe: t.isMe })),
    wind,
    fires,
    ghost: ghost ? { path: ghost.path, lands: !ghost.gone, slot: ghost.shooter.slot } : null,
    ball,
    impact: lastImpact && now >= lastImpact.at ? lastImpact : null,
  });
}
requestAnimationFrame(frame);

// Solo en `pnpm dev`: deja leer el estado desde la consola para depurar. No existe en el build.
if (import.meta.env.DEV) {
  (window as unknown as { __pyc: object }).__pyc = {
    get room() {
      return room;
    },
    get terrain() {
      return terrain;
    },
    get world() {
      return world;
    },
    get aim() {
      return { ...aim, weapon };
    },
  };
}
