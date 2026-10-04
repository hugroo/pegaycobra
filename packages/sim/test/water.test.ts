import { describe, expect, it } from "vitest";
import {
  createFlatTerrain,
  createRng,
  FUEL_MOVE_RANGE,
  MONEY_START,
  onShore,
  PARACHUTE_LINE,
  placeTanks3D,
  resolveTurn,
  SHOP_ITEMS,
  SHORE_LEVEL,
  simulateRoll,
  simulateWeaponShot3D,
  startingInventory,
  startRound3D,
  TANK_MAX_LIFE,
  TANK_MIN_SEPARATION_3D,
  tanks3DAt,
  terrainHeightAt,
  validateMove,
  WATER_LEVEL,
  WEAPONS,
  type MatchState3D,
  type Player,
  type Terrain,
  type WeaponId,
} from "../src";

const GROUND = 10;
const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });
const withItems = (id: string, items: Player["inventory"]): Player => ({ ...fresh(id), inventory: { ...startingInventory(), ...items } });
const tankOf = (s: MatchState3D, id: string) => s.tanks.find((t) => t.id === id)!;
const invOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.inventory;

/** Piso plano a `ground` con un lago redondo (altura 0) de radio `r` centrado en (cx, cz). */
function withLake(ground: number, cx: number, cz: number, r: number, inner = 0): Terrain {
  const t = createFlatTerrain(257, 257, ground);
  for (let z = 0; z < t.depth; z++) {
    for (let x = 0; x < t.width; x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d <= r && d >= inner) t.heights[x + z * t.width] = 0;
    }
  }
  return t;
}

/** A en (128, 128) y B en (128, 221), los dos apoyados en el piso que haya ahí. */
function match(terrain: Terrain, a: Player = fresh("A"), b: Player = fresh("B")): MatchState3D {
  return {
    terrain,
    wind: { x: 0, z: 0 },
    tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 128, z: 128 }, { x: 128, z: 221 }], TANK_MAX_LIFE),
    players: [a, b],
  };
}

/** Potencia con la que A, tirando con yaw y pitch 45, termina en `outcome`. */
function powerFor(state: MatchState3D, yaw: number, outcome: string, weaponId: WeaponId = "babyMissile"): number {
  const a = tankOf(state, "A");
  for (let power = 200; power <= 1000; power += 5) {
    const r = simulateWeaponShot3D(
      state.terrain,
      WEAPONS[weaponId],
      { originX: a.x, originY: a.y, originZ: a.z, yaw, pitch: 45, power, wind: state.wind, shooterId: "A" },
      state.tanks,
    );
    if (r.outcome === outcome) return power;
  }
  throw new Error(`ningún tiro termina en ${outcome}`);
}

describe("agua: nadie nace en el lago", () => {
  it("en los mapas del juego, todos nacen en piso firme y separados", () => {
    for (let seed = 1; seed <= 150; seed++) {
      for (const n of [2, 3, 4]) {
        const players = Array.from({ length: n }, (_, i) => fresh(`P${i}`));
        const { terrain, tanks } = startRound3D(seed * 31 + n, players);
        for (const t of tanks) {
          expect(terrainHeightAt(terrain, t.x, t.z)).toBeGreaterThan(WATER_LEVEL);
          expect(t.y).toBeGreaterThan(WATER_LEVEL);
        }
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            expect(Math.hypot(tanks[i]!.x - tanks[j]!.x, tanks[i]!.z - tanks[j]!.z)).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
          }
        }
      }
    }
  }, 20_000); // 450 mapas: en una máquina cargada pasa los 5 s por defecto

  it("si todo el anillo del sorteo es lago, cada tanque se corre a la orilla más cercana y siguen separados", () => {
    // El sorteo cae entre 78 y 102 celdas del centro: un lago en corona de 70 a 115 lo tapa entero.
    const t = withLake(GROUND, 128, 128, 115, 70);
    for (let seed = 1; seed <= 40; seed++) {
      for (const n of [2, 3, 4]) {
        const spots = placeTanks3D(t, n, createRng(seed * 7 + n));
        for (const s of spots) {
          expect(terrainHeightAt(t, s.x, s.z)).toBe(GROUND);
          // La orilla de adentro o la de afuera, la que quede a mano: no cruza el mapa.
          const d = Math.hypot(s.x - 128, s.z - 128);
          expect(d < 70 || d > 115).toBe(true);
          expect(d).toBeGreaterThan(60);
          expect(d).toBeLessThan(125);
        }
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z)).toBeGreaterThanOrEqual(TANK_MIN_SEPARATION_3D);
          }
        }
      }
    }
  });
});

