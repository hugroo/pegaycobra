// SPDX-License-Identifier: GPL-2.0-or-later
// Generación del heightmap. Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/landscapemap/HeightMapModifier.cpp
//     generateTerrain(), addCirclePeak(), scale(), smooth(), levelSurround()
//   Parámetros por defecto: data/globalmods/none/data/landscapes/defnhilly.xml
//
// El original genera un mapa 2D (x, y) y la altura es z. Acá la vista es de perfil:
// el heightmap es una sola fila. `heights[i]` = altura [wu] en x = i [wu].
// Cambios respecto del original, a propósito:
//   - Las semiesferas se evalúan solo sobre la fila (distY = 0).
//   - La cantidad de colinas baja, porque en 2D la mayoría no cruza una fila dada.
//   - El kernel de smooth es de 5 muestras en 1D en vez de 5x5.
//   - No hay noise, erosión ni máscara (el original las aplica según el landscape).

import { createRng, randRange } from "./rng";

/** Heightmap de perfil: índice = x [wu], valor = altura [wu]. */
export type Heightmap = Float32Array;

export interface TerrainParams {
  /** Cantidad de muestras. La última x válida es width - 1. [muestras] */
  width: number;
  /** Cantidad de semiesferas, uniforme en [min, max). [colinas] */
  hillsMin: number;
  hillsMax: number;
  /** Altura máxima final tras `scale`, uniforme en [min, max). [wu] */
  heightMin: number;
  heightMax: number;
  /** Radio de cada semiesfera en x. [wu] */
  peakWidthXMin: number;
  peakWidthXMax: number;
  /** Delta del segundo radio (en el original, el eje y). Estira la semiesfera en x. [wu] */
  peakWidthYMin: number;
  peakWidthYMax: number;
  /** Altura de cada semiesfera relativa a su ancho. [wu / wu] */
  peakHeightMin: number;
  peakHeightMax: number;
  /** Peso de los vecinos en el smooth (el centro pesa 1). [adimensional] */
  smoothing: number;
  /** Bajar los bordes a 0 y no poner colinas pegadas al borde. */
  levelSurround: boolean;
}

/** defnhilly.xml, salvo `width` y la cantidad de colinas (ver nota arriba). */
export const DEFAULT_TERRAIN: Readonly<TerrainParams> = Object.freeze({
  width: 257, // landscapewidth 256 → 257 muestras (el original guarda mapWidth + 1)
  hillsMin: 10, // original 50..70 sobre 256x256; ~1/4 cruzan una fila
  hillsMax: 16,
  heightMin: 50,
  heightMax: 70,
  peakWidthXMin: 10,
  peakWidthXMax: 50,
  peakWidthYMin: -10,
  peakWidthYMax: 10,
  peakHeightMin: 0.5,
  peakHeightMax: 1.5,
  smoothing: 0.04,
  levelSurround: true,
});

/** Heightmap plano a altura `height` [wu]. */
export function createFlatHeightmap(width: number, height: number): Heightmap {
  return new Float32Array(width).fill(height);
}

/**
 * Altura del terreno en una x continua [wu], con interpolación lineal
 * (equivalente 1D de GroundMaps::getInterpHeight). Fuera de rango, se toma el borde.
 */
export function heightAt(heights: Heightmap, x: number): number {
  const last = heights.length - 1;
  if (!(x > 0)) return heights[0] ?? 0; // también atrapa NaN
  if (x >= last) return heights[last] ?? 0;
  const i = Math.floor(x);
  const t = x - i;
  const a = heights[i]!;
  const b = heights[i + 1]!;
  return a + (b - a) * t;
}

/**
 * Suma una semiesfera de coseno centrada en `sx`.
 * HeightMapModifier::addCirclePeak(): perfil `cos(dist·π/sizew)·sizeh/4 + sizeh/4`,
 * con la distancia alterada al azar hasta ±10% para que no sea un domo perfecto.
 * Muta `heights` (uso interno de generateHeightmap).
 */
