import { describe, expect, it } from "vitest";
import {
  createFlatHeightmap,
  createRng,
  GAME_TERRAIN,
  generateHeightmap,
  spreadMinSeparation,
  spreadTanks,
  heightAt,
  matchOutcome,
  MONEY_START,
  placeTanks,
  resolveTurn,
  rollWind,
  startingInventory,
  TANK_MAX_LIFE,
  TANK_START_BORDER,
  tanksAt,
  WIND_MAX,
  type MatchState,
} from "../src";

describe("resolveTurn con recordPath", () => {
  const state: MatchState = {
    heights: createFlatHeightmap(257, 10),
    wind: 0,
    tanks: tanksAt(createFlatHeightmap(257, 10), ["A", "B"], [40, 200], TANK_MAX_LIFE),
    players: ["A", "B"].map((id) => ({ id, money: MONEY_START, inventory: startingInventory() })),
  };

  it("devuelve la lista de puntos del tiro, terminando en el impacto", () => {
    const { shot } = resolveTurn(state, { playerId: "A", angleDeg: 45, power: 600 }, { recordPath: true });
    expect(shot.path).toBeDefined();
    expect(shot.path!.length).toBe((shot.ticks + 1) * 2);
    expect(shot.path!.at(-2)).toBe(shot.x);
    expect(shot.path!.at(-1)).toBe(shot.y);
  });

  it("sin la opción no manda puntos (y el resto del resultado no cambia)", () => {
    const a = resolveTurn(state, { playerId: "A", angleDeg: 45, power: 600 });
    const b = resolveTurn(state, { playerId: "A", angleDeg: 45, power: 600 }, { recordPath: true });
    expect(a.shot.path).toBeUndefined();
    expect({ ...b.shot, path: undefined }).toEqual({ ...a.shot, path: undefined });
    expect(b.state).toEqual(a.state);
  });
});

describe("rollWind", () => {
  it("queda en [-5, 5] y es determinista por semilla", () => {
    const r1 = createRng(9);
    const r2 = createRng(9);
    for (let i = 0; i < 500; i++) {
      const w = rollWind(r1);
      expect(Math.abs(w)).toBeLessThanOrEqual(WIND_MAX);
      expect(rollWind(r2)).toBe(w);
    }
  });

  it("produce viento en las dos direcciones y a veces calma", () => {
    const rng = createRng(3);
    const ws = Array.from({ length: 500 }, () => rollWind(rng));
    expect(ws.some((w) => w > 1)).toBe(true);
    expect(ws.some((w) => w < -1)).toBe(true);
    expect(ws.some((w) => w === 0)).toBe(true);
  });
});

describe("placeTanks", () => {
  it("respeta el borde y la separación de 20 wu en terreno normal", () => {
    const h = generateHeightmap(11);
    for (const n of [2, 3, 4]) {
      const xs = placeTanks(h, n, createRng(100 + n));
      expect(xs).toHaveLength(n);
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(TANK_START_BORDER);
        expect(x).toBeLessThanOrEqual(h.length - 1 - TANK_START_BORDER);
      }
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) expect(Math.abs(xs[i]! - xs[j]!)).toBeGreaterThan(5);
    }
  });

  it("los tanques quedan apoyados en el suelo", () => {
    const h = generateHeightmap(11);
    const tanks = tanksAt(h, ["A", "B"], placeTanks(h, 2, createRng(1)), TANK_MAX_LIFE);
    for (const t of tanks) expect(t.y).toBe(heightAt(h, t.x));
  });

  it("si ningún punto sirve igual devuelve posiciones finitas", () => {
    const xs = placeTanks(createFlatHeightmap(257, 0), 4, createRng(5));
    expect(xs.every(Number.isFinite)).toBe(true);
  });
});

describe("spreadTanks (ubicación del juego)", () => {
  it("separa los tanques al menos media franja, en cualquier semilla y cantidad", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const h = generateHeightmap(seed, GAME_TERRAIN);
      for (const n of [2, 3, 4]) {
        const xs = spreadTanks(h, n, createRng(seed * 10 + n));
        const min = spreadMinSeparation(h.length, n);
        const sorted = [...xs].sort((a, b) => a - b);
        for (let i = 1; i < n; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(min - 1e-9);
        expect(sorted[0]!).toBeGreaterThanOrEqual(TANK_START_BORDER);
        expect(sorted[n - 1]!).toBeLessThanOrEqual(h.length - 1 - TANK_START_BORDER);
      }
    }
  });

  it("con 2 jugadores quedan en mitades opuestas del mapa (~59 wu o más)", () => {
    expect(spreadMinSeparation(257, 2)).toBeCloseTo(59, 0);
    const h = generateHeightmap(4, GAME_TERRAIN);
    const [a, b] = spreadTanks(h, 2, createRng(4)).sort((p, q) => p - q);
    expect(a!).toBeLessThan(128);
    expect(b!).toBeGreaterThan(128);
  });

  it("no siempre deja al primer jugador a la izquierda", () => {
    const h = generateHeightmap(1, GAME_TERRAIN);
    const firstOnLeft = Array.from({ length: 50 }, (_, s) => {
      const [x0, x1] = spreadTanks(h, 2, createRng(s));
      return x0! < x1!;
    });
    expect(firstOnLeft.some((v) => v)).toBe(true);
    expect(firstOnLeft.some((v) => !v)).toBe(true);
  });
});

describe("GAME_TERRAIN", () => {
  it("cubre todo el ancho: hay tierra en los dos cuartos de los bordes", () => {
    let left = 0;
    let right = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const h = generateHeightmap(seed, GAME_TERRAIN);
      const q = Math.floor(h.length / 4);
      for (let i = 0; i < q; i++) left += h[i]! / q / 100;
      for (let i = h.length - q; i < h.length; i++) right += h[i]! / q / 100;
    }
    expect(left).toBeGreaterThan(15);
    expect(right).toBeGreaterThan(15);
  });
});

describe("matchOutcome", () => {
  const t = (id: string, life: number) => ({ id, x: 0, y: 0, life });
  it("sigue si hay dos o más vivos", () => {
    expect(matchOutcome([t("A", 10), t("B", 5), t("C", 0)])).toEqual({ over: false });
  });
  it("gana el último vivo", () => {
    expect(matchOutcome([t("A", 0), t("B", 5)])).toEqual({ over: true, winnerId: "B" });
  });
  it("empate si mueren todos", () => {
    expect(matchOutcome([t("A", 0), t("B", 0)])).toEqual({ over: true, winnerId: null });
  });
});
