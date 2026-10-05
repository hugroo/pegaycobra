// SPDX-License-Identifier: GPL-2.0-or-later
// Pantallas (HTML), conexión con el server, entrada y loop de Three.js.
// El cliente manda { yaw, pitch, power, weapon }, { moveTo }, { item }, { at } (dónde nacer), "listo",
// "fillBots" y el texto del chat. Nada más: daño, impacto, fuego, plata y puntaje los decide el server.

import "./style.css";
import { Client, type Room } from "@colyseus/sdk";
import {
  cannotBuy,
  cannotSell,
  sellUnits,
  sellValue,
  fireFromShot,
  FUEL_MOVE_RANGE,
  inFire,
  onShore,
  PARACHUTE_LINE,
  POWER_MAX,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  TANK_MIN_SEPARATION_3D,
  terrainHeightAt,
  validateMove,
  validateMound,
  validateSpawn,
  WEAPONS,
  type MapId,
  type MatchState3D,
  type ShopItemId,
  type Terrain,
} from "@pegaycobra/sim";
import { fireSfx, play, toggleMute } from "./audio";
import { Minimap, type MiniModel } from "./minimap";
import { LINGER_MS, TANK_COLORS, World, type GhostModel, type Hull, type MarkModel, type MoveModel, type ShotModel, type SpawnModel, type TankModel } from "./scene3d";

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
  lobbyNav: $("lobby-nav"),
  lobbyBack: $<HTMLButtonElement>("btn-lobby-back"),
  lobbyNext: $<HTMLButtonElement>("btn-lobby-next"),
  ownTank: $<HTMLButtonElement>("btn-own-tank"),
  hulls: $("hulls"),
  colors: $("colors"),
  mapsHead: $("maps-head"),
  maps: $("maps"),
  mapHint: $("map-hint"),
  clockHead: $("clock-head"),
  clockHint: $("clock-hint"),
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
  corner: $("corner"),
  playersToggle: $<HTMLButtonElement>("players-toggle"),
  banner: $("banner"),
  tip: $("tip"),
  payout: $("payout"),
  dock: $("dock"),
  shop: $("shop"),
  shopTitle: $("shop-title"),
  shopSummary: $("shop-summary"),
  shopMoney: $("shop-money"),
  shopItems: $("shop-items"),
  mound: $<HTMLButtonElement>("btn-mound"),
  ready: $<HTMLButtonElement>("btn-ready"),
  overlay: $("overlay"),
  endCode: $("end-code"),
  overlayTitle: $("overlay-title"),
  overlaySub: $("overlay-sub"),
  scoresBody: $("scores-body"),
  scoresWrap: $("scores-wrap"),
  overlayWait: $("overlay-wait"),
  again: $<HTMLButtonElement>("btn-again"),
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
  wDirt: $<HTMLButtonElement>("w-dirt"),
  wDirtN: $("w-dirt-n"),
  wMirv: $<HTMLButtonElement>("w-mirv"),
  wMirvN: $("w-mirv-n"),
  wLeapfrog: $<HTMLButtonElement>("w-leapfrog"),
  wLeapfrogN: $("w-leapfrog-n"),
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
  chat: $("chat"),
  chatLog: $("chat-log"),
  chatForm: $<HTMLFormElement>("chat-form"),
  chatInput: $<HTMLInputElement>("chat-input"),
  chatToggle: $<HTMLButtonElement>("chat-toggle"),
};

const client = new Client(SERVER_URL);
let world: World | null = null; // se crea al entrar a la primera partida (WebGL recién ahí)
const minimap = new Minimap(ui.minimap);

let room: Room<any> | null = null;
/** Las armas que se pueden pedir en un "fire". */
type Fireable = "babyMissile" | "missile" | "roller" | "napalm" | "nuke" | "dirt" | "mirv" | "leapfrog";
let aim = { yaw: 0, pitch: 45, power: 500 };
let weapon: Fireable = "babyMissile";
let moveMode = false;
let moveHover: MoveModel["hover"] = null;
let terrain: Terrain | null = null;
/** El terreno de la ronda 1 de la partida en curso, sin tocar: contra él se ve qué es hoyo (validateSpawn). */
let pristine: Terrain | null = null;
/** Tienda: el punto del piso bajo el cursor, donde nacería en la ronda que viene. */
let spawnHover: MoveModel["hover"] = null;
/** Tienda: el próximo toque en el piso deja la loma, no elige el nacimiento. Se prende con su botón. */
let moundMode = false;
let shotAnim: ShotModel | null = null;
/** Dónde terminó el último tiro real (último punto del "shot" del server; con un Racimo, el de cada cabeza). Lo usa el minimapa. */
let lastImpact: { spots: MiniModel["impacts"]; at: number } | null = null;
/**
 * Marca del último tiro de cada tanque, como está en el estado (la arma el server: todas las pestañas
 * ven la misma). El mismo objeto mientras no cambie, así la escena no rearma la línea en cada frame.
 */
let marks: MarkModel[] = [];
const markKeys = new Map<string, string>();
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
  /** `fixed` es la parte de `interest` que es el fijo; lo demás se suma tal cual. */
  payouts: { id: string; damage: number; kill: number; water: number; survivor: number; interest: number; fixed: number; after: number }[];
}
let lastRoundEnd: RoundEndMsg | null = null;

try {
  ui.name.value = localStorage.getItem("pyc:name") ?? "";
} catch {
  /* sin storage */
}

// ---------------------------------------------------------------------------
// Silueta del tanque: se elige en la espera, se guarda en el navegador y se manda al entrar.
// ---------------------------------------------------------------------------

const HULLS: readonly Hull[] = ["box", "flat", "tower"];
const HULL_KEY = "pyc:hull";

/** De costado, con el cañón a la derecha: lo mismo que se ve en el cerro. Se pinta con currentColor. */
const HULL_SVG: Record<Hull, string> = {
  box:
    '<rect x="5" y="21" width="30" height="6" rx="3" opacity=".55"/><rect x="7" y="13" width="26" height="8"/>' +
    '<path d="M14 13a6 6 0 0 1 12 0z"/><path d="M20 10L36 4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  flat:
    '<rect x="1" y="23" width="38" height="4" rx="2" opacity=".55"/><rect x="2" y="19" width="36" height="4"/>' +
    '<path d="M10 19a10 4 0 0 1 20 0z"/><path d="M20 16L37 11" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  tower:
    '<rect x="8" y="21" width="24" height="6" rx="3" opacity=".55"/><rect x="9" y="14" width="22" height="7" rx="2"/>' +
    '<rect x="11" y="3" width="3.5" height="11"/><rect x="9.5" y="0" width="6.5" height="3.5"/>' +
    '<path d="M16 14a4.5 4.5 0 0 1 9 0z"/><path d="M20.5 11L36 5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
};

function hullSvg(hull: Hull): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 40 28");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = HULL_SVG[hull];
  return svg;
}

const asHull = (raw: unknown): Hull => (HULLS.includes(raw as Hull) ? (raw as Hull) : "box");

let myHull: Hull = "box";
try {
  myHull = asHull(localStorage.getItem(HULL_KEY));
} catch {
  /* sin storage: Caja */
}

function paintHullPicker(shown: Hull = myHull): void {
  for (const btn of ui.hulls.querySelectorAll<HTMLButtonElement>("[data-hull]")) {
    btn.setAttribute("aria-checked", String(btn.dataset.hull === shown));
  }
}

for (const btn of ui.hulls.querySelectorAll<HTMLButtonElement>("[data-hull]")) {
  btn.prepend(hullSvg(asHull(btn.dataset.hull)));
  btn.addEventListener("click", () => {
    myHull = asHull(btn.dataset.hull);
    try {
      localStorage.setItem(HULL_KEY, myHull);
    } catch {
      /* ignorado */
    }
    paintHullPicker();
    room?.send("hull", { hull: myHull });
  });
}
paintHullPicker();

// Color del tanque: igual que la silueta. Sin nada guardado no se manda y el server da el del asiento.
const COLOR_KEY = "pyc:color";
const COLOR_NAMES = ["Rojo", "Azul", "Verde", "Rosa", "Amarillo", "Naranja", "Violeta", "Turquesa"];

let myColor: number | null = null;
try {
  const saved = localStorage.getItem(COLOR_KEY);
  const n = Number(saved);
  if (saved !== null && saved !== "" && Number.isInteger(n) && n >= 0 && n < TANK_COLORS.length) myColor = n;
} catch {
  /* sin storage: el del asiento */
}

const colorBtns = TANK_COLORS.map((hex, i) => {
  const btn = document.createElement("button");
  btn.className = "color";
  btn.setAttribute("role", "radio");
  btn.setAttribute("aria-label", COLOR_NAMES[i] ?? hex);
  btn.style.setProperty("--c", hex);
  btn.addEventListener("click", () => {
    myColor = i;
    try {
      localStorage.setItem(COLOR_KEY, String(i));
    } catch {
      /* ignorado */
    }
    room?.send("color", { color: i }); // el botón se marca cuando el server lo confirma en el estado
  });
  return btn;
});
ui.colors.append(...colorBtns);

