import { describe, expect, it } from "vitest";
import {
  applyCraterTerrain,
  craterDepthAt,
  createFlatTerrain,
  createRng,
  DEFAULT_TERRAIN_3D,
  driftWind3D,
  GAME_TERRAIN_3D,
  generateTerrain,
  INFINITE_AMMO,
  MONEY_START,
  placeTanks3D,
  resolveTurn,
  rollWind3D,
  simulateShot3D,
  startingInventory,
  TANK_MAX_LIFE,
  TANK_MIN_SEPARATION_3D,
  tanks3DAt,
  terrainHeightAt,
  WEAPONS,
  WIND_DRIFT_MAX,
  WIND_DRIFT_MIN,
  WIND_MAX,
  type MatchState3D,
  type Shot3DParams,
} from "../src";

const FLAT = createFlatTerrain(257, 257, 10);
const CENTER: Shot3DParams = { originX: 128, originY: 10, originZ: 128, yaw: 0, pitch: 45, power: 600, wind: { x: 0, z: 0 } };
const finite = (a: Float32Array) => a.every(Number.isFinite);

describe("terreno 3D", () => {
  it("es una grilla width × depth, finita, determinista y con bordes en 0", () => {
    const t = generateTerrain(42);
    expect(t.width).toBe(257);
    expect(t.depth).toBe(257);
    expect(t.heights).toBeInstanceOf(Float32Array);
    expect(t.heights.length).toBe(257 * 257);
    expect(finite(t.heights)).toBe(true);
    expect(generateTerrain(42).heights).toEqual(t.heights);
    for (let i = 0; i < t.width; i++) {
      expect(t.heights[i]).toBe(0); // fila z = 0
      expect(t.heights[i * t.width]).toBe(0); // columna x = 0
    }
    const max = Math.max(...t.heights);
    expect(max).toBeGreaterThan(20);
    expect(max).toBeLessThanOrEqual(DEFAULT_TERRAIN_3D.heightMax);
  });

  it("varía en las dos direcciones (no es un perfil extruido)", () => {
    const t = generateTerrain(7);
    const row = (z: number) => Array.from({ length: t.width }, (_, x) => t.heights[x + z * t.width]!);
    expect(row(80)).not.toEqual(row(170));
    const col = (x: number) => Array.from({ length: t.depth }, (_, z) => t.heights[x + z * t.width]!);
    expect(col(80)).not.toEqual(col(170));
  });

  it("interpola bilinealmente y responde en los bordes", () => {
    const t = createFlatTerrain(4, 4, 0);
    t.heights[1 + 1 * 4] = 4;
    expect(terrainHeightAt(t, 1, 1)).toBe(4);
    expect(terrainHeightAt(t, 1.5, 1)).toBe(2);
    expect(terrainHeightAt(t, 1.5, 1.5)).toBe(1);
    expect(terrainHeightAt(t, -10, 99)).toBe(0);
  });
});

describe("tiro 3D: yaw", () => {
  it("yaw 0 y yaw 180 caen en lados opuestos (en X)", () => {
    const a = simulateShot3D(FLAT, { ...CENTER, yaw: 0 });
    const b = simulateShot3D(FLAT, { ...CENTER, yaw: 180 });
    expect(a.outcome).toBe("ground");
    expect(b.outcome).toBe("ground");
    expect(a.x).toBeGreaterThan(128 + 40);
    expect(b.x).toBeLessThan(128 - 40);
    expect(a.x - 128).toBeCloseTo(128 - b.x, 5);
    expect(a.z).toBeCloseTo(128, 5);
  });

  it("yaw 90 y yaw 270 caen en lados opuestos (en Z)", () => {
    const a = simulateShot3D(FLAT, { ...CENTER, yaw: 90 });
    const b = simulateShot3D(FLAT, { ...CENTER, yaw: 270 });
    expect(a.z).toBeGreaterThan(128 + 40);
    expect(b.z).toBeLessThan(128 - 40);
    expect(a.x).toBeCloseTo(128, 4);
  });

  it("el alcance no depende del yaw sobre suelo plano y coincide con el perfil", () => {
    const reach = (yaw: number) => {
      const r = simulateShot3D(FLAT, { ...CENTER, yaw });
      return Math.hypot(r.x - 128, r.z - 128);
    };
    const r0 = reach(0);
    for (const yaw of [37, 123, 211, 300]) expect(reach(yaw)).toBeCloseTo(r0, 4);
    // Perfil: desde x = 40 cae en 133.27 → recorre 93.27 desde la base.
    expect(r0).toBeCloseTo(133.2658 - 40, 2);
  });
});

