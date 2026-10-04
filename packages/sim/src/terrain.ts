// SPDX-License-Identifier: GPL-2.0-or-later
// Terreno 3D: grilla width × depth, altura en Y. Port directo de Scorched3D (c) 2000-2011,
// GPL-2.0-or-later, esta vez en dos dimensiones como el original:
//   src/common/landscapemap/HeightMapModifier.cpp
//     generateTerrain(), addCirclePeak(), scale(), smooth() (matriz 5x5), levelSurround()
//   src/common/landscapemap/DeformLandscape.cpp
//     DeformLandscapeCacheItem + deformLandscapeInternal() (cráter = disco; con down = false, loma),
//     flattenAreaInternal()
//   data/globalmods/none/data/landscapes/defnhilly.xml (parámetros por defecto)
//
// Ejes: el original usa (x, y) en el piso y z como altura. Acá el piso es (x, z) y la altura es y,
// que es lo que espera Three.js. heights[x + z * width] = altura [wu] en la celda (x, z).
// Sin noise, erosión ni máscara (como en el perfil).

import { CRATER_MAX_RADIUS, FLATTEN_HALF_WIDTH, MIN_LAND_HEIGHT, WATER_LEVEL } from "./constants";
import { craterDepthAt, craterIntRadius } from "./crater";
import { createRng, randRange } from "./rng";

export interface Terrain {
  /** Muestras en X. La última x válida es width - 1. */
  readonly width: number;
  /** Muestras en Z. La última z válida es depth - 1. */
  readonly depth: number;
  /** heights[x + z * width] [wu] */
  readonly heights: Float32Array;
}

export interface TerrainParams3D {
  width: number;
  depth: number;
  hillsMin: number;
  hillsMax: number;
  heightMin: number;
  heightMax: number;
  peakWidthXMin: number;
  peakWidthXMax: number;
  peakWidthYMin: number;
  peakWidthYMax: number;
  peakHeightMin: number;
  peakHeightMax: number;
  smoothing: number;
  levelSurround: boolean;
  // Lo que sigue es propio (el original da la forma con una máscara por paisaje): con los valores
  // por defecto no hace nada y sale el terreno de siempre.
  /** Parte del mapa, centrada, donde caen los centros de las colinas. 1 = todo el mapa. [fracción] */
  spread: number;
  /** Piso que se suma debajo de las colinas, antes de recortar la costa. [wu] */
  floor: number;
  /** Agua desde el borde del mapa hacia adentro, medida sobre los ejes. 0 = sin costa. [celdas] */
  coastWater: number;
  /** Ancho de la playa: de la orilla hasta donde el piso ya está entero. [celdas] */
  coastShore: number;
  /** Forma de la costa: 2 = redonda; más alto, más cuadrada. [exponente] */
  coastPower: number;
}

/** defnhilly.xml tal cual: 256×256 celdas (257 muestras por lado), 50–70 semiesferas. */
export const DEFAULT_TERRAIN_3D: Readonly<TerrainParams3D> = Object.freeze({
  width: 257,
  depth: 257,
  hillsMin: 50,
  hillsMax: 70,
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
  spread: 1,
  floor: 0,
  coastWater: 0,
  coastShore: 0,
  coastPower: 2,
});

/**
 * Terreno que usa la partida 3D: defnhilly.xml con un suavizado más fuerte (5×5 con todos los
 * pesos iguales en vez de 0.04). Diferencia deliberada: con el ruido por celda de addCirclePeak y
 * el suavizado original, el mesh se ve como pelusa bajo luz por vértice. La física usa este mismo
 * terreno, así que lo que se ve es lo que choca.
 */
export const GAME_TERRAIN_3D: Readonly<Partial<TerrainParams3D>> = Object.freeze({ smoothing: 1 });

export function createFlatTerrain(width: number, depth: number, height: number): Terrain {
  return { width, depth, heights: new Float32Array(width * depth).fill(height) };
}

export function heightIndex(t: Terrain, x: number, z: number): number {
  return x + z * t.width;
}

/**
 * Altura en (x, z) continuos con interpolación bilineal (GroundMaps::getInterpHeight).
 * Fuera del mapa se toma el borde más cercano. [wu]
 */
