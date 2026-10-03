// SPDX-License-Identifier: GPL-2.0-or-later
// Estado sincronizado con los clientes. El server es el único que lo escribe.
// El heightmap (257 × 257 float32) no va en el estado: viaja en mensajes binarios "terrain"
// (completo al empezar cada ronda, solo el rectángulo que cambió después de cada tiro). Ver room.ts.

import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    id: t.string().default(""),
    name: t.string().default(""),
    slot: t.uint8().default(0),
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
    /** Inventario: Missiles, paracaídas activo para la ronda, cargas de nafta. */
    missiles: t.uint16().default(0),
    parachute: t.uint8().default(0),
    fuel: t.uint16().default(0),
    /** Puntaje: daño a otros + kills. */
    points: t.int32().default(0),
    kills: t.int16().default(0),
    damage: t.uint32().default(0),
    /** Tocó "listo" en la tienda. */
    ready: t.boolean().default(false),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const GameState = schema(
  {
    code: t.string().default(""),
    /** "lobby" | "aiming" | "animating" | "shop" | "ended" */
    phase: t.string().default("lobby"),
    hostId: t.string().default(""),
    players: t.map(PlayerState),
    /** Orden de turnos (orden de llegada). */
    order: t.array("string"),
    turnId: t.string().default(""),
    /** Segundos que le quedan al turno o a la tienda. */
    timeLeft: t.uint8().default(0),
    /** Ronda en curso y total. */
    round: t.uint8().default(0),
    rounds: t.uint8().default(0),
    /** El del turno ya usó nafta. */
    moved: t.boolean().default(false),
    /** Viento en el piso (XZ). [unidad de viento] */
    windX: t.float32().default(0),
    windZ: t.float32().default(0),
    /** Tamaño del heightmap en muestras. */
    mapWidth: t.uint16().default(0),
    mapDepth: t.uint16().default(0),
    /** Con phase "ended": el ganador si es uno solo ("" si empate). */
    winnerId: t.string().default(""),
    /** Con phase "ended": todos los que terminaron primeros. */
    winners: t.array("string"),
    /** "rounds" (se jugaron las 5) o "forfeit" (se fueron todos menos uno). */
    endReason: t.string().default(""),
  },
  "GameState",
);
export type GameState = SchemaType<typeof GameState>;