/** Marca el color que tengo en la sala y apaga los que ya tiene otro. */
function paintColorPicker(shown: number, taken: ReadonlySet<number>): void {
  colorBtns.forEach((btn, i) => {
    btn.setAttribute("aria-checked", String(i === shown));
    btn.disabled = taken.has(i);
    btn.title = (COLOR_NAMES[i] ?? "") + (taken.has(i) ? " (ya lo tiene otro)" : "");
  });
}

// Mapa: lo elige el anfitrión en la espera y los demás lo ven. El marcado es siempre el del estado.
// Cada dibujo es el mapa visto de arriba, con los colores del paisaje (landscape.ts).
const MAP_SVG: Record<MapId, string> = {
  valley:
    '<rect width="40" height="28" fill="#1f9ea8"/><rect x="5" y="4" width="30" height="20" rx="7" fill="#cdbf96"/>' +
    '<rect x="6.5" y="5.5" width="27" height="17" rx="6" fill="#9e8549"/><ellipse cx="15" cy="16" rx="6" ry="3.5" fill="#34542f"/>' +
    '<ellipse cx="26" cy="11" rx="5" ry="3" fill="#34542f"/>',
  island:
    '<rect width="40" height="28" fill="#1f9ea8"/><circle cx="20" cy="14" r="10" fill="#58cbc2"/><circle cx="20" cy="14" r="8.5" fill="#cdbf96"/>' +
    '<circle cx="20" cy="14" r="5.5" fill="#34542f"/><circle cx="20" cy="14" r="3.2" fill="#7f8187"/><circle cx="20" cy="14" r="1.6" fill="#f3f6fa"/>',
  hill:
    '<rect width="40" height="28" fill="#9e8549"/>' +
    [[9, 9, 7], [29, 8, 6], [20, 19, 8], [34, 21, 5], [5, 23, 4.5]]
      .map(
        ([x, y, r]) =>
          `<circle cx="${x}" cy="${y}" r="${r}" fill="#34542f"/><circle cx="${x}" cy="${y}" r="${r! * 0.62}" fill="#7f8187"/>` +
          `<circle cx="${x}" cy="${y}" r="${r! * 0.34}" fill="#f3f6fa"/>`,
      )
      .join(""),
};

const mapBtns = [...ui.maps.querySelectorAll<HTMLButtonElement>("[data-map]")];
for (const btn of mapBtns) {
  const id = btn.dataset.map as MapId;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 40 28");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = MAP_SVG[id];
  btn.prepend(svg);
  btn.addEventListener("click", () => room?.send("map", { map: id })); // se marca cuando el server lo confirma en el estado
}

/** Marca el mapa de la sala. Solo el anfitrión puede tocarlo. */
function paintMapPicker(shown: string, host: boolean): void {
  for (const btn of mapBtns) {
    btn.setAttribute("aria-checked", String(btn.dataset.map === shown));
    btn.disabled = !host;
    // En el teléfono no hay tooltip: la línea del elegido va escrita abajo (style.css la muestra solo ahí).
    if (btn.dataset.map === shown) ui.mapHint.textContent = btn.title;
  }
  ui.mapsHead.textContent = host ? "Mapa" : "Mapa · lo elige el anfitrión";
}

// Reloj: turno, tienda y rondas. Los escribe el anfitrión en la espera y los demás ven el número.
// Acá no se valida nada: va lo escrito y el server decide; lo que quedó es siempre lo del estado.
const CLOCK_FIELDS = { turn: "turnSeconds", shop: "shopSeconds", rounds: "rounds" } as const;
type ClockKey = keyof typeof CLOCK_FIELDS;
const clockInputs = [...document.querySelectorAll<HTMLInputElement>("[data-clock]")];
/** Lo escrito en un campo, como número; vacío o con letras, null (el server pone el de siempre). */
const typedNumber = (input: HTMLInputElement): number | null => (/^\d+$/.test(input.value.trim()) ? Number(input.value) : null);

for (const input of clockInputs) {
  input.addEventListener("input", () => {
    room?.send("clock", Object.fromEntries(clockInputs.map((el) => [el.dataset.clock, typedNumber(el)])));
  });
  // Al entrar queda marcado lo que hay: se escribe encima, sin borrar antes (con dos cifras el campo ya está lleno).
  input.addEventListener("focus", () => {
    if (!input.readOnly) input.select();
  });
  // Al salir del campo se ve lo que quedó: si escribió 99, vuelve el 20.
  input.addEventListener("blur", () => {
    if (room) input.value = String(room.state[CLOCK_FIELDS[input.dataset.clock as ClockKey]]);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
}

/** Muestra el reloj de la sala. El campo en el que el anfitrión está escribiendo no se pisa. */
function paintClock(s: any, host: boolean): void {
  for (const input of clockInputs) {
    input.readOnly = !host;
    if (host && document.activeElement === input) continue;
    input.value = String(s[CLOCK_FIELDS[input.dataset.clock as ClockKey]]);
  }
  ui.clockHead.textContent = host ? "Reloj" : "Reloj · lo escribe el anfitrión";
  ui.clockHint.hidden = !host;
}

// Espera por pasos: 1 tanque, 2 mapa, 3 reloj. El paso es el del anfitrión (state.lobbyStep): él pasa
// con Atrás y Siguiente y los demás ven el suyo. El tanque es de cada uno: el que no es anfitrión
// puede abrir el paso 1 por su cuenta (ownTank) aunque el anfitrión ya esté en otro.
const LOBBY_STEPS = 3;
const stepMarks = [...document.querySelectorAll<HTMLElement>("#lobby-steps [data-step]")];
const stepPanels = [...document.querySelectorAll<HTMLElement>("[data-step-panel]")];
let ownTank = false;
const lobbyStep = (): number => Math.min(LOBBY_STEPS, Math.max(1, Number(room?.state.lobbyStep) || 1));

ui.lobbyBack.addEventListener("click", () => room?.send("lobbyStep", { step: lobbyStep() - 1 })); // se pasa cuando el server lo confirma en el estado
ui.lobbyNext.addEventListener("click", () => room?.send("lobbyStep", { step: lobbyStep() + 1 }));
ui.ownTank.addEventListener("click", () => {
  ownTank = !ownTank;
  if (room) renderLobby();
});

/** Muestra un solo paso y los botones que le tocan a cada uno. Arrancar aparece solo en el último. */
function paintSteps(host: boolean): void {
  const step = lobbyStep();
  if (host || step === 1) ownTank = false;
  const shown = ownTank ? 1 : step;
  for (const li of stepMarks) {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", n < step);
    if (n === step) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  }
  for (const panel of stepPanels) panel.hidden = Number(panel.dataset.stepPanel) !== shown;
  ui.lobbyBack.hidden = !host || step === 1;
  ui.lobbyNext.hidden = !host || step === LOBBY_STEPS;
  ui.start.hidden = !host || step !== LOBBY_STEPS;
  ui.ownTank.hidden = host || step === 1;
  ui.ownTank.textContent = ownTank ? "Volver al paso del anfitrión" : "Cambiar mi tanque";
  ui.lobbyNav.hidden = !host && step === 1;
}

/** Con lo que se entra a una sala: nombre, silueta y, si eligió, color. */
const joinOptions = () => ({ name: playerName(), hull: myHull, ...(myColor === null ? {} : { color: myColor }) });

/** Lo que tarda el chapuzón de un ahogado después de que cae el tiro: lo mismo que el server en bajar el piso. [ms] */
const DROWN_DELAY_MS = 250;

// El asiento: al entrar a una sala se guarda su token de reconexión (sala + asiento). Si la página se
// refresca, con eso se vuelve al mismo tanque. La clave lleva un id de pestaña (sessionStorage), así
// dos pestañas del mismo navegador no se pisan el asiento.
const SEAT_PREFIX = "pyc:seat:";
const SEAT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
let seatKey = "";
try {
  let tab = sessionStorage.getItem("pyc:tab");
  if (!tab) sessionStorage.setItem("pyc:tab", (tab = Math.random().toString(36).slice(2, 10)));
  seatKey = SEAT_PREFIX + tab;
} catch {
  /* sin storage: un refresco te saca de la sala, como antes */
}

function saveSeat(r: Room<any>): void {
  try {
    if (seatKey) localStorage.setItem(seatKey, JSON.stringify({ token: r.reconnectionToken, at: Date.now() }));
  } catch {
    /* ignorado */
  }
}

function clearSeat(): void {
  try {
    if (seatKey) localStorage.removeItem(seatKey);
  } catch {
    /* ignorado */
  }
}

/** El asiento guardado de esta pestaña. De paso tira los de pestañas que se cerraron hace rato. */
function savedSeat(): string | null {
  try {
    let mine: string | null = null;
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(SEAT_PREFIX)) continue;
      let seat: { token?: unknown; at?: unknown } = {};
      try {
        seat = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
      } catch {
        /* guardado roto: se borra abajo */
      }
      const fresh = typeof seat.token === "string" && typeof seat.at === "number" && Date.now() - seat.at < SEAT_MAX_AGE_MS;
      if (!fresh) localStorage.removeItem(key);
      else if (key === seatKey) mine = seat.token as string;
    }
    return mine;
  } catch {
    return null;
  }
}

/** La página se está yendo (refresco o cierre): el corte que viene no es para borrar el asiento. */
let unloading = false;
window.addEventListener("pagehide", () => (unloading = true));

