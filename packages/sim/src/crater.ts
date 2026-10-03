// SPDX-License-Identifier: GPL-2.0-or-later
// Cráter sobre el heightmap. Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/landscapemap/DeformLandscape.cpp
//     DeformLandscapeCacheItem (perfil de profundidad) y deformLandscapeInternal() (down = true)
//   src/common/actions/Explosion.cpp (el cráter usa el radio de la explosión, `deformsize` = `size`)
//   DeformLandscape::flattenAreaInternal() para aplanar bajo un tanque que cae.

import { CRATER_MAX_RADIUS, FLATTEN_HALF_WIDTH, MIN_LAND_HEIGHT } from "./constants";
import type { Heightmap } from "./heightmap";

/**
 * Profundidad del cráter a distancia horizontal `dist` [wu] del centro.
 * DeformLandscapeCacheItem: `sin(((r - dist) / r) · π/2) · r`, con r = trunc(radius) + 1.
 * Devuelve 0 fuera del radio. [wu]
 */
export function craterDepthAt(radius: number, dist: number): number {
  const r = craterIntRadius(radius);
  if (r === 0) return 0;
  const d = Math.abs(dist);
  if (d >= r) return 0;
  return Math.sin(((r - d) / r) * (Math.PI / 2)) * r;
}

/** Radio entero que usa el original: `radius.asInt() + 1`, tope 49. 0 si no hay cráter. [wu] */
export function craterIntRadius(radius: number): number {
  if (!(radius > 0)) return 0;
  return Math.min(Math.trunc(radius) + 1, CRATER_MAX_RADIUS);
}

/**
 * Abre un cráter centrado en (cx, cy) [wu] y devuelve un heightmap nuevo.
 *
 * Por cada columna dentro del radio, con `depth` = profundidad en esa columna:
 *   - si el suelo está por debajo de cy - depth, no se toca (la bola no llega);
 *   - si el suelo está por encima de cy + depth, baja 2·depth (atraviesa la esfera);
 *   - si no, queda en cy - depth (el fondo de la esfera).
 * Nunca baja de MIN_LAND_HEIGHT. Las columnas de los bordes (0 y width-1) no se tocan.
 */
export function applyCrater(
  heights: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  depthScale = 1,
): Heightmap {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius)) {
    throw new RangeError(`applyCrater: coordenadas no finitas (${cx}, ${cy}, r=${radius})`);
  }
  const out = heights.slice();
  const r = craterIntRadius(radius);
  if (r === 0) return out;

  const mapWidth = out.length - 1;
  const ix = Math.trunc(cx);
  for (let x = -r; x <= r; x++) {
    const absx = ix + x;
    if (absx <= 0 || absx >= mapWidth) continue;
    const depth = craterDepthAt(radius, x) * depthScale;
    if (depth === 0) continue;

    const current = out[absx]!;
    if (current <= cy - depth) continue;

    let next = current > cy + depth ? current - 2 * depth : cy - depth;
    if (next < MIN_LAND_HEIGHT) next = current < MIN_LAND_HEIGHT ? current : MIN_LAND_HEIGHT;
    out[absx] = next;
  }
  return out;
}

/**
 * Aplana el terreno bajo un tanque que terminó de caer: las columnas en
 * [trunc(x) - 2, trunc(x) + 2] quedan a la altura `y` del tanque [wu].
 * DeformLandscape::flattenAreaInternal().
 */
export function flattenUnder(heights: Heightmap, x: number, y: number): Heightmap {
  const out = heights.slice();
  const ix = Math.trunc(x);
  const mapWidth = out.length - 1;
  for (let dx = -FLATTEN_HALF_WIDTH; dx <= FLATTEN_HALF_WIDTH; dx++) {
    const i = ix + dx;
    if (i < 0 || i >= mapWidth) continue;
    const current = out[i]!;
    let next = y;
    if (next < MIN_LAND_HEIGHT) next = current < MIN_LAND_HEIGHT ? current : MIN_LAND_HEIGHT;
    out[i] = next;
  }
  return out;
}