describe("tiro 3D: el viento empuja en XZ", () => {
  it("viento +X corre el impacto hacia +X, viento +Z hacia +Z", () => {
    const up = { ...CENTER, pitch: 80, power: 500 };
    const calm = simulateShot3D(FLAT, up);
    const wx = simulateShot3D(FLAT, { ...up, wind: { x: 5, z: 0 } });
    const wz = simulateShot3D(FLAT, { ...up, wind: { x: 0, z: -5 } });
    expect(wx.x).toBeGreaterThan(calm.x + 2);
    expect(wx.z).toBeCloseTo(calm.z, 6);
    expect(wz.z).toBeLessThan(calm.z - 2);
    expect(wz.x).toBeCloseTo(calm.x, 6);
  });

  it("un viento de costado desvía un tiro que va en X", () => {
    const r = simulateShot3D(FLAT, { ...CENTER, wind: { x: 0, z: 3 } });
    expect(r.z).toBeGreaterThan(129);
  });

  it("driftWind3D corre el viento un poco: nunca queda igual, nunca salta más que el tope y no pasa de WIND_MAX", () => {
    const rng = createRng(11);
    for (const start of [{ x: 0, z: 0 }, { x: WIND_MAX, z: 0 }, { x: -3, z: 4 }]) {
      let w = start;
      for (let i = 0; i < 2000; i++) {
        const next = driftWind3D(w, rng);
        const step = Math.hypot(next.x - w.x, next.z - w.z);
        expect(step).toBeGreaterThan(WIND_DRIFT_MIN / 2);
        expect(step).toBeLessThanOrEqual(WIND_DRIFT_MAX + 1e-6);
        expect(Math.hypot(next.x, next.z)).toBeLessThanOrEqual(WIND_MAX + 1e-6);
        // Sale en float32: el número que viaja por la red es el mismo con el que tira el server.
        expect(next).toEqual({ x: Math.fround(next.x), z: Math.fround(next.z) });
        w = next;
      }
    }
    // Misma semilla, mismo viento.
    expect(driftWind3D({ x: 1, z: 2 }, createRng(3))).toEqual(driftWind3D({ x: 1, z: 2 }, createRng(3)));
  });

  it("rollWind3D da vectores de módulo entero 0..5 en todas las direcciones", () => {
    const rng = createRng(5);
    const ws = Array.from({ length: 400 }, () => rollWind3D(rng));
    for (const w of ws) {
      const m = Math.hypot(w.x, w.z);
      expect(m).toBeLessThanOrEqual(WIND_MAX + 1e-9);
      expect(Math.abs(m - Math.round(m))).toBeLessThan(1e-9);
    }
    expect(ws.some((w) => w.x > 1) && ws.some((w) => w.x < -1)).toBe(true);
    expect(ws.some((w) => w.z > 1) && ws.some((w) => w.z < -1)).toBe(true);
  });
});

describe("cráter 3D: baja un disco", () => {
  const before = generateTerrain(11);
  // Sobre la cima, para que haya tierra que sacar.
  let peak = 0;
  for (let i = 1; i < before.heights.length; i++) if (before.heights[i]! > before.heights[peak]!) peak = i;
  const px = peak % before.width;
  const pz = Math.floor(peak / before.width);
  const cy = before.heights[peak]!;
  const radius = 6; // r entero 7
  const after = applyCraterTerrain(before, px, cy, pz, radius);
  const at = (t: typeof before, x: number, z: number) => t.heights[x + z * t.width]!;

  it("baja las celdas dentro del radio en todas las direcciones, no solo en una fila", () => {
    for (const [dx, dz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2]] as const) {
      expect(at(after, px + dx, pz + dz)).toBeLessThan(at(before, px + dx, pz + dz));
    }
  });

  it("la profundidad depende de la distancia al centro (simetría circular)", () => {
    const flat = createFlatTerrain(64, 64, 30);
    const hole = applyCraterTerrain(flat, 32, 30, 32, 6);
    const h = (x: number, z: number) => hole.heights[x + z * 64]!;
    expect(h(32, 32)).toBeCloseTo(30 - craterDepthAt(6, 0), 4);
    expect(h(35, 32)).toBeCloseTo(h(32, 35), 6);
    expect(h(29, 32)).toBeCloseTo(h(32, 29), 6);
    expect(h(35, 36)).toBeCloseTo(h(36, 35), 6); // dist 5 en las dos
    expect(h(35, 36)).toBeCloseTo(30 - craterDepthAt(6, 5), 4);
  });

  it("fuera del disco no cambia nada", () => {
    for (let z = 0; z < before.depth; z++) {
      for (let x = 0; x < before.width; x++) {
        if (Math.hypot(x - px, z - pz) >= 7) expect(at(after, x, z)).toBe(at(before, x, z));
      }
    }
  });

  it("no deja NaN, no sube nada y no muta la entrada", () => {
    expect(finite(after.heights)).toBe(true);
    for (let i = 0; i < before.heights.length; i++) expect(after.heights[i]!).toBeLessThanOrEqual(before.heights[i]!);
    expect(generateTerrain(11).heights).toEqual(before.heights);
  });

  it("muchos cráteres seguidos siguen finitos y no bajan de 0", () => {
    let t = before;
    for (let i = 0; i < 40; i++) t = applyCraterTerrain(t, px, terrainHeightAt(t, px, pz), pz, 18);
    expect(finite(t.heights)).toBe(true);
    expect(Math.min(...t.heights)).toBeGreaterThanOrEqual(0);
    expect(() => applyCraterTerrain(before, Number.NaN, 1, 1, 3)).toThrow(RangeError);
  });
});