function addCirclePeak(
  heights: Heightmap,
  sx: number,
  sizew: number,
  sizew2: number,
  sizeh: number,
  offsetRng: () => number,
): void {
  const mapWidth = heights.length - 1;
  const maxdist = Math.max(sizew2, sizew);
  const sizewsq = sizew * sizew * 1.2;
  const startx = Math.max(0, Math.trunc(sx - maxdist));
  const endx = Math.min(mapWidth, Math.trunc(sx + maxdist));
  const pt2 = 1 / 5;

  for (let x = startx; x <= endx; x++) {
    const distX = ((x - sx) * sizew2) / sizew;
    const distsq = distX * distX; // distY = 0: estamos sobre la fila
    if (distsq < sizewsq) {
      let dist = Math.sqrt(distsq);
      const distRand = Math.min((dist / 20) * pt2, pt2);
      dist *= offsetRng() * distRand + 1 - distRand / 2;
      if (dist < sizew) {
        heights[x] = heights[x]! + Math.cos((dist * Math.PI) / sizew) * (sizeh / 4) + sizeh / 4;
      }
    }
  }
}

/**
 * Reescala para que la altura máxima sea `targetMax` [wu].
 * HeightMapModifier::scale(): `per = realMax / max; height *= per`.
 * Si el mapa es todo cero (o negativo), devuelve ceros en vez de NaN/Infinity.
 */
export function scaleHeightmap(heights: Heightmap, targetMax: number): Heightmap {
  let max = -Infinity;
  for (const h of heights) if (h > max) max = h;
  const out = new Float32Array(heights.length);
  if (!(max > 0)) return out;
  const per = targetMax / max;
  for (let i = 0; i < heights.length; i++) out[i] = heights[i]! * per;
  return out;
}

/**
 * Suavizado por promedio ponderado de 5 muestras: los 4 vecinos pesan `smoothing`
 * y el centro pesa 1. Cerca de los bordes se normaliza por los pesos usados.
 * HeightMapModifier::smooth() (matriz 5x5 en el original).
 */
export function smoothHeightmap(heights: Heightmap, smoothing: number): Heightmap {
  if (smoothing === 0) return heights.slice();
  const n = heights.length;
  const out = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    let inc = 0;
    let total = 0;
    for (let i = -2; i <= 2; i++) {
      const xi = x + i;
      if (xi < 0 || xi >= n) continue;
      const w = i === 0 ? 1 : smoothing;
      inc += w * heights[xi]!;
      total += w;
    }
    out[x] = inc / total;
  }
  return out;
}

/** Pone en 0 las dos muestras de cada borde. HeightMapModifier::levelSurround(). */
export function levelSurround(heights: Heightmap): Heightmap {
  const out = heights.slice();
  const n = out.length;
  for (const i of [0, 1, n - 2, n - 1]) if (i >= 0 && i < n) out[i] = 0;
  return out;
}

/**
 * Terreno procedural: semiesferas sumadas → scale → levelSurround → smooth → levelSurround.
 * Mismo orden que HeightMapModifier::generateTerrain() (sin noise ni erosión).
 * Determinista: misma semilla y parámetros → mismo Float32Array.
 */
export function generateHeightmap(seed: number, params: Partial<TerrainParams> = {}): Heightmap {
  const p: TerrainParams = { ...DEFAULT_TERRAIN, ...params };
  if (!Number.isInteger(p.width) || p.width < 5) {
    throw new RangeError(`width debe ser un entero >= 5 (recibido ${p.width})`);
  }
  const rng = createRng(seed);
  // El original usa un segundo generador ("offsetGenerator") para el ruido de los bordes.
  const offsetRng = createRng(seed ^ 0x5bd1e995);
  const mapWidth = p.width - 1;

  let heights: Heightmap = new Float32Array(p.width);

  const hills = Math.trunc(randRange(rng, p.hillsMin, p.hillsMax));
  for (let i = 0; i < hills; i++) {
    const sizew = randRange(rng, p.peakWidthXMin, p.peakWidthXMax);
    const sizew2 = randRange(rng, p.peakWidthYMin, p.peakWidthYMax) + sizew;
    const sizeh = randRange(rng, p.peakHeightMin, p.peakHeightMax) * Math.max(sizew, sizew2);

    const border = p.levelSurround ? Math.max(sizew, sizew2) * 1.2 : 0;
    const sx = rng() * (mapWidth - border * 2) + border;

    addCirclePeak(heights, sx, sizew, sizew2, sizeh, offsetRng);
  }

  heights = scaleHeightmap(heights, randRange(rng, p.heightMin, p.heightMax));
  if (p.levelSurround) heights = levelSurround(heights);
  heights = smoothHeightmap(heights, p.smoothing);
  if (p.levelSurround) heights = levelSurround(heights);
  return heights;
}
