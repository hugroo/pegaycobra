// SPDX-License-Identifier: GPL-2.0-or-later
// Armado de la partida: viento, ubicación de tanques y ganador.
// Adaptado de Scorched3D (c) 2000-2011, GPL-2.0-or-later:
//   src/common/engine/Wind.cpp                         newLevel() con WindRandom
//   src/common/landscapedef/LandscapeDefnTankStart.cpp LandscapeDefnTankStartHeight::placeTank()
//   data/globalmods/none/data/landscapes/defnhilly.xml <tankstart type="height">
// Ganador: último tanque vivo (ShowScoreSimAction.cpp premia a los tanques vivos al final).

import { WIND_MAX } from "./constants";
import { isAlive, type Tank } from "./damage";
import { heightAt, type Heightmap } from "./heightmap";

/** defnhilly.xml <startcloseness>: distancia mínima entre tanques al ubicarlos. [wu] */
export const TANK_START_CLOSENESS = 20;
/** defnhilly.xml <height><min>5.5</min><max>70</max>: altura permitida del suelo bajo el tanque. [wu] */
export const TANK_START_HEIGHT_MIN = 5.5;
export const TANK_START_HEIGHT_MAX = 70;
/** placeTank(): `const int tankBorder = 10`. [wu] */
export const TANK_START_BORDER = 10;
/** placeTank(): `int maxIt = 100`. [intentos] */
export const TANK_START_MAX_TRIES = 100;

/**
 * Viento de la ronda, ya proyectado al perfil. [unidad de viento, con signo]
 * Wind::newLevel() (WindRandom): velocidad = trunc(rand · 5.9) → 0..5 entero;
 * ángulo = rand · 360°; dirección x = sin(ángulo). En perfil solo queda la componente x.
 */
export function rollWind(rng: () => number): number {
  const speed = Math.trunc(rng() * 5.9);
  if (speed <= 0) return 0;
  const angle = rng() * 360;
  const x = speed * Math.sin((angle * Math.PI) / 180);
  return Math.max(-WIND_MAX, Math.min(WIND_MAX, x));
}

/**
 * Ubica `count` tanques sobre el terreno. Devuelve las x [wu] en el orden de los jugadores.
 * LandscapeDefnTankStartHeight::placeTank(), por cada tanque:
 *   hasta 100 intentos; x al azar dentro de un borde de 10 wu;
 *   se descarta si la altura del suelo no está en [5.5, 70];
 *   se descarta si queda a menos de `closeness · i / 100` de otro tanque
 *   (la exigencia se afloja a medida que se gastan intentos).
 * Si se agotan los intentos, se queda con el último candidato, como el original.
 */
export function placeTanks(heights: Heightmap, count: number, rng: () => number): number[] {
  const mapWidth = heights.length - 1;
  const placed: number[] = [];
  for (let n = 0; n < count; n++) {
    let x = 0;
    for (let i = TANK_START_MAX_TRIES; i > 0; i--) {
      x = (mapWidth - TANK_START_BORDER * 2) * rng() + TANK_START_BORDER;
      const h = heights[Math.trunc(x)]!;
      if (h < TANK_START_HEIGHT_MIN || h > TANK_START_HEIGHT_MAX) continue;
      const closeness = (TANK_START_CLOSENESS * i) / TANK_START_MAX_TRIES;
      if (placed.some((p) => Math.abs(p - x) < closeness)) continue;
      break;
    }
    placed.push(x);
  }
  return placed;
}

/**
 * Terreno que usa el juego. Diferencia deliberada con defnhilly.xml: sin levelSurround
 * (en 1D eso deja los bordes en 0 y junta toda la tierra en un cerro central) y algunas
 * colinas más para que el perfil cubra todo el ancho. La generación es la misma.
 */
export const GAME_TERRAIN = Object.freeze({ levelSurround: false, hillsMin: 14, hillsMax: 20 });

/**
 * Ubicación del juego: reparte los tanques a lo ancho. Regla propia, no del original
 * (placeTanks() del original los tira al azar y puede dejarlos juntos en el mismo pico).
 *
 * El ancho útil (sin TANK_START_BORDER a cada lado) se parte en `count` franjas iguales y cada
 * tanque cae al azar en la mitad central de una franja distinta, en orden aleatorio. Así la
 * separación mínima es media franja: ~59 wu con 2 jugadores y ~30 wu con 4.
 * Dentro de su zona se prefiere suelo en [TANK_START_HEIGHT_MIN, TANK_START_HEIGHT_MAX].
 */
export function spreadTanks(heights: Heightmap, count: number, rng: () => number): number[] {
  if (count <= 0) return [];
  const mapWidth = heights.length - 1;
  const usable = mapWidth - TANK_START_BORDER * 2;
  const slot = usable / count;

  // Orden aleatorio de franjas (Fisher-Yates) para que el anfitrión no quede siempre a la izquierda.
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  return order.map((s) => {
    const lo = TANK_START_BORDER + slot * s + slot / 4;
    let x = lo + slot / 4; // centro de la franja, por si nada cumple la altura
    for (let i = 0; i < TANK_START_MAX_TRIES; i++) {
      const cand = lo + rng() * (slot / 2);
      const h = heights[Math.trunc(cand)]!;
      if (h >= TANK_START_HEIGHT_MIN && h <= TANK_START_HEIGHT_MAX) {
        x = cand;
        break;
      }
    }
    return x;
  });
}

/** Separación mínima que garantiza spreadTanks() para `count` tanques en un mapa de `width` muestras. [wu] */
export function spreadMinSeparation(width: number, count: number): number {
  return (width - 1 - TANK_START_BORDER * 2) / count / 2;
}

/** Tanques en sus posiciones, apoyados en el suelo (getInterpHeight). */
export function tanksAt(heights: Heightmap, ids: readonly string[], xs: readonly number[], life: number): Tank[] {
  return ids.map((id, i) => {
    const x = xs[i]!;
    return { id, x, y: heightAt(heights, x), life };
  });
}

export type MatchOutcome =
  | { over: false }
  | { over: true; winnerId: string }
  | { over: true; winnerId: null }; // empate: murieron todos en el mismo tiro

/** La partida termina cuando queda uno vivo (gana) o ninguno (empate). */
export function matchOutcome(tanks: readonly Tank[]): MatchOutcome {
  const alive = tanks.filter(isAlive);
  if (alive.length > 1) return { over: false };
  return { over: true, winnerId: alive[0]?.id ?? null };
}