describe("agua: el tanque que queda en el agua muere", () => {
  it("un tanque que queda sobre altura 0 al resolverse el turno muere, con paracaídas y escudo puestos", () => {
    // B está parado en el lago. A tira para el otro lado: el tiro ni se le acerca.
    const lake = withLake(GROUND, 128, 221, 20);
    const s0 = match(lake, fresh("A"), withItems("B", { parachute: 1, shield: 1 }));
    expect(tankOf(s0, "B").y).toBe(0);
    const { state, damage, blocked, falls } = resolveTurn(s0, { playerId: "A", yaw: 270, pitch: 45, power: 400 });

    expect(tankOf(state, "B").life).toBe(0);
    expect(tankOf(state, "A").life).toBe(TANK_MAX_LIFE);
    expect(damage).toEqual([
      { targetId: "B", cause: "water", damage: TANK_MAX_LIFE, killed: true, money: expect.any(Number) },
    ]);
    // El escudo no lo salvó y tampoco se gastó: no hubo tiro que absorber.
    expect(blocked).toEqual([]);
    expect(falls).toEqual([]);
    expect(invOf(state, "B").shield).toBe(1);
    // Lo cobra el que tiró, como un kill.
    expect(state.players[0]!.money).toBe(MONEY_START + damage[0]!.money);
    expect(damage[0]!.money).toBeGreaterThan(0);
  });

  it("caer al agua mata: el cráter baja el piso hasta el lago y ni el escudo ni el paracaídas salvan", () => {
    // Playa a 2.5: el cráter de la Chispa (4 de hondo) la deja en 0.
    const beach = createFlatTerrain(257, 257, 2.5);
    const s0 = match(beach, fresh("A"), withItems("B", { parachute: 1, shield: 1 }));
    const power = powerFor(s0, 90, "tank");
    const { state, shot, damage, blocked, falls } = resolveTurn(s0, { playerId: "A", yaw: 90, pitch: 45, power });

    expect(shot.outcome).toBe("tank");
    // El escudo se comió la explosión y el paracaídas la caída...
    expect(blocked).toEqual(["B"]);
    expect(invOf(state, "B").shield).toBe(0);
    expect(falls).toMatchObject([{ tankId: "B", parachute: true, shielded: true }]);
    // ...pero quedó en el agua.
    expect(terrainHeightAt(state.terrain, 128, 221)).toBeLessThanOrEqual(WATER_LEVEL);
    expect(damage.map((d) => d.cause)).toEqual(["water"]);
    expect(tankOf(state, "B").life).toBe(0);
    expect(tankOf(state, "A").life).toBe(TANK_MAX_LIFE);
  });

  it("el mismo tiro en piso alto no ahoga a nadie", () => {
    const s0 = match(createFlatTerrain(257, 257, GROUND), fresh("A"), withItems("B", { parachute: 1, shield: 1 }));
    const power = powerFor(s0, 90, "tank");
    const { state, damage } = resolveTurn(s0, { playerId: "A", yaw: 90, pitch: 45, power });
    expect(damage).toEqual([]);
    expect(tankOf(state, "B").life).toBe(TANK_MAX_LIFE);
  });
});

describe("agua: el tiro que cae al lago se hunde", () => {
  // Lago adelante de A (hacia +X), lejos de los dos tanques.
  const lake = withLake(GROUND, 200, 128, 25);

  it("no abre cráter ni hace daño, y el resultado dice \"water\"", () => {
    const s0 = match(lake);
    const power = powerFor(s0, 0, "water");
    const { state, shot, damage, falls } = resolveTurn(s0, { playerId: "A", yaw: 0, pitch: 45, power });
    expect(shot.outcome).toBe("water");
    expect(Math.hypot(shot.x - 200, shot.z - 128)).toBeLessThan(25);
    expect(state.terrain).toBe(s0.terrain); // el mismo heightmap: no se tocó
    expect(damage).toEqual([]);
    expect(falls).toEqual([]);

    // Con la misma puntería, sin lago, sí queda el hoyo.
    const dry = resolveTurn(match(createFlatTerrain(257, 257, GROUND)), { playerId: "A", yaw: 0, pitch: 45, power });
    expect(dry.shot.outcome).toBe("ground");
    expect(terrainHeightAt(dry.state.terrain, Math.trunc(dry.shot.x), Math.trunc(dry.shot.z))).toBeLessThan(GROUND);
  });

  it("con cualquier arma que termine ahí (también el Rebote después de picar): ni hoyo, ni fuego, ni loma", () => {
    for (const weaponId of ["missile", "napalm", "nuke", "dirt", "leapfrog", "roller"] as const) {
      const s0 = match(lake, withItems("A", { [weaponId]: 1 }));
      const power = powerFor(s0, 0, "water", weaponId);
      const { state, shot, damage, fire } = resolveTurn(s0, { playerId: "A", yaw: 0, pitch: 45, power, weaponId });
      expect(shot.outcome).toBe("water");
      expect(state.terrain).toBe(s0.terrain);
      expect(state.fires).toBeUndefined();
      expect(fire).toBeNull();
      expect(damage).toEqual([]);
      expect(invOf(state, "A")[weaponId]).toBe(0); // la munición se gasta igual
    }
  });

  it("el Rodillo que baja rodando hasta el lago se hunde ahí", () => {
    // Ladera pareja que baja hacia +X hasta el agua.
    const t = createFlatTerrain(257, 257, 0);
    for (let z = 0; z < t.depth; z++) for (let x = 0; x < 150; x++) t.heights[x + z * t.width] = (150 - x) * 0.4;
    const r = simulateRoll(t, { x: 120, z: 128 }, WEAPONS.roller.roll!.maxCells);
    expect(r.outcome).toBe("water");
    expect(r.y).toBeLessThanOrEqual(WATER_LEVEL);
  });
});