export function terrainHeightAt(t: Terrain, x: number, z: number): number {
  const maxX = t.width - 1;
  const maxZ = t.depth - 1;
  const cx = Number.isFinite(x) ? Math.min(maxX, Math.max(0, x)) : 0;
  const cz = Number.isFinite(z) ? Math.min(maxZ, Math.max(0, z)) : 0;
  const x0 = Math.min(Math.floor(cx), maxX - 1);
  const z0 = Math.min(Math.floor(cz), maxZ - 1);
  const fx = cx - x0;
  const fz = cz - z0;
  const h = t.heights;
  const w = t.width;
  const a = h[x0 + z0 * w]!;
  const b = h[x0 + 1 + z0 * w]!;
  const c = h[x0 + (z0 + 1) * w]!;
  const d = h[x0 + 1 + (z0 + 1) * w]!;
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

/** ¿El piso en (x, z) es agua? (WATER_LEVEL). Lo que no es agua es piso firme. */
export function isWater(t: Terrain, x: number, z: number): boolean {
  return terrainHeightAt(t, x, z) <= WATER_LEVEL;
}

/** HeightMapModifier::addCirclePeak(), sin cambios salvo el nombre de los ejes. Muta `h`. */
function addCirclePeak(
  t: Terrain,
  sx: number,
  sz: number,
  sizew: number,
  sizew2: number,
  sizeh: number,
  offsetRng: () => number,
): void {
  const mapW = t.width - 1;
  const mapD = t.depth - 1;
  const h = t.heights;
  const maxdist = Math.max(sizew2, sizew);
  const sizewsq = sizew * sizew * 1.2;
  const startx = Math.max(0, Math.trunc(sx - maxdist));
  const startz = Math.max(0, Math.trunc(sz - maxdist));
  const endx = Math.min(mapW, Math.trunc(sx + maxdist));
  const endz = Math.min(mapD, Math.trunc(sz + maxdist));
  const pt2 = 1 / 5;
  for (let x = startx; x <= endx; x++) {
    for (let z = startz; z <= endz; z++) {
      const distX = ((x - sx) * sizew2) / sizew;
      const distZ = z - sz;
      const distsq = distX * distX + distZ * distZ;
      if (distsq < sizewsq) {
        let dist = Math.sqrt(distsq);
        const distRand = Math.min((dist / 20) * pt2, pt2);
        dist *= offsetRng() * distRand + 1 - distRand / 2;
        if (dist < sizew) {
          const i = x + z * t.width;
          h[i] = h[i]! + Math.cos((dist * Math.PI) / sizew) * (sizeh / 4) + sizeh / 4;
        }
      }
    }
  }
}

/** HeightMapModifier::scale(): la cima más alta pasa a medir `targetMax`. Mapa vacío → ceros. */
export function scaleTerrain(t: Terrain, targetMax: number): Terrain {
  let max = -Infinity;
  for (const v of t.heights) if (v > max) max = v;
  const out = new Float32Array(t.heights.length);
  if (max > 0) {
    const per = targetMax / max;
    for (let i = 0; i < out.length; i++) out[i] = t.heights[i]! * per;
  }
  return { width: t.width, depth: t.depth, heights: out };
}

/** HeightMapModifier::smooth(): matriz 5x5, vecinos con peso `smoothing`, centro con peso 1. */
export function smoothTerrain(t: Terrain, smoothing: number): Terrain {
  if (smoothing === 0) return { ...t, heights: t.heights.slice() };
  const { width: w, depth: d, heights: h } = t;
  const out = new Float32Array(h.length);
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      let inc = 0;
      let total = 0;
      for (let j = -2; j <= 2; j++) {
        const zz = z + j;
        if (zz < 0 || zz >= d) continue;
        for (let i = -2; i <= 2; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w) continue;
          const wt = i === 0 && j === 0 ? 1 : smoothing;
          inc += wt * h[xx + zz * w]!;
          total += wt;
        }
      }
      out[x + z * w] = inc / total;
    }
  }
  return { width: w, depth: d, heights: out };
}

/** HeightMapModifier::levelSurround(): las dos filas y columnas de cada borde a 0. */
export function levelSurroundTerrain(t: Terrain): Terrain {
  const h = t.heights.slice();
  const { width: w, depth: d } = t;
  for (let x = 0; x < w; x++) for (const z of [0, 1, d - 2, d - 1]) h[x + z * w] = 0;
  for (let z = 0; z < d; z++) for (const x of [0, 1, w - 2, w - 1]) h[x + z * w] = 0;
  return { width: w, depth: d, heights: h };
}

/** Cuánto se corre la orilla de su línea, para un lado y para el otro. [fracción del radio de tierra] */
const COAST_WOBBLE = 0.1;