describe("GAME_TERRAIN_3D", () => {
  /** Rugosidad: promedio de |segunda diferencia| en X, sobre celdas con tierra. */
  const roughness = (t: ReturnType<typeof generateTerrain>) => {
    let sum = 0;
    let n = 0;
    for (let z = 2; z < t.depth - 2; z++) {
      for (let x = 2; x < t.width - 2; x++) {
        const i = x + z * t.width;
        if (t.heights[i]! < 1) continue;
        sum += Math.abs(t.heights[i - 1]! - 2 * t.heights[i]! + t.heights[i + 1]!);
        n++;
      }
    }
    return sum / n;
  };

  it("es bastante menos rugoso que el suavizado original, con el mismo tamaño", () => {
    const orig = generateTerrain(3);
    const game = generateTerrain(3, GAME_TERRAIN_3D);
    expect(game.heights.length).toBe(orig.heights.length);
    expect(roughness(game)).toBeLessThan(roughness(orig) / 3);
    expect(Math.max(...game.heights)).toBeGreaterThan(20);
  });

  it("sigue respetando la separación de tanques", () => {
    const t = generateTerrain(8, GAME_TERRAIN_3D);
    const s = placeTanks3D(t, 4, createRng(8));
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) expect(Math.hypot(s[i]!.x - s[j]!.x, s[i]!.z - s[j]!.z)).toBeGreaterThanOrEqual(60);
  });
});

describe("ubicación 3D", () => {
  it(`dos tanques nunca nacen a menos de ${TANK_MIN_SEPARATION_3D} celdas`, () => {
    for (let seed = 1; seed <= 60; seed++) {
      const t = generateTerrain(seed);
      for (const n of [2, 3, 4]) {
        const spots = placeTanks3D(t, n, createRng(seed * 7 + n));
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const d = Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z);
            expect(d).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
          }
        }
        for (const s of spots) {
          expect(s.x).toBeGreaterThan(0);
          expect(s.z).toBeGreaterThan(0);
          expect(s.x).toBeLessThan(t.width - 1);
          expect(s.z).toBeLessThan(t.depth - 1);
        }
      }
    }
  });
});

describe("resolveTurn con yaw", () => {
  function match(): MatchState3D {
    const terrain = FLAT;
    return {
      terrain,
      wind: { x: 0, z: 0 },
      tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 128, z: 128 }, { x: 128, z: 128 + 93 }], TANK_MAX_LIFE),
      players: ["A", "B"].map((id) => ({ id, money: MONEY_START, inventory: startingInventory() })),
    };
  }

  it("apuntando con yaw 90 le pega a B (que está en +Z), paga el kill y no gasta la Baby Missile", () => {
    const { state, shot, damage } = resolveTurn(match(), { playerId: "A", yaw: 90, pitch: 45, power: 600 }, { recordPath: true });
    expect(shot.outcome).toBe("tank");
    expect(shot.tankId).toBe("B");
    expect(shot.path!.length % 3).toBe(0);
    expect(state.tanks.find((t) => t.id === "B")!.life).toBe(0);
    expect(damage.find((d) => d.killed)!.money).toBe(300 * WEAPONS.babyMissile.armsLevel);
    expect(state.players[0]!.money).toBe(MONEY_START + 3000);
    expect(state.players[0]!.inventory.babyMissile).toBe(INFINITE_AMMO);
  });

  it("con yaw 270 tira para el otro lado y no le pega", () => {
    const { state, shot } = resolveTurn(match(), { playerId: "A", yaw: 270, pitch: 45, power: 600 });
    expect(shot.z).toBeLessThan(128);
    expect(state.tanks.find((t) => t.id === "B")!.life).toBe(TANK_MAX_LIFE);
  });

  it("el cráter del resultado es un hoyo en el terreno nuevo", () => {
    const { state, shot } = resolveTurn(match(), { playerId: "A", yaw: 0, pitch: 45, power: 600 });
    expect(shot.outcome).toBe("ground");
    expect(terrainHeightAt(state.terrain, Math.trunc(shot.x), Math.trunc(shot.z))).toBeLessThan(10);
    expect(terrainHeightAt(state.terrain, Math.trunc(shot.x), Math.trunc(shot.z) + 10)).toBe(10);
  });

  it("sigue rechazando cualquier arma que no sea la Baby Missile", () => {
    expect(() => resolveTurn(match(), { playerId: "A", yaw: 0, pitch: 45, power: 600, weaponId: "babyNuke" })).toThrow();
    expect(() => resolveTurn(match(), { playerId: "A", yaw: 0, pitch: 45, power: 600, weaponId: "missile" })).toThrow();
  });

  it("el daño y el impacto los calcula el sim: campos extra del comando no cambian nada", () => {
    const clean = resolveTurn(match(), { playerId: "A", yaw: 270, pitch: 45, power: 600 });
    const dirty = resolveTurn(match(), { playerId: "A", yaw: 270, pitch: 45, power: 600, damage: 999, impactX: 128 } as never);
    expect(dirty).toEqual(clean);
  });
});