describe("agua: con nafta no se entra", () => {
  it("un destino en el lago se rechaza; uno en la orilla, no", () => {
    const lake = withLake(GROUND, 128 + FUEL_MOVE_RANGE, 128, 6);
    const s0 = match(lake, withItems("A", { fuel: 1 }));
    expect(validateMove(s0, "A", { x: 128 + FUEL_MOVE_RANGE, z: 128 })).toEqual({ ok: false, reason: "ahí hay agua" });
    expect(validateMove(s0, "A", { x: 128, z: 128 + FUEL_MOVE_RANGE }).ok).toBe(true);
  });
});

describe("agua: el aviso de orilla", () => {
  it("la carta del Paracaídas no promete salvar del agua, y el Bombazo se sigue llamando Bombazo", () => {
    const card = SHOP_ITEMS.parachute.description;
    // Lo que tapa es la caída al cráter, y dice que el agua sí mata.
    expect(PARACHUTE_LINE).toMatch(/cráter no duele/);
    expect(PARACHUTE_LINE).toMatch(/el agua sí/);
    expect(PARACHUTE_LINE.split(String.fromCodePoint(10))).toHaveLength(1);
    expect(card.startsWith(PARACHUTE_LINE)).toBe(true);
    // La promesa vieja, sin condiciones, no está más.
    expect(card).not.toMatch(/caer no te hace daño/i);
    expect(SHOP_ITEMS.nuke.name).toBe("Bombazo");
  });

  it("un tanque a altura de orilla tiene la marca y uno en el pico no", () => {
    const low = match(createFlatTerrain(257, 257, SHORE_LEVEL));
    const peak = match(createFlatTerrain(257, 257, 45));
    for (const t of low.tanks) expect(onShore(low.terrain, t.x, t.z)).toBe(true);
    for (const t of peak.tanks) expect(onShore(peak.terrain, t.x, t.z)).toBe(false);
    // Apenas arriba de la orilla ya no, y el agua misma tampoco es orilla.
    expect(onShore(createFlatTerrain(257, 257, SHORE_LEVEL + 1), 128, 221)).toBe(false);
    expect(onShore(createFlatTerrain(257, 257, WATER_LEVEL), 128, 221)).toBe(false);
  });

  it("la marca dice la verdad: un Misil al pie ahoga al marcado, con escudo y paracaídas, y al de arriba no", () => {
    const drowned = (ground: number): boolean => {
      const s0 = match(createFlatTerrain(257, 257, ground), withItems("A", { missile: 1 }), withItems("B", { parachute: 1, shield: 1 }));
      for (let power = 200; power <= 1000; power += 2) {
        const { damage } = resolveTurn(s0, { playerId: "A", yaw: 90, pitch: 75, power, weaponId: "missile" });
        if (damage.some((d) => d.targetId === "B" && d.cause === "water")) return true;
      }
      return false;
    };
    expect(onShore(createFlatTerrain(257, 257, 7), 128, 221)).toBe(true);
    expect(drowned(7)).toBe(true);
    expect(onShore(createFlatTerrain(257, 257, 10), 128, 221)).toBe(false);
    expect(drowned(10)).toBe(false);
  });

  it("es un aviso: estar en la orilla no cambia el daño de un tiro", () => {
    // El mismo tiro, lejos del tanque, en piso de orilla y en piso alto: nadie pierde vida.
    for (const ground of [SHORE_LEVEL, 45]) {
      const s0 = match(createFlatTerrain(257, 257, ground));
      const { state, damage } = resolveTurn(s0, { playerId: "A", yaw: 270, pitch: 45, power: 400 });
      expect(damage).toEqual([]);
      expect(tankOf(state, "B").life).toBe(TANK_MAX_LIFE);
    }
  });
});