/**
 * Costa (regla propia): suma `floor` y hunde todo lo que queda a menos de `coastWater` celdas del
 * borde. La distancia al centro se mide con el exponente `coastPower` (2 = círculo, 4 = cuadrado de
 * esquinas redondas), y entre la orilla y `coastShore` celdas tierra adentro el piso sube de 0 a
 * entero: esa es la playa. Tres ondas con fase al azar mueven la orilla para que no salga de compás.
 * Muta `t`: no arma otra grilla.
 */
function sinkCoast(t: Terrain, p: TerrainParams3D, rng: () => number): void {
  const cx = (t.width - 1) / 2;
  const cz = (t.depth - 1) / 2;
  const land = Math.min(cx, cz) - p.coastWater;
  const phases = [rng(), rng(), rng()].map((v) => v * Math.PI * 2);
  const h = t.heights;
  for (let z = 0; z < t.depth; z++) {
    for (let x = 0; x < t.width; x++) {
      const dx = Math.abs(x - cx);
      const dz = Math.abs(z - cz);
      const dist = (dx ** p.coastPower + dz ** p.coastPower) ** (1 / p.coastPower);
      const a = Math.atan2(z - cz, x - cx);
      const wave = 0.5 * Math.sin(2 * a + phases[0]!) + 0.3 * Math.sin(3 * a + phases[1]!) + 0.2 * Math.sin(5 * a + phases[2]!);
      const inland = land * (1 + COAST_WOBBLE * wave) - dist;
      const k = inland <= 0 ? 0 : inland >= p.coastShore ? 1 : inland / p.coastShore;
      const i = x + z * t.width;
      h[i] = (h[i]! + p.floor) * (k * k * (3 - 2 * k));
    }
  }
}

/**
 * HeightMapModifier::generateTerrain(): semiesferas al azar → scale → levelSurround → smooth →
 * levelSurround. Determinista por semilla. Con `spread` las colinas se juntan al medio y con
 * `coastWater` el borde se hunde (sinkCoast, después de scale): de ahí salen los mapas (maps.ts).
 */
export function generateTerrain(seed: number, params: Partial<TerrainParams3D> = {}): Terrain {
  const p: TerrainParams3D = { ...DEFAULT_TERRAIN_3D, ...params };
  if (!Number.isInteger(p.width) || !Number.isInteger(p.depth) || p.width < 5 || p.depth < 5) {
    throw new RangeError(`terreno inválido: ${p.width}×${p.depth}`);
  }
  const rng = createRng(seed);
  const offsetRng = createRng(seed ^ 0x5bd1e995);
  const mapW = p.width - 1;
  const mapD = p.depth - 1;
  let t: Terrain = { width: p.width, depth: p.depth, heights: new Float32Array(p.width * p.depth) };

  const hills = Math.trunc(randRange(rng, p.hillsMin, p.hillsMax));
  for (let i = 0; i < hills; i++) {
    const sizew = randRange(rng, p.peakWidthXMin, p.peakWidthXMax);
    const sizew2 = randRange(rng, p.peakWidthYMin, p.peakWidthYMax) + sizew;
    const sizeh = randRange(rng, p.peakHeightMin, p.peakHeightMax) * Math.max(sizew, sizew2);
    const border = p.levelSurround ? Math.max(sizew, sizew2) * 1.2 : 0;
    let sx = rng() * (mapW - border * 2) + border;
    let sz = rng() * (mapD - border * 2) + border;
    if (p.spread < 1) {
      sx = mapW / 2 + (sx - mapW / 2) * p.spread;
      sz = mapD / 2 + (sz - mapD / 2) * p.spread;
    }
    addCirclePeak(t, sx, sz, sizew, sizew2, sizeh, offsetRng);
  }

  t = scaleTerrain(t, randRange(rng, p.heightMin, p.heightMax));
  if (p.coastWater > 0) sinkCoast(t, p, rng);
  if (p.levelSurround) t = levelSurroundTerrain(t);
  t = smoothTerrain(t, p.smoothing);
  if (p.levelSurround) t = levelSurroundTerrain(t);
  return t;
}

/**
 * Cráter: baja un disco centrado en (cx, cz) con el centro de la esfera a altura cy.
 * DeformLandscape::deformLandscapeInternal(), down = true. Por cada celda con
 * dist = √(dx² + dz²) < r (r = trunc(radius) + 1, tope 49):
 *   depth = sin(((r - dist) / r) · π/2) · r
 *   suelo por debajo de cy - depth → no se toca; por encima de cy + depth → baja 2·depth;
 *   si no → queda en cy - depth. Nunca por debajo de MIN_LAND_HEIGHT. Bordes del mapa intactos.
 */
