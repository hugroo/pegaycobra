// SPDX-License-Identifier: GPL-2.0-or-later
// PRNG determinista (mulberry32). Código propio, no viene de Scorched3D:
// el original usa su RandomGenerator con aritmética fija; acá basta con que
// server y tests reproduzcan el mismo terreno con la misma semilla.

/** Devuelve una función que produce floats en [0, 1). Misma semilla → misma secuencia. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniforme en [min, max). */
export function randRange(rng: () => number, min: number, max: number): number {
  return (max - min) * rng() + min;
}