const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;

// ---------------------------------------------------------------------------
// Pantallas y sala
// ---------------------------------------------------------------------------

function show(which: keyof typeof screens): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== which;
  // El chat es de la sala: está en la espera y en la partida, y al salir se borra.
  ui.chat.hidden = which === "home";
  if (which === "home") resetChat();
  // En la espera tiene su lugar al pie de la tarjeta; en la partida flota sobre el cerro.
  const chatHome = which === "lobby" ? screens.lobby.querySelector(".card")! : document.body;
  if (ui.chat.parentElement !== chatHome) chatHome.append(ui.chat);
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

ui.create.addEventListener("click", () => enter(() => client.create(ROOM_NAME, joinOptions())));

function joinWithCode(): void {
  const code = ui.code.value.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    ui.homeError.textContent = "El código son 4 letras (sin O ni I).";
    return;
  }
  void enter(() => client.joinById(code, joinOptions()));
}
ui.join.addEventListener("click", joinWithCode);
ui.code.addEventListener("input", () => (ui.code.value = ui.code.value.toUpperCase()));
ui.code.addEventListener("keydown", (e) => e.key === "Enter" && joinWithCode());
ui.start.addEventListener("click", () => room?.send("start"));
ui.fillBots.addEventListener("click", () => room?.send("fillBots"));
ui.lobbyLeave.addEventListener("click", () => void leave());
ui.back.addEventListener("click", () => void leave());
ui.again.addEventListener("click", () => room?.send("rematch"));
ui.ready.addEventListener("click", () => room?.send("ready"));
ui.mound.addEventListener("click", () => {
  moundMode = !moundMode;
  spawnHover = null;
  if (moundMode) showBanner(compact.matches ? "Tocá el piso: ahí va la loma" : "Clic en el piso: ahí va la loma", 3000);
  onState();
  ui.mound.blur();
});

/** Al cargar: si esta pestaña tenía un asiento, vuelve. Si la sala murió o siguió sin vos, queda en el inicio. */
async function rejoin(token: string): Promise<void> {
  setBusy(true);
  try {
    attach(await client.reconnect(token));
  } catch {
    clearSeat();
    ui.homeError.textContent = "Esa partida ya terminó o siguió sin vos.";
  } finally {
    setBusy(false);
  }
}

async function leave(): Promise<void> {
  leavingOnPurpose = true;
  clearSeat();
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

/**
 * Aplica un mensaje "terrain": completo (ronda nueva) o solo el rectángulo del cráter o de la loma.
 * De la ronda 2 en adelante el completo trae el piso que ya estaba acá, con sus hoyos; si trae otro,
 * es el de una partida nueva (el arranque o la revancha).
 */
function onTerrain(m: TerrainMessage): void {
  if (!terrain || terrain.width !== m.width || terrain.depth !== m.depth) {
    terrain = { width: m.width, depth: m.depth, heights: new Float32Array(m.width * m.depth) };
  }
  const src = new Float32Array(m.data.slice().buffer); // copia alineada
  const full = m.w === m.width && m.d === m.depth;
  const heights = terrain.heights;
  const newGround = full && src.some((h, i) => h !== heights[i]);
  for (let z = 0; z < m.d; z++) {
    heights.set(src.subarray(z * m.w, (z + 1) * m.w), (m.z0 + z) * m.width + m.x0);
  }
  terrainVersion++;
  if (newGround) pristine = { width: m.width, depth: m.depth, heights: heights.slice() };
  if (full) lastImpact = null; // ronda nueva
  world ??= new World(ui.viewport);
  world.setTerrain(terrain, full ? undefined : { x0: m.x0, z0: m.z0, w: m.w, d: m.d }, newGround);
}

function showBanner(text: string, ms: number): void {
  ui.banner.textContent = text;
  ui.banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => (ui.banner.hidden = true), ms);
}

// La línea del mapa: una sola vez por sala, en el primer turno de la partida. Sale del mapa del
// estado, así que todas las pestañas leen la misma. Va en su propio renglón, arriba del cartel de
// siempre: dura sus 4 s o hasta el primer tiro, y un aviso que caiga en el medio (la Nafta) no la pisa.
const MAP_TIP: Record<MapId, string> = {
  island: "Ojo con la orilla.",
  hill: "Si no llegás, usá la Nafta.",
  valley: "El Misil es el que llega.",
};
const TIP_KEY = "pyc:tip";
/** La sala en la que ya salió: ni la ronda 2 ni la revancha la traen de vuelta. */
let tipRoom = "";
let tipTimer = 0;

function hideTip(): void {
  clearTimeout(tipTimer);
  ui.tip.hidden = true;
}

function mapTip(phase: string): void {
  if (!room || phase !== "aiming" || room.state.round !== 1 || tipRoom === room.roomId) return;
  tipRoom = room.roomId;
  try {
    // Un refresco en medio de la partida tampoco la repite.
    if (sessionStorage.getItem(TIP_KEY) === room.roomId) return;
    sessionStorage.setItem(TIP_KEY, room.roomId);
  } catch {
    /* sin storage: vale hasta recargar */
  }
  const text = MAP_TIP[room.state.map as MapId];
  if (!text) return;
  ui.tip.textContent = text;
  ui.tip.hidden = false;
  clearTimeout(tipTimer);
  tipTimer = window.setTimeout(hideTip, 4000);
}

// La cuenta de la ronda: al abrir la tienda, de dónde salió la plata de cada uno, en un renglón
// propio arriba (la tienda queda abajo). Los montos son los del mensaje "roundEnd": acá no se calcula
// nada, y lo que dio cero no se nombra. Se va a los 6 s o cuando empieza la ronda que sigue.
const PAYOUT_MS = 6000;
/** La ronda cuya cuenta ya salió: los repintados de la tienda no la traen de vuelta. Fuera de la tienda vuelve a 0. */
let payoutRound = 0;
let payoutTimer = 0;

function hidePayout(): void {
  clearTimeout(payoutTimer);
  ui.payout.hidden = true;
  placePayout();
}

/** La cuenta de uno, una parte por `span`: una parte no se corta al medio, y el punto que las separa lo pone el CSS. */
function payoutNodes(parts: string[]): (Node | string)[] {
  return parts.flatMap((text, i) => {
    const part = document.createElement("span");
    part.textContent = text;
    return i === 0 ? [part] : [" ", part];
  });
}

/**
 * Acomoda la cuenta sobre el cerro. Donde salen los avisos pueden estar la lista de jugadores (en la
 * tienda es más alta: trae el detalle de cada uno) o el minimapa: si la cuenta cae encima de alguno,
 * baja hasta pasarlo. Y si no entró en un renglón, se achica ("small").
 */
function placePayout(): void {
  const notices = ui.payout.parentElement!;
  notices.style.removeProperty("top");
  ui.payout.classList.remove("small");
  if (ui.payout.hidden) return;
  const parts = ui.payout.children;
  if (parts.length > 1 && (parts[0] as HTMLElement).offsetTop !== (parts[parts.length - 1] as HTMLElement).offsetTop) ui.payout.classList.add("small");
  const box = ui.payout.getBoundingClientRect();
  let top = box.top;
  for (const el of [ui.corner, ui.minimap]) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.left < box.right && r.right > box.left) top = Math.max(top, r.bottom + 8);
  }
  if (top > box.top) notices.style.top = `${Math.round(notices.offsetTop + top - box.top)}px`;
}

/** Las partes de la cuenta de uno, en orden, sin las que dieron cero. Un monto negativo es plata que pagó por pegarse. */
function payoutParts(po: RoundEndMsg["payouts"][number]): string[] {
  const rows: [string, number][] = [
    ["Daño", po.damage],
    ["Kill", po.kill],
    ["Kill de agua", po.water],
    ["Sobrevivir", po.survivor],
    ["Interés", po.interest - po.fixed],
    ["Fijo", po.fixed],
  ];
  return rows.filter(([, n]) => n !== 0).map(([label, n]) => `${label} ${n < 0 ? "−" : "+"}${fmtMoney(Math.abs(n))}`);
}

const payoutTotal = (po: RoundEndMsg["payouts"][number]) => po.damage + po.kill + po.water + po.survivor + po.interest;

function payoutLine(phase: string): void {
  if (phase !== "shop") {
    payoutRound = 0;
    return hidePayout();
  }
  // El mensaje y el estado llegan por separado: la cuenta sale cuando están los dos y son de la misma ronda.
  if (!room || !lastRoundEnd || lastRoundEnd.round !== room.state.round || payoutRound === lastRoundEnd.round) return;
  const po = lastRoundEnd.payouts.find((p) => isMe(p.id));
  if (!po) return;
  payoutRound = lastRoundEnd.round;
  const parts = payoutParts(po);
  if (parts.length === 0) return;
  ui.payout.replaceChildren(...payoutNodes(parts));
  ui.payout.hidden = false;
  clearTimeout(payoutTimer);
  payoutTimer = window.setTimeout(hidePayout, PAYOUT_MS);
  placePayout();
}