export function applyCraterTerrain(t: Terrain, cx: number, cy: number, cz: number, radius: number): Terrain {
  if (![cx, cy, cz, radius].every(Number.isFinite)) {
    throw new RangeError(`cráter con coordenadas no finitas (${cx}, ${cy}, ${cz}, r=${radius})`);
  }
  const h = t.heights.slice();
  const out: Terrain = { width: t.width, depth: t.depth, heights: h };
  const r = Math.min(craterIntRadius(radius), CRATER_MAX_RADIUS);
  if (r === 0) return out;
  const mapW = t.width - 1;
  const mapD = t.depth - 1;
  const ix = Math.trunc(cx);
  const iz = Math.trunc(cz);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const depth = craterDepthAt(radius, Math.sqrt(dx * dx + dz * dz));
      if (depth === 0) continue;
      const ax = ix + dx;
      const az = iz + dz;
      if (ax <= 0 || ax >= mapW || az <= 0 || az >= mapD) continue;
      const i = ax + az * t.width;
      const current = h[i]!;
      if (current <= cy - depth) continue;
      let next = current > cy + depth ? current - 2 * depth : cy - depth;
      if (next < MIN_LAND_HEIGHT) next = current < MIN_LAND_HEIGHT ? current : MIN_LAND_HEIGHT;
      h[i] = next;
    }
  }
  return out;
}

/**
 * Loma: sube un disco centrado en (cx, cz) con el centro de la esfera a altura cy.
 * DeformLandscape::deformLandscapeInternal(), down = false. Mismo disco y mismo perfil que el
 * cráter (depth = sin(((r - dist) / r) · π/2) · r, con r = trunc(radius) + 1, tope 49):
 *   suelo por debajo de cy + depth → sube depth; si no → no se toca (ya asoma sobre la esfera).
 * Diferencia deliberada: la celda que sube no pasa de cy + depth. En el original sí pasa, y en una
 * ladera queda un escalón contra la celda de al lado, que por estar apenas más alta no se tocó.
 * No tiene techo: tierra sobre tierra sigue subiendo. Bordes del mapa intactos.
 */
export function applyMoundTerrain(t: Terrain, cx: number, cy: number, cz: number, radius: number): Terrain {
  if (![cx, cy, cz, radius].every(Number.isFinite)) {
    throw new RangeError(`loma con coordenadas no finitas (${cx}, ${cy}, ${cz}, r=${radius})`);
  }
  const h = t.heights.slice();
  const out: Terrain = { width: t.width, depth: t.depth, heights: h };
  const r = Math.min(craterIntRadius(radius), CRATER_MAX_RADIUS);
  if (r === 0) return out;
  const mapW = t.width - 1;
  const mapD = t.depth - 1;
  const ix = Math.trunc(cx);
  const iz = Math.trunc(cz);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const depth = craterDepthAt(radius, Math.sqrt(dx * dx + dz * dz));
      if (depth === 0) continue;
      const ax = ix + dx;
      const az = iz + dz;
      if (ax <= 0 || ax >= mapW || az <= 0 || az >= mapD) continue;
      const i = ax + az * t.width;
      const top = cy + depth;
      if (h[i]! < top) h[i] = Math.min(h[i]! + depth, top);
    }
  }
  return out;
}

/** DeformLandscape::flattenAreaInternal(): cuadrado de (2·2+1)² celdas a la altura `y`. */
export function flattenTerrainUnder(t: Terrain, x: number, y: number, z: number): Terrain {
  const h = t.heights.slice();
  const ix = Math.trunc(x);
  const iz = Math.trunc(z);
  for (let dz = -FLATTEN_HALF_WIDTH; dz <= FLATTEN_HALF_WIDTH; dz++) {
    for (let dx = -FLATTEN_HALF_WIDTH; dx <= FLATTEN_HALF_WIDTH; dx++) {
      const ax = ix + dx;
      const az = iz + dz;
      if (ax < 0 || az < 0 || ax >= t.width - 1 || az >= t.depth - 1) continue;
      const i = ax + az * t.width;
      let next = y;
      if (next < MIN_LAND_HEIGHT) next = h[i]! < MIN_LAND_HEIGHT ? h[i]! : MIN_LAND_HEIGHT;
      h[i] = next;
    }
  }
  return { width: t.width, depth: t.depth, heights: h };
}
