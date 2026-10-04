// SPDX-License-Identifier: GPL-2.0-or-later
// Envío del heightmap por la red. Son 257 × 257 float32 (~264 KB): se manda entero una vez al
// arrancar y, después de cada tiro, solo el rectángulo que cambió (cráter + aplanado, o loma).

import type { Terrain } from "@pegaycobra/sim";

/** Mensaje "terrain": un rectángulo [x0, x0+w) × [z0, z0+d) del heightmap, fila por fila (z). */
export interface TerrainMessage {
  width: number;
  depth: number;
  x0: number;
  z0: number;
  w: number;
  d: number;
  /** w × d float32 little-endian, índice (x - x0) + (z - z0) * w. */
  data: Uint8Array;
}

export function terrainRect(t: Terrain, x0: number, z0: number, w: number, d: number): TerrainMessage {
  const out = new Float32Array(w * d);
  for (let z = 0; z < d; z++) {
    const row = (z0 + z) * t.width + x0;
    out.set(t.heights.subarray(row, row + w), z * w);
  }
  return { width: t.width, depth: t.depth, x0, z0, w, d, data: new Uint8Array(out.buffer) };
}

export function fullTerrain(t: Terrain): TerrainMessage {
  return terrainRect(t, 0, 0, t.width, t.depth);
}

/** Rectángulo mínimo donde `a` y `b` difieren, o null si son iguales. */
export function changedRect(a: Terrain, b: Terrain): { x0: number; z0: number; w: number; d: number } | null {
  if (a.heights === b.heights) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -1;
  let maxZ = -1;
  for (let z = 0; z < a.depth; z++) {
    for (let x = 0; x < a.width; x++) {
      const i = x + z * a.width;
      if (a.heights[i] !== b.heights[i]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  if (maxX < 0) return null;
  return { x0: minX, z0: minZ, w: maxX - minX + 1, d: maxZ - minZ + 1 };
}

/** Aplica un mensaje sobre un heightmap (lo usa el test; el cliente tiene su propia copia). */
export function applyTerrainMessage(heights: Float32Array, width: number, m: TerrainMessage): void {
  const src = new Float32Array(m.data.slice().buffer);
  for (let z = 0; z < m.d; z++) heights.set(src.subarray(z * m.w, (z + 1) * m.w), (m.z0 + z) * width + m.x0);
}