function attach(r: Room<any>): void {
  room = r;
  payoutRound = 0;
  hidePayout();
  leavingOnPurpose = false;
  shotAnim = null;
  lastImpact = null;
  terrain = null;
  pristine = null;
  spawnHover = null;
  moundMode = false;
  ghostOff = false;
  lastTurnKey = "";
  lastRoundEnd = null;
  weapon = "babyMissile";
  moveMode = false;
  ownTank = false;
  ui.lobbyCode.textContent = r.roomId;
  ui.endCode.textContent = r.roomId;
  ui.hudCode.textContent = r.roomId;
  saveSeat(r);
  r.onReconnect(() => saveSeat(r)); // el token cambia cada vez que se reconecta
  show("lobby");

  r.onStateChange(() => {
    if (room === r) onState();
  });
  r.onMessage("terrain", (m: TerrainMessage) => {
    if (room === r) onTerrain(m);
  });
  // Solo al que vuelve a una partida en curso (recargó la página): el terreno de la ronda 1, que acá ya no está.
  r.onMessage("pristine", (m: TerrainMessage) => {
    if (room === r) pristine = { width: m.width, depth: m.depth, heights: new Float32Array(m.data.slice().buffer) };
  });
  // Alguien dejó una loma en la tienda. El piso ya subió (llegó antes, en un "terrain"): acá van el
  // polvo, el cartel y la cámara, con lo mismo que usa una Tierra cuando cae. Lo ven todas las pestañas.
  r.onMessage("mound", (m: { id: string; x: number; y: number; z: number }) => {
    if (room !== r) return;
    const who = r.state.players.get(m.id);
    shotAnim = {
      weapon: "dirt",
      path: [m.x, m.y, m.z],
      durationMs: 0,
      start: performance.now(),
      color: who?.color ?? 0,
      explodes: true,
      radius: WEAPONS.dirt.mound!.radius,
      dust: true,
      impact: { x: m.x, y: m.y, z: m.z },
      label: "Loma",
    };
    lastImpact = null;
    play("boom");
    showBanner(isMe(m.id) ? "Listo, ahí quedó tu loma" : `${who?.name ?? "?"} deja una loma`, 2000);
  });
  r.onMessage(
    "shot",
    (m: {
      path: number[];
      durationMs: number;
      shooterId: string;
      outcome: string;
      weapon: Fireable;
      /** Solo un Racimo que se abrió: `path` llega hasta la apertura y cada cabeza sigue desde ahí. */
      heads?: { path: number[]; outcome: string }[];
      /** Solo un Rebote que picó: `path` trae los dos tramos y el punto `tick` es donde tocó el piso. */
      bounce?: { tick: number };
      /** Solo un Rodillo que tocó el piso: desde el punto `tick` de `path` va rodando. */
      roll?: { tick: number };
      impact: { x: number; y: number; z: number };
      damage: number;
      blocked: string[];
      drowned?: string[];
      /** Dónde chapotea el agua, según el server: grande donde se ahogó un tanque, chico donde se hundió un golpe. */
      splashes?: { x: number; z: number; big: boolean }[];
    }) => {
      const shooter = r.state.players.get(m.shooterId);
      const explodes = (outcome: string) => outcome === "ground" || outcome === "tank";
      const lands = explodes(m.outcome);
      const heads = (m.heads ?? []).map((h) => ({ path: h.path, lands: explodes(h.outcome) }));
      const w = WEAPONS[m.weapon] ?? WEAPONS.babyMissile;
      shotAnim = {
        weapon: w.id,
        path: m.path,
        durationMs: m.durationMs,
        start: performance.now(),
        color: shooter?.color ?? 0,
        explodes: lands,
        // El Napalm no explota: el fogonazo tiene el tamaño del disco que queda prendido. La Tierra
        // tampoco: levanta polvo, color tierra, del tamaño de la loma.
        radius: w.burn?.radius ?? w.mound?.radius ?? w.explosionRadius,
        dust: !!w.mound,
        heads: heads.length > 0 ? heads : undefined,
        bounce: m.bounce?.tick,
        roll: m.roll?.tick,
        impact: m.impact,
        // El número y el "bloqueado" son del server; acá solo se redondea para mostrarlo. Con un
        // Racimo el número ya viene sumado: es un solo cartel para las cinco cabezas.
        label:
          m.outcome === "water"
            ? "Al agua"
            : lands && w.burn
              ? "Fuego"
              : lands && w.mound
                ? "Loma"
                : impactLabel(lands, m.damage, (m.blocked?.length ?? 0) > 0),
      };
      play(fireSfx(w.id));
      hideTip(); // el primer tiro se lleva la línea del mapa
      // Cada cabeza de un Racimo explota cuando llega: el mismo "boom", una vez por cabeza.
      const steps = (path: number[]) => Math.max(0, path.length / 3 - 1);
      const total = steps(m.path) + Math.max(0, ...heads.map((h) => steps(h.path)));
      for (const h of heads) {
        if (!h.lands) continue;
        window.setTimeout(() => room === r && play("boom"), (m.durationMs * (steps(m.path) + steps(h.path))) / Math.max(1, total));
      }
      window.setTimeout(() => {
        if (room !== r) return;
        if (lands && heads.length === 0) play("boom");
        if (m.damage > 0) play("hit");
      }, m.durationMs);
      const end = (path: number[], ok: boolean) => ({ x: path[path.length - 3]!, z: path[path.length - 1]!, lands: ok });
      // La Tierra no deja estrella en el minimapa: taparía la loma, que es la marca.
      lastImpact =
        m.path.length >= 3 && !(lands && w.mound)
          ? {
              spots: heads.length > 0 ? heads.filter((h) => h.path.length >= 3).map((h) => end(h.path, h.lands)) : [end(m.path, lands)],
              at: shotAnim.start + m.durationMs,
            }
          : null;
      if (m.weapon !== "babyMissile") showBanner(`${shooter?.name ?? "?"} manda ${SHOP_ITEMS[m.weapon]?.name ?? m.weapon}`, 1400);
      if (m.outcome === "offmap" || m.outcome === "timeout") {
        // Todas las pestañas reciben el mismo "shot": todas muestran que se fue.
        window.setTimeout(() => room === r && showBanner("¡Malardo, se fue!", 2500), m.durationMs);
      }
      // El que quedó en el agua muere aunque tenga escudo o paracaídas: todas las pestañas lo dicen.
      const drowned = (m.drowned ?? []).map((id) => r.state.players.get(id)?.name ?? "?");
      if (drowned.length > 0) window.setTimeout(() => room === r && showBanner(`Al agua: ${drowned.join(", ")}`, 2500), m.durationMs);
      // El chapuzón sale de `splashes`, que arma el server: acá no se decide quién se ahogó ni dónde.
      // El del ahogado va un momento después de la explosión, cuando el tanque ya cayó al hoyo.
      for (const big of [false, true]) {
        const spots = (m.splashes ?? []).filter((s) => s.big === big);
        if (spots.length === 0) continue;
        window.setTimeout(() => {
          if (room !== r) return;
          for (const s of spots) world?.splash(s.x, s.z, s.big, performance.now());
          play("splash");
        }, m.durationMs + (big ? DROWN_DELAY_MS : 0));
      }
    },
  );
  r.onMessage("moved", (m: { id: string }) => {
    const p = r.state.players.get(m.id);
    if (!p || room !== r) return;
    // Al que se movió se le dice a él: es su confirmación.
    if (isMe(m.id)) showBanner("Te corriste", 1000);
    else showBanner(`Usó nafta ${p.name}`, 1400);
  });
  r.onMessage("skip", () => {
    if (room === r) showBanner("Se colgó: turno perdido", 1500);
  });
  r.onMessage("burn", (m: { id: string; damage: number; killed: boolean }) => {
    if (room !== r) return;
    // Llega pegado al final de un tiro o a un turno perdido: se suma al cartel que esté, no lo pisa.
    const text = `Se quema ${r.state.players.get(m.id)?.name ?? "?"}: -${Math.max(1, Math.round(m.damage))}`;
    showBanner(ui.banner.hidden ? text : `${ui.banner.textContent} · ${text}`, 2200);
    play("hit");
  });
  r.onMessage("refuel", (m: { ids: string[] }) => {
    if (room !== r) return;
    // Como el fuego, llega pegado al final de un tiro o a un turno perdido: se suma al cartel que esté.
    const text = m.ids.includes(r.sessionId) ? "Vuelta sin pegar: te cae una Nafta de arriba" : "Vuelta sin pegar: Nafta de arriba";
    showBanner(ui.banner.hidden ? text : `${ui.banner.textContent} · ${text}`, 3000);
  });
  r.onMessage("roundEnd", (m: RoundEndMsg) => {
    lastRoundEnd = m;
    if (room !== r) return;
    payoutLine(r.state.phase);
    if (r.state.phase === "ended") renderEnd("ended"); // al que vuelve con la tabla ya abierta le llega después del estado
  });
  r.onMessage("chat", (m: ChatMsg) => {
    if (room === r) addChat(m);
  });
  r.onLeave(() => {
    if (room !== r) return;
    room = null;
    if (!unloading) clearSeat();
    show("home");
    if (!leavingOnPurpose) ui.homeError.textContent = "Se cortó la conexión con la sala.";
  });
  onState();
}

