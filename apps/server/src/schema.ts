// SPDX-License-Identifier: GPL-2.0-or-later
// Estado sincronizado con los clientes. El server es el único que lo escribe.
// El heightmap (257 × 257 float32) no va en el estado: viaja en mensajes binarios "terrain"
// (completo al empezar cada ronda, solo el rectángulo que cambió después de cada tiro: un cráter
// o una loma). Ver room.ts.

import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    id: t.string().default(""),
    name: t.string().default(""),
    slot: t.uint8().default(0),
    /** Color del tanque: índice en la paleta del cliente. Distinto para cada uno de la sala. */
    color: t.uint8().default(0),
    /** Silueta: "box" (Caja), "flat" (Chato) o "tower" (Torre). Solo se dibuja. */
    hull: t.string().default("box"),
    connected: t.boolean().default(true),
    /** Base del tanque; y es la altura. [wu] */
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    /** [hp] */
    life: t.float32().default(0),
    /** Último yaw/pitch disparado, solo para dibujar el cañón. [grados] */
    yaw: t.float32().default(0),
    pitch: t.float32().default(45),
    /** Plata (solo para la tienda). [$] */
    money: t.uint32().default(0),
    /** Inventario: Missiles, Rollers, Napalm, Nukes, Tierra, Racimos, Rebotes, escudo puesto, paracaídas activo para la ronda, cargas de nafta. */
    missiles: t.uint16().default(0),
    rollers: t.uint16().default(0),
    napalms: t.uint16().default(0),
    nukes: t.uint16().default(0),
    dirts: t.uint16().default(0),
    mirvs: t.uint16().default(0),
    leapfrogs: t.uint16().default(0),
    shield: t.uint8().default(0),
    parachute: t.uint8().default(0),
    fuel: t.uint16().default(0),
    /** Puntaje: daño a otros + kills. */
    points: t.int32().default(0),
    kills: t.int16().default(0),
    damage: t.uint32().default(0),
    /** Tocó "listo" en la tienda. */
    ready: t.boolean().default(false),
    /**
     * Marca de su último tiro (ShotMark de game.ts): el recorrido [x, y, z, ...] y dónde cayó
     * [x, z, agua, ...]. Vacías hasta que cae un tiro suyo en la ronda, y mientras vuela el siguiente.
     */
    markPath: t.array("float32"),
    markSpots: t.array("float32"),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

/** Un fuego de Napalm: disco en el piso, hasta que termina la ronda. No es terreno: el heightmap no cambia. */
export const FireState = schema(
  {
    /** Centro (XZ) y radio. [wu] */
    x: t.float32().default(0),
    z: t.float32().default(0),
    radius: t.float32().default(0),
  },
  "FireState",
);
export type FireState = SchemaType<typeof FireState>;

export const GameState = schema(
  {
    code: t.string().default(""),
    /** "lobby" | "aiming" | "animating" | "shop" | "ended" */
    phase: t.string().default("lobby"),
    hostId: t.string().default(""),
    /** Mapa de la partida: "valley" (Valle), "island" (Isla) o "hill" (Cerro). Lo elige el anfitrión en la espera. */
    map: t.string().default("hill"),
    players: t.map(PlayerState),
    /** Orden de turnos (orden de llegada). */
    order: t.array("string"),
    turnId: t.string().default(""),
    /** Segundos que le quedan al turno o a la tienda. */
    timeLeft: t.uint8().default(0),
    /** Ronda en curso y total. */
    round: t.uint8().default(0),
    rounds: t.uint8().default(0),
    /** Lo que dura un turno y lo que dura la tienda en esta sala. Con `rounds`, los escribe el anfitrión en la espera. [s] */
    turnSeconds: t.uint8().default(20),
    shopSeconds: t.uint8().default(30),
    /** El del turno ya usó nafta. */
    moved: t.boolean().default(false),
    /** Viento en el piso (XZ). [unidad de viento] */
    windX: t.float32().default(0),
    windZ: t.float32().default(0),
    /** Tamaño del heightmap en muestras. */
    mapWidth: t.uint16().default(0),
    mapDepth: t.uint16().default(0),
    /** Fuegos prendidos en la ronda, en el orden en que cayeron. */
    fires: t.array(FireState),
    /** Con phase "ended": el ganador si es uno solo ("" si empate). */
    winnerId: t.string().default(""),
    /** Con phase "ended": todos los que terminaron primeros. */
    winners: t.array("string"),
    /** "rounds" (se jugaron todas) o "forfeit" (se fueron todos menos uno). */
    endReason: t.string().default(""),
  },
  "GameState",
);
export type GameState = SchemaType<typeof GameState>;
