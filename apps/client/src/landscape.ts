// SPDX-License-Identifier: GPL-2.0-or-later
// Paleta del mapa: el color sale de la altura (lago, estepa, lenga, roca, nieve) y la luz de la
// pendiente. La usan la vista 3D y el minimapa, así los dos muestran el mismo paisaje.
// Solo visual: no toca el heightmap ni ninguna regla.

import type { Terrain } from "@pegaycobra/sim";

/** sRGB, 0..1. */
export type RGB = [number, number, number];

const hex = (s: string): RGB => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as RGB;

/** Desde acá arriba todo es nieve. [wu] */
const SNOW_LINE = 40;

/** Escala de color por altura [wu]. Entre dos escalones se interpola. */
const STOPS: [number, RGB][] = [
  [0, hex("#1f9ea8")], // lago
  [0.5, hex("#58cbc2")], // orilla, agua baja
  [1.3, hex("#cdbf96")], // costa de canto rodado
  [3, hex("#bfa466")], // estepa: coirón
  [11, hex("#9e8549")],
  [14.5, hex("#34542f")], // ladera: lenga
  [25, hex("#22402a")],
  [28, hex("#7f8187")], // roca
  [SNOW_LINE - 4, hex("#9a9ca3")],
  [SNOW_LINE, hex("#f3f6fa")], // nieve
];

export const LAKE = STOPS[0]![1];
export const SKY = hex("#a5cbe8");
const ROCK = hex("#6d6a68");
/** Altura hasta la que el piso es agua: ahí no hay ni roca ni mata. [wu] */
const WATER_TOP = 1;
/** Pendiente desde la que la ladera empieza a pelarse, y desde la que ya es roca. [wu / wu] */
const SLOPE_FLAT = 0.45;
const SLOPE_STEEP = 1.3;

/** Hacia dónde está el sol (unitario). Entra desde -x, -z: en el minimapa, de arriba a la izquierda. */
export const SUN_DIR: RGB = (() => {
  const v = [-0.6, 0.62, -0.42];
  const n = Math.hypot(...v);
  return v.map((c) => c / n) as RGB;
})();

/** Gradiente de altura en la celda (x, z) por diferencias centrales. [wu / wu] */
function gradient(t: Terrain, x: number, z: number): [number, number] {
  const { width: w, depth: d, heights: h } = t;
  const xa = Math.max(0, x - 1);
  const xb = Math.min(w - 1, x + 1);
  const za = Math.max(0, z - 1);
  const zb = Math.min(d - 1, z + 1);
  return [
    (h[xb + z * w]! - h[xa + z * w]!) / Math.max(1, xb - xa),
    (h[x + zb * w]! - h[x + za * w]!) / Math.max(1, zb - za),
  ];
}

/**
 * Color de la celda (x, z) sin luz. La altura elige el escalón; un ruido suave mueve el límite
 * entre escalones para que no queden curvas de nivel, y la ladera muy empinada queda en roca
 * (ahí no se agarra ni la lenga ni la nieve).
 */
export function landColor(t: Terrain, x: number, z: number, out: RGB): RGB {
  const real = t.heights[x + z * t.width]!;
  const land = real > WATER_TOP;
  const wobble = Math.sin(x * 0.23 + z * 0.11) + Math.sin(x * 0.07 - z * 0.19) + Math.sin(x * 0.031 + z * 0.043);
  const h = land ? Math.max(WATER_TOP, real + wobble * 1.1) : Math.max(0, real);
  let k = 1;
  while (k < STOPS.length - 1 && STOPS[k]![0] < h) k++;
  const [h0, a] = STOPS[k - 1]!;
  const [h1, b] = STOPS[k]!;
  const f = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  for (let i = 0; i < 3; i++) out[i] = a[i]! + (b[i]! - a[i]!) * f;
  if (land) {
    const [gx, gz] = gradient(t, x, z);
    const s = Math.min(1, Math.max(0, (Math.hypot(gx, gz) - SLOPE_FLAT) / (SLOPE_STEEP - SLOPE_FLAT)));
    const steep = s * s * (3 - 2 * s);
    // Grano fino: cada celda un poco más clara u oscura que la de al lado.
    const grain = 0.96 + 0.08 * (((x * 73856093) ^ (z * 19349663)) >>> 0) / 0xffffffff;
    // En la nieve la roca asoma menos: el pico queda blanco aunque sea empinado.
    const bare = 0.8 * steep * (h < SNOW_LINE - 4 ? 1 : h < SNOW_LINE ? 1 - 0.7 * ((h - SNOW_LINE + 4) / 4) : 0.3);
    for (let i = 0; i < 3; i++) out[i] = (out[i]! + (ROCK[i]! - out[i]!) * bare) * grain;
  }
  return out;
}

/**
 * Luz del sol sobre la celda (x, z), para el minimapa (en 3D la calcula Three con las normales):
 * ~1 en llano, más clara la ladera que mira al sol, oscura la que le da la espalda.
 */
export function hillshade(t: Terrain, x: number, z: number): number {
  const [gx, gz] = gradient(t, x, z);
  const lit = (-gx * SUN_DIR[0] + SUN_DIR[1] - gz * SUN_DIR[2]) / Math.hypot(gx, 1, gz);
  return 0.45 + 0.55 * (Math.max(0, lit) / SUN_DIR[1]);
}