/**
 * Cartel en el punto de impacto: "se fue", el daño, o "bloqueado" si un escudo se comió el tiro (al
 * Nuke no: dice el daño). Con un Racimo el daño es el de todas las cabezas sumado.
 */
function impactLabel(lands: boolean, damage: number, blocked: boolean): string {
  if (!lands) return "Se fue";
  const hurt = damage > 0 ? `-${Math.max(1, Math.round(damage))}` : "0";
  if (!blocked) return hurt;
  return damage > 0 ? `Bloqueado · ${hurt}` : "Bloqueado"; // con daño: además lastimó a otro tanque, o le pegó otra cabeza del Racimo
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

/** Lee las marcas del estado. Solo arma un objeto nuevo para la que cambió. */
function readMarks(): void {
  marks = playersInOrder().flatMap((p): MarkModel[] => {
    const path: number[] = Array.from(p.markPath ?? []);
    const spots: number[] = Array.from(p.markSpots ?? []);
    if (path.length < 6 && spots.length < 3) {
      markKeys.delete(p.id);
      return [];
    }
    const key = `${p.color}|${path.join()}|${spots.join()}`;
    const old = marks.find((m) => m.id === p.id);
    if (old && markKeys.get(p.id) === key) return [old];
    markKeys.set(p.id, key);
    const model: MarkModel = { id: p.id, color: p.color, path, spots: [] };
    for (let i = 0; i + 2 < spots.length; i += 3) model.spots.push({ x: spots[i]!, z: spots[i + 1]!, wet: spots[i + 2]! > 0 });
    return [model];
  });
}

function onState(): void {
  if (!room) return;
  readMarks();
  const phase: string = room.state.phase ?? "lobby";
  if (phase === "lobby") {
    show("lobby");
    renderLobby();
    liftChat(0);
    return;
  }
  if (screens.game.hidden) show("game");
  mapTip(phase);
  payoutLine(phase);
  renderHud(phase);
  renderShop(phase);
  renderEnd(phase);
  // Las flechas de rivales fuera de cámara no se meten debajo de lo que esté abierto abajo.
  const open = !ui.dock.hidden ? ui.dock : !ui.shop.hidden ? ui.shop : null;
  if (world) world.edgeBottomInset = open ? open.offsetHeight + 12 : 0;
  liftChat(open ? open.offsetHeight + 8 : 0);
  fitPlayers();
  placePayout(); // la lista ya tiene el alto de esta fase
}

// ---------------------------------------------------------------------------
// Chat de sala
// ---------------------------------------------------------------------------

/** Mensaje "chat" del server: el nombre y el slot (el color del tanque) los pone él. */
interface ChatMsg {
  name: string;
  id: string;
  text: string;
}
/** Historial corto: lo que se guarda mientras estés en la sala. */
const CHAT_KEEP = 40;
/** Lo que un mensaje recién llegado queda a la vista en pantalla chica con el chat cerrado. [ms] */
const CHAT_FRESH_MS = 8000;
let chatClosedAt = 0;

const chatOpen = () => ui.chat.classList.contains("open");

/** El chat va arriba de lo que esté abierto abajo (barra de tiro o tienda). [px] */
function liftChat(px: number): void {
  ui.chat.style.setProperty("--lift", `${px}px`);
}

function addChat(m: ChatMsg): void {
  const log = ui.chatLog;
  // Si estabas leyendo más arriba, el mensaje nuevo no te mueve.
  const reading = chatOpen() && log.scrollHeight - log.scrollTop - log.clientHeight > 24;
  const li = document.createElement("li");
  const who = document.createElement("b");
  who.textContent = m.name;
  who.style.color = TANK_COLORS[room?.state.players?.get(m.id)?.color] ?? "#ccc";
  li.append(who, m.text); // texto plano: nada de lo que llega se interpreta como HTML
  log.append(li);
  while (log.childElementCount > CHAT_KEEP) log.firstElementChild!.remove();
  if (!reading) log.scrollTop = log.scrollHeight;
  window.setTimeout(() => li.classList.add("old"), CHAT_FRESH_MS);
}

function setChatOpen(open: boolean): void {
  if (open === chatOpen()) return;
  ui.chat.classList.toggle("open", open);
  ui.chatToggle.textContent = open ? "Cerrar" : "Chat";
  ui.chatToggle.setAttribute("aria-expanded", String(open));
  if (open) ui.chatInput.focus();
  else {
    chatClosedAt = performance.now();
    ui.chatInput.blur(); // las teclas vuelven al cañón
  }
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
  fitPlayers();
}

function resetChat(): void {
  setChatOpen(false);
  ui.chat.classList.remove("end");
  ui.chatLog.replaceChildren();
  ui.chatInput.value = "";
  liftChat(0);
}

// Abierto es lo mismo que estar escribiendo: se abre al enfocar la línea y se cierra al salir de ella.
ui.chatInput.addEventListener("focus", () => setChatOpen(true));
ui.chatInput.addEventListener("blur", () => setChatOpen(false));
ui.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ui.chatInput.value.trim();
  if (text) room?.send("chat", { text });
  ui.chatInput.value = "";
  setChatOpen(false);
});
// Que tocar el botón no le saque el foco a la línea antes del clic (la cerraría y el clic la reabriría).
ui.chatToggle.addEventListener("mousedown", (e) => e.preventDefault());
ui.chatToggle.addEventListener("click", () => {
  if (!chatOpen() && performance.now() - chatClosedAt < 300) return; // ese mismo toque ya lo cerró
  setChatOpen(!chatOpen());
});
window.addEventListener("keydown", (e) => {
  if (!room) return;
  if (e.target === ui.chatInput) {
    if (e.key === "Escape") setChatOpen(false);
    return;
  }
  if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
  if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); // la T no se escribe en la línea
    setChatOpen(true);
  }
});

