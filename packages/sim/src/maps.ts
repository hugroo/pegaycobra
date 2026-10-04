// SPDX-License-Identifier: GPL-2.0-or-later
// Los mapas de la partida. Regla propia: el original trae un paisaje por archivo (defnhilly.xml y
// compañía); acá son tres juegos de parámetros para el mismo generador (generateTerrain, terrain.ts).
// Cambia la forma del piso y dónde nacen los tanques. Armas, daño, plata y viento son los mismos.

import { GAME_TERRAIN_3D, type TerrainParams3D } from "./terrain";

export const MAP_IDS = ["valley", "island", "hill"] as const;
export type MapId = (typeof MAP_IDS)[number];

export interface GameMap {
  id: MapId;
  name: string;
  terrain: Readonly<Partial<TerrainParams3D>>;
  /** Radio del anillo donde nacen los tanques (placeTanks3D). [fracción del medio mapa] */
  startRing: number;
}

/** El anillo de siempre: los tanques nacen a 0.72 del medio mapa, a 130–185 celdas uno de otro. */
export const START_RING = 0.72;

export const MAPS: Readonly<Record<MapId, GameMap>> = Object.freeze({
  // Agua en las orillas y piso jugable al medio: lomas bajas sobre un piso que no llega al lago.
  valley: {
    id: "valley",
    name: "Valle",
    terrain: { ...GAME_TERRAIN_3D, heightMin: 12, heightMax: 18, floor: 10, coastWater: 26, coastShore: 20, coastPower: 4 },
    startRing: 0.56,
  },
  // Un cerro rodeado de lago. Los tanques nacen en la playa: un Misil al pie los deja en el agua.
  island: {
    id: "island",
    name: "Isla",
    terrain: { ...GAME_TERRAIN_3D, hillsMin: 12, hillsMax: 18, peakWidthXMin: 25, spread: 0.22, heightMin: 45, heightMax: 60, floor: 10, coastWater: 44, coastShore: 26 },
    startRing: 0.55,
  },
  // El de siempre, sin tocar: cerros por todo el mapa y sin costa. Acá rinde el Rodillo.
  hill: { id: "hill", name: "Cerro", terrain: GAME_TERRAIN_3D, startRing: START_RING },
});

export const DEFAULT_MAP: MapId = "hill";

/** Lo que mandó el cliente → un mapa conocido, o null. */
export function parseMap(raw: unknown): MapId | null {
  return typeof raw === "string" && (MAP_IDS as readonly string[]).includes(raw) ? (raw as MapId) : null;
}