function renderLobby(): void {
  const s = room!.state;
  const players = playersInOrder();
  ui.lobbyPlayers.replaceChildren(
    ...players.map((p) => {
      const li = document.createElement("li");
      // La silueta de cada uno, en su color: así se ve qué eligió el otro antes de arrancar.
      const icon = hullSvg(asHull(p.hull));
      icon.classList.add("hull-icon");
      icon.style.color = TANK_COLORS[p.color] ?? "#ccc";
      const name = document.createElement("span");
      name.textContent = p.name + (isMe(p.id) ? " (vos)" : "");
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = p.id === s.hostId ? "anfitrión" : "";
      li.append(icon, name, tag);
      return li;
    }),
  );
  // El elegido es el que tiene el server (al volver con el token puede no ser el guardado).
  const me = players.find((p) => isMe(p.id));
  if (me) {
    paintHullPicker(asHull(me.hull));
    paintColorPicker(me.color, new Set(players.filter((p) => p !== me).map((p) => p.color as number)));
  }
  const host = isMe(s.hostId);
  paintMapPicker(s.map, host);
  paintClock(s, host);
  paintSteps(host);
  // Con los cuatro adentro ya no hay a quién pasarle el código: en pantalla chica ese renglón se va (style.css).
  screens.lobby.querySelector(".card")!.classList.toggle("full", players.length >= 4);
  ui.start.disabled = players.length < 2;
  // Los bots completan hasta 2: con 2 o más ya no hay nada que llenar.
  ui.fillBots.hidden = !host;
  ui.fillBots.disabled = players.length >= 2;
  const step = lobbyStep();
  ui.lobbyWait.textContent = host
    ? players.length < 2
      ? "Esperando a que entre al menos otro jugador…"
      : step < LOBBY_STEPS
        ? `${players.length} jugadores. Se arranca en el paso ${LOBBY_STEPS}.`
        : `${players.length} jugadores. Dale, arrancá.`
    : `El anfitrión va por el paso ${step} de ${LOBBY_STEPS}: ${["el tanque", "el mapa", "el reloj"][step - 1]}. Arranca él.`;
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
  if (playing) ui.hudTurnDot.style.background = TANK_COLORS[turnPlayer.color] ?? "#888";
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
      dot.style.background = TANK_COLORS[p.color] ?? "#ccc";
      const name = document.createElement("span");
      name.textContent = p.name + (isMe(p.id) ? " (vos)" : "") + (p.connected ? "" : " · se fue");
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(0, Math.min(100, p.life))}%`;
      fill.style.background = TANK_COLORS[p.color] ?? "#ccc";
      bar.append(fill);
      const life = document.createElement("span");
      life.textContent = String(Math.ceil(Math.max(0, p.life)));
      const extra = document.createElement("span");
      extra.className = "extra";
      extra.textContent =
        `${p.points} pts · M×${p.missiles}${p.rollers > 0 ? ` · R×${p.rollers}` : ""}${p.napalms > 0 ? ` · Quema×${p.napalms}` : ""}${p.nukes > 0 ? ` · Bombazo×${p.nukes}` : ""}${p.dirts > 0 ? ` · Tierra×${p.dirts}` : ""}${p.mirvs > 0 ? ` · Racimo×${p.mirvs}` : ""}${p.leapfrogs > 0 ? ` · Rebote×${p.leapfrogs}` : ""}` +
        `${p.shield > 0 ? " · escudo" : ""}${p.parachute > 0 ? " · ☂" : ""}${p.fuel > 0 ? ` · N×${p.fuel}` : ""}` +
        // Parado en un fuego (inFire, la misma cuenta del server): va a perder vida al empezar su turno.
        `${p.life > 0 && fires.some((f) => inFire(f, p)) ? " · en el fuego" : ""}` +
        // Piso bajo (onShore, la misma cuenta en todas las pestañas): un Misil lo manda al agua.
        `${p.life > 0 && terrain && onShore(terrain, p.x, p.z) ? " · en la orilla" : ""}`;
      li.append(dot, name, bar, life, extra);
      return li;
    }),
  );

  // Barra de controles.
  const missiles = mp?.missiles ?? 0;
  const rollers = mp?.rollers ?? 0;
  const napalms = mp?.napalms ?? 0;
  const nukes = mp?.nukes ?? 0;
  const dirts = mp?.dirts ?? 0;
  const mirvs = mp?.mirvs ?? 0;
  const leapfrogs = mp?.leapfrogs ?? 0;
  if (
    (weapon === "missile" && missiles <= 0) ||
    (weapon === "roller" && rollers <= 0) ||
    (weapon === "napalm" && napalms <= 0) ||
    (weapon === "nuke" && nukes <= 0) ||
    (weapon === "dirt" && dirts <= 0) ||
    (weapon === "mirv" && mirvs <= 0) ||
    (weapon === "leapfrog" && leapfrogs <= 0)
  ) {
    weapon = "babyMissile";
  }
  ui.wMissileN.textContent = `×${missiles}`;
  ui.wRollerN.textContent = `×${rollers}`;
  ui.wNapalmN.textContent = `×${napalms}`;
  ui.wNukeN.textContent = `×${nukes}`;
  ui.wDirtN.textContent = `×${dirts}`;
  ui.wMirvN.textContent = `×${mirvs}`;
  ui.wLeapfrogN.textContent = `×${leapfrogs}`;
  // Un arma sin munición no ocupa lugar en la barra.
  ui.wMissile.hidden = missiles <= 0;
  ui.wRoller.hidden = rollers <= 0;
  ui.wNapalm.hidden = napalms <= 0;
  ui.wNuke.hidden = nukes <= 0;
  ui.wDirt.hidden = dirts <= 0;
  ui.wMirv.hidden = mirvs <= 0;
  ui.wLeapfrog.hidden = leapfrogs <= 0;
  for (const [btn, id] of [[ui.wBaby, "babyMissile"], [ui.wMissile, "missile"], [ui.wRoller, "roller"], [ui.wNapalm, "napalm"], [ui.wNuke, "nuke"], [ui.wDirt, "dirt"], [ui.wMirv, "mirv"], [ui.wLeapfrog, "leapfrog"]] as const) {
    btn.classList.toggle("on", weapon === id);
    btn.setAttribute("aria-checked", String(weapon === id));
  }
  const fuel = mp?.fuel ?? 0;
  // La de la casa se nombra: es la única que no se guarda. Con una comprada encima, va la cuenta y cuál es.
  const house = !!mp?.house && fuel > 0;
  ui.fuelN.textContent = !house ? `×${fuel}` : fuel > 1 ? `×${fuel}, 1 de la casa` : "de la casa";
  ui.fuelBtn.title = house
    ? "Nafta de la casa: vale en tu primer turno de la ronda y, si tirás sin usarla, se pierde. Después, clic en el piso"
    : "Mové el tanque antes de tirar: después, clic en el piso";
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
  nuke: "Hoyo enorme, tiro corto",
  dirt: "Levanta una loma",
  mirv: "Se abre en 5 en el aire",
  leapfrog: "Pica una vez y sigue",
  shield: "Frena el próximo tiro",
  parachute: PARACHUTE_LINE,
  fuel: "Mové el tanque",
};

function renderShop(phase: string): void {
  if (phase !== "shop") {
    ui.shop.hidden = true;
    spawnHover = null;
    spawnSeen = "";
    moundMode = false;
    return;
  }
  const s = room!.state;
  const mp = me();
  // Al abrir, lo que la fila de cartas no dice: el cerro también se toca. Y cuando el server acepta un punto, la confirmación.
  const spawn = mp && mp.spawnX >= 0 ? `${mp.spawnPicked}|${mp.spawnX}|${mp.spawnZ}` : "";
  if (spawn && ui.shop.hidden) showBanner(compact.matches ? "Tocá el piso: ahí nacés" : "Clic en el piso: ahí nacés", 4000);
  else if (spawn && spawn !== spawnSeen && mp.spawnPicked) showBanner("Dale, nacés ahí", 1500);
  spawnSeen = spawn;
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
      dot.style.background = TANK_COLORS[p.color] ?? "#ccc";
      const name = document.createElement("span");
      name.textContent = isMe(p.id) ? "Vos" : p.name;
      const money = document.createElement("b");
      money.textContent = fmtMoney(p.money);
      who.append(dot, name, money);
      const po = pay.get(p.id);
      if (po) {
        const gain = document.createElement("span");
        gain.className = "gain";
        const total = payoutTotal(po);
        gain.textContent = `${total < 0 ? "−" : "+"}${fmtMoney(Math.abs(total))}`;
        who.title = payoutParts(po).join(" · ");
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
  // La loma: una por tienda. Sale de tu Tierra si tenés; si no, la pagás al tocar el piso (el precio de la carta).
  const dirtPrice = SHOP_ITEMS.dirt.price;
  const canMound = !mp.mound && (mp.dirts > 0 || mp.money >= dirtPrice);
  if (!canMound) moundMode = false;
  ui.mound.disabled = !canMound;
  ui.mound.classList.toggle("on", moundMode);
  ui.mound.textContent = mp.mound
    ? "Loma puesta"
    : moundMode
      ? compact.matches
        ? "Tocá el piso"
        : "Clic en el piso"
      : mp.dirts > 0
        ? `Loma · tenés ${mp.dirts}`
        : mp.money >= dirtPrice
          ? `Loma · ${fmtMoney(dirtPrice)}`
          : "Loma · no alcanza";
  ui.mound.title = mp.mound ? "Una por tienda" : "Dejá una loma en el piso: queda para la ronda que viene. Una por tienda.";

  // Cartas: la validación de plata es la misma del server (cannotBuy del sim). Solo se repintan si
  // cambió la plata o el inventario, y sobre los mismos botones (shopSlot).
  const inventory = { parachute: mp.parachute, fuel: mp.fuel, missile: mp.missiles, roller: mp.rollers, napalm: mp.napalms, nuke: mp.nukes, dirt: mp.dirts, mirv: mp.mirvs, leapfrog: mp.leapfrogs, shield: mp.shield };
  const asPlayer = { id: mp.id, money: mp.money, inventory };
  const itemsKey = `${mp.money}|${mp.parachute}|${mp.fuel}|${mp.missiles}|${mp.rollers}|${mp.napalms}|${mp.nukes}|${mp.dirts}|${mp.mirvs}|${mp.leapfrogs}|${mp.shield}`;
  if (ui.shopItems.dataset.key === itemsKey) return;
  ui.shopItems.dataset.key = itemsKey;
  for (const id of Object.keys(SHOP_ITEMS) as ShopItemId[]) {
    const it = SHOP_ITEMS[id];
    const { card, have, sell } = shopSlot(id);
    const why = cannotBuy(asPlayer, id);
    card.disabled = why !== null;
    card.title = why ? `${it.description} (${why})` : it.description;
    // El motivo completo (el del sim) va en el tooltip; en la carta, dos palabras.
    have.textContent = why ? (mp.money < it.price ? "no alcanza" : "ya tenés") : inventory[id] > 0 ? `tenés ${inventory[id]}` : "";
    // Lo que te devuelven si la vendés (sellValue del sim, la cuenta del server).
    const units = sellUnits(asPlayer, id);
    const sellable = cannotSell(asPlayer, id) === null;
    sell.disabled = !sellable;
    sell.title = sellable ? "Te devuelven la mitad" : "";
    sell.textContent = sellable
      ? `Vendé${units > 1 ? ` ×${units}` : ""} +${fmtMoney(sellValue(asPlayer, id))}`
      : id === "shield" && inventory.shield > 0
        ? "Ya está puesto"
        : "";
  }
}

/** Mi nacimiento de la ronda que viene como estaba en el último estado: cuando cambia, es que el server aceptó el punto. */
let spawnSeen = "";

/** Lo que cambia en una carta de la tienda: la carta (comprar), el "tenés N" y el renglón de venta. */
interface ShopSlot {
  card: HTMLButtonElement;
  have: HTMLElement;
  sell: HTMLButtonElement;
}
const shopSlots = new Map<ShopItemId, ShopSlot>();

/**
 * La carta de un ítem. Se arma una sola vez y después renderShop le cambia el texto y el `disabled`:
 * un botón que se recrea con el dedo abajo pierde el toque (Comprá apretado justo después de Vendé).
 */
function shopSlot(id: ShopItemId): ShopSlot {
  const made = shopSlots.get(id);
  if (made) return made;
  const it = SHOP_ITEMS[id];
  const card = document.createElement("button");
  card.className = "item";
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
  foot.append(price, have);
  // En el teléfono la carta no se toca entera (el dedo la usa para pasar la fila): se compra
  // con este botón, que en el escritorio no se ve (style.css).
  const buy = document.createElement("span");
  buy.className = "buy";
  buy.textContent = `Comprá ${fmtMoney(it.price)}`;
  card.append(name, desc, foot, buy);
  card.addEventListener("click", () => room?.send("buy", { item: id }));
  // Debajo de la carta, el renglón de venta. Está siempre, así la fila no salta cuando comprás;
  // apagado no dispara.
  const sell = document.createElement("button");
  sell.className = "sell";
  sell.addEventListener("click", () => room?.send("sell", { item: id }));
  const slot = document.createElement("div");
  slot.className = "slot";
  slot.append(card, sell);
  ui.shopItems.append(slot);
  const parts = { card, have, sell };
  shopSlots.set(id, parts);
  return parts;
}

function renderEnd(phase: string): void {
  ui.chat.classList.toggle("end", phase === "ended");
  if (phase !== "ended") {
    ui.overlay.hidden = true;
    return;
  }
  const s = room!.state;
  const winners: string[] = [...(s.winners ?? [])];
  const winner = s.winnerId ? s.players.get(s.winnerId) : null;
  // Sin ganador único es empate; si el ganador ya no está en la tabla (se fue y su lugar lo ocupó otro), no se nombra a nadie.
  ui.overlayTitle.textContent = winner
    ? isMe(winner.id)
      ? "¡Ganaste, buenardo!"
      : `Ganó ${winner.name}`
    : s.winnerId
      ? "Se terminó"
      : "Empate";
  ui.overlaySub.textContent =
    s.endReason === "forfeit"
      ? "Se fueron."
      : `Después de ${s.rounds === 1 ? "1 ronda" : `${s.rounds} rondas`}, por puntos (daño + kills).`;
  const rows = playersInOrder()
    .slice()
    .sort((a, b) => b.points - a.points || b.kills - a.kills || b.damage - a.damage);
  // La última ronda no tiene tienda: su cuenta va acá, abajo de cada uno. Solo si la partida llegó
  // al final (el que gana porque se fueron los demás no cobró ronda) y la cuenta es de esa ronda.
  const last = s.endReason === "rounds" && lastRoundEnd?.round === s.round ? lastRoundEnd : null;
  const pay = new Map((last?.payouts ?? []).map((p) => [p.id, p]));
  // `short`: la cuenta del que no ganó en un renglón, "Ronda 5 · +$1.150" (la suma, sin el detalle).
  const table = (short: boolean) =>
    rows.flatMap((p, i) => {
      const tr = document.createElement("tr");
      if (winners.includes(p.id)) tr.className = "win";
      const who = `${p.name}${isMe(p.id) ? " (vos)" : ""}${p.connected ? "" : " · se fue"}`;
      for (const v of [String(i + 1), who, String(p.points), fmtMoney(p.money)]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      const po = pay.get(p.id);
      const parts = po ? payoutParts(po) : [];
      if (parts.length === 0) return [tr];
      const count = document.createElement("tr");
      count.className = "count";
      const td = document.createElement("td");
      td.colSpan = 3;
      td.className = "payout";
      const total = payoutTotal(po!);
      const sum = `${total < 0 ? "−" : "+"}${fmtMoney(Math.abs(total))}`;
      td.append(...payoutNodes([`Ronda ${s.round}`, ...(short && !winners.includes(p.id) ? [sum] : parts)]));
      count.append(document.createElement("td"), td);
      return [tr, count];
    });
  if (ui.overlay.hidden && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  ui.overlay.hidden = false; // a la vista antes de armar la tabla: hay que medirla
  ui.scoresBody.replaceChildren(...table(false));
  // En el teléfono, si la tabla no entra entera (sala llena), solo el que ganó se queda con la cuenta completa.
  if (compact.matches && ui.scoresWrap.scrollHeight > ui.scoresWrap.clientHeight) ui.scoresBody.replaceChildren(...table(true));
  // Revancha en la misma sala: la arranca el anfitrión, con al menos 2 sentados (el bot cuenta).
  const host = isMe(s.hostId);
  const here = rows.filter((p) => p.connected).length;
  ui.again.hidden = !host;
  ui.again.disabled = here < 2;
  ui.overlayWait.textContent = !host
    ? "Esperando a que el anfitrión mande otra…"
    : here < 2
      ? `Falta uno para la revancha. Pasá el código: ${room!.roomId}`
      : "¿Va la revancha? Dale, otra vez.";
}
window.addEventListener("resize", () => {
  if (room && !ui.overlay.hidden) renderEnd(room.state.phase);
});

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
  if (w === "dirt" && (me()?.dirts ?? 0) <= 0) return;
  if (w === "mirv" && (me()?.mirvs ?? 0) <= 0) return;
  if (w === "leapfrog" && (me()?.leapfrogs ?? 0) <= 0) return;
  weapon = w;
  onState();
}
ui.wBaby.addEventListener("click", () => selectWeapon("babyMissile"));
ui.wMissile.addEventListener("click", () => selectWeapon("missile"));
ui.wRoller.addEventListener("click", () => selectWeapon("roller"));
ui.wNapalm.addEventListener("click", () => selectWeapon("napalm"));
ui.wNuke.addEventListener("click", () => selectWeapon("nuke"));
ui.wDirt.addEventListener("click", () => selectWeapon("dirt"));
ui.wMirv.addEventListener("click", () => selectWeapon("mirv"));
ui.wLeapfrog.addEventListener("click", () => selectWeapon("leapfrog"));

function toggleMoveMode(): void {
  if (!myTurn()) return;
  if ((me()?.fuel ?? 0) <= 0 || room?.state.moved) return;
  moveMode = !moveMode;
  moveHover = null;
  // Se dice qué sigue: el anillo solo no avisa que hay que tocar el piso.
  if (moveMode) showBanner(compact.matches ? "Tocá el piso adonde vas" : "Clic en el piso adonde vas", 2500);
  onState();
}

ui.fuelBtn.addEventListener("click", () => {
  toggleMoveMode();
  ui.fuelBtn.blur(); // las teclas vuelven al cañón
});

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

// Lista de jugadores: la flecha la guarda y la vuelve a abrir. En pantalla chica el estado se
// recuerda en el teléfono; en el escritorio ancho arranca siempre abierta.
const PLAYERS_KEY = "pyc:players";
function setPlayersOpen(open: boolean): void {
  ui.corner.classList.toggle("closed", !open);
  ui.playersToggle.setAttribute("aria-expanded", String(open));
  ui.playersToggle.setAttribute("aria-label", open ? "Guardar la lista de jugadores" : "Abrir la lista de jugadores");
  fitPlayers();
  placePayout();
}
/** Con el teléfono acostado el botón de Chat queda a la altura de la lista. Si la pisa, la lista cede
 *  el renglón de detalle ("snug"), después se afina ("slim") y, si ni así entra, el botón se corre al
 *  costado de la lista (--dodge). Nada de esto pesa fuera del CSS de teléfono acostado. */
function fitPlayers(): void {
  if (chatOpen()) return; // abierto el chat sube arriba de todo: la lista queda como estaba
  const c = ui.corner.classList;
  c.remove("snug", "slim");
  ui.chat.style.removeProperty("--dodge");
  if (c.contains("closed")) return;
  const hit = () => {
    const chat = ui.chatToggle.getBoundingClientRect();
    return chat.height > 0 && ui.corner.getBoundingClientRect().bottom + 6 > chat.top;
  };
  for (const step of ["snug", "slim"]) {
    if (!hit()) return;
    c.add(step);
  }
  if (!hit()) return;
  ui.chat.style.setProperty("--dodge", `${Math.round(ui.corner.getBoundingClientRect().right)}px`);
}
window.addEventListener("resize", fitPlayers);
window.addEventListener("resize", placePayout);
function restorePlayersOpen(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(PLAYERS_KEY);
  } catch {
    // sin almacenamiento: abierta
  }
  setPlayersOpen(!(compact.matches && saved === "0"));
}
restorePlayersOpen();
compact.addEventListener("change", restorePlayersOpen);
ui.playersToggle.addEventListener("click", () => {
  const open = ui.corner.classList.contains("closed");
  setPlayersOpen(open);
  ui.playersToggle.blur(); // las teclas vuelven al cañón
  if (!compact.matches) return;
  try {
    localStorage.setItem(PLAYERS_KEY, open ? "1" : "0");
  } catch {
    // sin almacenamiento: vale hasta recargar
  }
});

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

/**
 * ¿Puedo nacer en `to` en la ronda que viene? La misma cuenta del server (validateSpawn del sim),
 * contra los nacimientos de los demás que están en el estado. null: todavía no llegó el terreno.
 */
function checkSpawn(to: { x: number; z: number }) {
  if (!terrain || !pristine) return null;
  const rivals = playersInOrder().filter((p) => !isMe(p.id) && p.spawnX >= 0);
  return validateSpawn(terrain, pristine, to, rivals.map((p) => ({ x: p.spawnX, z: p.spawnZ })));
}

/**
 * ¿Puedo dejar la loma en `to`? La misma cuenta del server (validateMound del sim), contra los
 * tanques que quedaron en el cerro. null: todavía no llegó el terreno.
 */
function checkMound(to: { x: number; z: number }) {
  if (!terrain) return null;
  return validateMound(terrain, playersInOrder().map((p) => ({ x: p.x, z: p.z })), to);
}

/** Tienda, con Loma elegido: un clic (o un toque) en el piso la deja ahí. Sube cuando el server la acepta. */
function moundAt(e: PointerEvent): void {
  if (!room) return;
  const to = pickGround(e);
  const check = to && checkMound(to);
  if (!to || !check) return;
  if (!check.ok) {
    showBanner(`No: ${check.reason}`, 1500);
    return;
  }
  room.send("mound", { at: to });
  moundMode = false;
  spawnHover = null;
  onState();
}

/** Tienda: un clic (o un toque) en el piso elige dónde nacés. La estaca se corre cuando el server lo acepta. */
function spawnAt(e: PointerEvent): void {
  if (!room || !(me()?.spawnX >= 0)) return;
  const to = pickGround(e);
  const check = to && checkSpawn(to);
  if (!to || !check) return;
  if (!check.ok) {
    showBanner(`No: ${check.reason}`, 1500);
    return;
  }
  room.send("spawn", { at: to });
}

/** Clic o toque en el piso: en la tienda es el nacimiento (o la loma, si está elegida); en tu turno, el destino de la nafta. */
function tapGround(e: PointerEvent): void {
  if (room?.state.phase !== "shop") moveTo(e);
  else if (moundMode) moundAt(e);
  else spawnAt(e);
}

function pickGround(e: PointerEvent): { x: number; z: number } | null {
  if (!world) return null;
  const rect = ui.viewport.getBoundingClientRect();
  const hit = world.pick(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  return hit ? { x: hit.x, z: hit.z } : null;
}

// Mouse: izquierdo arrastra el cañón (horizontal = giro, vertical = elevación); en modo nafta,
// un clic en el piso elige el destino, y en la tienda, dónde nacés. Derecho orbita la cámara. Rueda = potencia en tu turno.
// Dedo en pantalla chica: uno solo toca (destino de la nafta, o el nacimiento en la tienda); dos orbitan y, al separarse, hacen zoom.
let drag: { button: number; x: number; y: number; moved: number } | null = null;
const fingers = new Map<number, { x: number; y: number }>();
/** El toque de un solo dedo, mientras no se le sume otro. */
let tap: { id: number; moved: number } | null = null;
const byFinger = (e: PointerEvent) => compact.matches && e.pointerType !== "mouse";

/** Clic (o toque) en el piso con la Nafta elegida: mueve el tanque si el sim lo deja. */
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
    if (wasTap) tapGround(e);
    return;
  }
  const wasClick = drag && drag.button === 0 && drag.moved < 5;
  drag = null;
  ui.viewport.classList.remove("dragging");
  if (wasClick) tapGround(e);
});
ui.viewport.addEventListener("pointercancel", (e) => {
  if (fingers.delete(e.pointerId)) {
    tap = null;
    return;
  }
  drag = null;
  ui.viewport.classList.remove("dragging");
});
ui.viewport.addEventListener("pointerleave", () => (spawnHover = null));
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
  if (room?.state.phase === "shop" && !drag && me()?.spawnX >= 0) {
    const to = pickGround(e);
    const check = to && (moundMode ? checkMound(to) : checkSpawn(to));
    spawnHover = to && check && terrain ? { x: to.x, y: terrainHeightAt(terrain, to.x, to.z), z: to.z, ok: check.ok } : null;
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
    case "6":
      selectWeapon("dirt");
      break;
    case "7":
      selectWeapon("mirv");
      break;
    case "8":
      selectWeapon("leapfrog");
      break;
    case "n":
    case "N":
      toggleMoveMode();
      break;
    case "Escape":
      moveMode = false;
      moundMode = false;
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
 * el disco que quedaría prendido, sacado del mismo fireFromShot que usa el server. Con la Tierra,
 * el anillo es el pie de la loma. Con el Racimo el recorrido llega hasta donde se abre y de ahí
 * sale el de cada cabeza, con un anillo donde caería cada una. Con el Rebote el recorrido trae los
 * dos tramos, con una marca donde pica, y el anillo va donde termina el segundo.
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
    const explodes = (h: { outcome: string }) => h.outcome === "ground" || h.outcome === "tank";
    const heads = r.split?.heads;
    const lands = heads ? heads.some(explodes) : explodes(r);
    const fire = fireFromShot(w, r, mine.id);
    ghostCache = {
      path: r.path ?? [],
      // El fuego queda en el piso aunque el tiro haya pegado en un tanque, más arriba. Un Racimo
      // abierto no tiene un impacto solo: tiene uno por cabeza.
      impact: fire ? { x: fire.x, y: terrainHeightAt(terrain, fire.x, fire.z), z: fire.z } : lands && !heads ? { x: r.x, y: r.y, z: r.z } : null,
      gone: !lands,
      sunk: heads ? heads.every((h) => h.outcome === "water") : r.outcome === "water",
      shooter: mine,
      radius: fire ? fire.radius : (w.mound?.radius ?? w.explosionRadius),
      heads: heads?.map((h) => ({ path: h.path ?? [], impact: explodes(h) ? { x: h.x, y: h.y, z: h.z } : null })),
      bounce: r.bounce && { x: r.bounce.x, y: r.bounce.y, z: r.bounce.z },
    };
  }
  if (ghostCache) ghostCache.shooter = mine;
  return ghostCache;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Sin `terrain`: entró a una sala ya terminada y el terreno de esa sala todavía no llegó.
  if (!room || screens.game.hidden || !world || !world.hasTerrain || !terrain) return;
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
    color: p.color,
    hull: asHull(p.hull),
    x: p.x,
    y: p.y,
    z: p.z,
    life: p.life,
    shield: p.shield > 0,
    shore: onShore(terrain!, p.x, p.z),
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
  // Tienda: las estacas de la ronda que viene, y la cámara en la mía (cada punto que elijo la lleva ahí).
  const spawns: SpawnModel[] =
    s.phase === "shop"
      ? playersInOrder()
          .filter((p) => p.spawnX >= 0)
          .map((p) => ({ id: p.id, color: p.color, x: p.spawnX, z: p.spawnZ, picked: !!p.spawnPicked, isMe: isMe(p.id) }))
      : [];
  const mySpawn = spawns.find((sp) => sp.isMe);
  if (mySpawn) world.focus(mySpawn.x, terrainHeightAt(terrain, mySpawn.x, mySpawn.z) + 3, mySpawn.z);
  world.render({
    tanks,
    ghost,
    marks,
    shot: shotAnim,
    wind,
    fires,
    // Con la loma elegida en la tienda, el anillo es su pie: va con el cursor, y verde si ahí vale.
    move:
      moundMode && mySpawn && spawnHover
        ? { center: spawnHover, range: WEAPONS.dirt.mound!.radius, hover: spawnHover }
        : moveMode && myTank
          ? { center: { x: myTank.x, z: myTank.z }, range: FUEL_MOVE_RANGE, hover: moveHover }
          : null,
    spawns,
    spawnHover: mySpawn ? spawnHover : null,
    now,
  });

  // Minimapa: mismo terreno, mismos tanques y el mismo "shot" que la vista 3D.
  const balls: MiniModel["balls"] = [];
  if (shotAnim && shotAnim.path.length >= 3 && now < shotAnim.start + shotAnim.durationMs) {
    const n = shotAnim.path.length / 3;
    const heads = shotAnim.heads ?? [];
    // Los mismos pasos que la vista 3D: los del tiro y, si se abrió, los de la cabeza que más tarda.
    const total = n - 1 + Math.max(0, ...heads.map((h) => h.path.length / 3 - 1));
    const tick = Math.floor(((now - shotAnim.start) / Math.max(1, shotAnim.durationMs)) * total);
    if (tick < n - 1 || heads.length === 0) {
      const i = Math.min(n - 1, tick);
      balls.push({ x: shotAnim.path[i * 3]!, z: shotAnim.path[i * 3 + 2]! });
    } else {
      for (const h of heads) {
        const i = tick - (n - 1);
        if (i < h.path.length / 3 - 1) balls.push({ x: h.path[i * 3]!, z: h.path[i * 3 + 2]! });
      }
    }
  }
  minimap.draw({
    terrain: terrain!,
    terrainVersion,
    tanks: tanks.map((t) => ({ x: t.x, z: t.z, color: t.color, alive: t.life > 0, isMe: t.isMe, shore: t.shore })),
    fires,
    ghost: ghost
      ? { path: ghost.path, lands: !ghost.gone, color: ghost.shooter.color, heads: ghost.heads?.map((h) => ({ path: h.path, lands: !!h.impact })), bounce: ghost.bounce }
      : null,
    // Mientras apunto: el aro de hasta dónde llega el arma elegida (el mismo número que usa el sim).
    reach: ghost ? { x: ghost.shooter.x, z: ghost.shooter.z, radius: WEAPONS[weapon].reach, color: ghost.shooter.color } : null,
    balls,
    impacts: lastImpact && now >= lastImpact.at ? lastImpact.spots : [],
    marks,
    spawns,
    gap: TANK_MIN_SEPARATION_3D,
  });
}
requestAnimationFrame(frame);

const seat = savedSeat();
if (seat) void rejoin(seat);

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
