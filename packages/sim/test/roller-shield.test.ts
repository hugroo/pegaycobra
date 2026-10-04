import { describe, expect, it } from "vitest";
import {
  buyItem,
  cannotBuy,
  createFlatTerrain,
  endRoundPayouts,
  MONEY_START,
  resolveTurn,
  ROLL_STEP,
  ROLLER_RADIUS,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  startingInventory,
  TANK_MAX_LIFE,
  TANK_RADIUS,
  tanks3DAt,
  terrainHeightAt,
  WEAPONS,
  type MatchState3D,
  type Player,
  type Terrain,
} from "../src";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });
const withItems = (id: string, items: Player["inventory"]): Player => ({ ...fresh(id), inventory: { ...startingInventory(), ...items } });
const lifeOf = (s: MatchState3D, id: string) => s.tanks.find((t) => t.id === id)!.life;
const invOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.inventory;

const SLOPE_TOP = 100;
const MAX_CELLS = WEAPONS.roller.roll!.maxCells;

/** Meseta a 60 hasta x = 100 y de ahí una ladera pareja que baja 0.4 por celda hacia +X, igual en todo Z. */
function hillside(): Terrain {
  const t = createFlatTerrain(257, 257, 0);
  for (let z = 0; z < 257; z++) for (let x = 0; x < 257; x++) t.heights[x + z * 257] = Math.max(5, 60 - 0.4 * Math.max(0, x - SLOPE_TOP));
  return t;
}

/** A en la meseta, B donde diga el test (por defecto lejos, fuera del camino). */
function onHill(b = { x: 30, z: 30 }, players: Player[] = [withItems("A", { roller: 2 }), fresh("B")]): MatchState3D {
  const terrain = hillside();
  return { terrain, wind: { x: 0, z: 0 }, tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 90, z: 128 }, b], TANK_MAX_LIFE), players };
}

const ROLL = { playerId: "A", yaw: 0, pitch: 45, power: 300, weaponId: "roller" } as const;

describe("Roller", () => {
  it("en una ladera no explota donde pega: rueda y termina más abajo", () => {
    const m = onHill();
    const { shot, state } = resolveTurn(m, ROLL, { recordPath: true });
    expect(shot.outcome).toBe("ground");
    const landed = shot.landed!;
    expect(landed.x).toBeGreaterThan(SLOPE_TOP); // pegó en la ladera
    expect(shot.y).toBeLessThan(landed.y - 10);
    expect(shot.x).toBeGreaterThan(landed.x + 10);
    expect(shot.z).toBeCloseTo(128, 6); // la ladera baja derecho en X
    // El cráter (chico) queda donde terminó, no donde tocó el piso.
    expect(terrainHeightAt(state.terrain, Math.trunc(shot.x), 128)).toBeLessThan(terrainHeightAt(m.terrain, Math.trunc(shot.x), 128));
    expect(terrainHeightAt(state.terrain, Math.trunc(landed.x), 128)).toBe(terrainHeightAt(m.terrain, Math.trunc(landed.x), 128));
    expect(state.players[0]!.inventory.roller).toBe(1);
  });

  it("rueda como mucho N celdas, y el camino que devuelve baja en cada paso", () => {
    const shot = resolveTurn(onHill(), ROLL, { recordPath: true }).shot;
    const rolled = Math.hypot(shot.x - shot.landed!.x, shot.z - shot.landed!.z);
    expect(rolled).toBeLessThanOrEqual(MAX_CELLS + 1e-6);
    expect(rolled).toBeGreaterThan(MAX_CELLS - ROLL_STEP); // la ladera es más larga que N: corta por N
    const path = shot.path!;
    const steps = Math.round(rolled / ROLL_STEP);
    const rollPart = path.slice(path.length - (steps + 1) * 3);
    expect(rollPart[0]).toBeCloseTo(shot.landed!.x, 6);
    for (let i = 1; i <= steps; i++) {
      expect(rollPart[i * 3 + 1]!).toBeLessThan(rollPart[(i - 1) * 3 + 1]!);
      // La bola va apoyada en el piso, no en el aire.
      expect(rollPart[i * 3 + 1]!).toBeCloseTo(terrainHeightAt(hillside(), rollPart[i * 3]!, rollPart[i * 3 + 2]!) + ROLLER_RADIUS, 6);
    }
    expect(shot.ticks).toBe(path.length / 3 - 1);
  });

  it("no atraviesa un tanque: se frena contra él, del lado de arriba, y le pega", () => {
    const free = resolveTurn(onHill(), ROLL).shot;
    const bx = free.landed!.x + 20; // en el camino, a mitad de la rodada
    expect(free.x).toBeGreaterThan(bx + 10); // sin tanque, la bola sigue de largo
    const { shot, state, damage } = resolveTurn(onHill({ x: bx, z: 128 }), ROLL);
    expect(shot.outcome).toBe("tank");
    expect(shot.tankId).toBe("B");
    expect(shot.x).toBeLessThan(bx);
    expect(bx - shot.x).toBeLessThanOrEqual(TANK_RADIUS + ROLLER_RADIUS);
    expect(shot.landed!.x).toBeCloseTo(free.landed!.x, 6);
    expect(lifeOf(state, "B")).toBe(0);
    expect(damage.find((d) => d.targetId === "B")!.cause).toBe("explosion");
  });

  it("sale con la potencia que dice WEAPONS.roller, y en lo llano no rueda", () => {
    const flat = createFlatTerrain(257, 257, 10);
    const aim = { originX: 60, originY: 10, originZ: 128, yaw: 0, pitch: 45, power: 600, wind: { x: 0, z: 0 } };
    const baby = simulateWeaponShot3D(flat, WEAPONS.babyMissile, { ...aim, power: aim.power * WEAPONS.roller.roll!.powerFactor });
    const roller = simulateWeaponShot3D(flat, WEAPONS.roller, aim);
    expect(roller.outcome).toBe("ground");
    expect(roller.x).toBeCloseTo(baby.x, 6);
    expect(roller.x).toBe(roller.landed!.x);
    expect(baby.landed).toBeUndefined();
  });

  describe("a distancia de spawn, cerro de por medio", () => {
    // placeTanks3D deja a los tanques a 130–185 celdas. Acá: A y B a 160, los dos a altura 10, y en
    // el medio un cerro de 45 que cruza todo el mapa en Z. La cima queda a 100 de A; B, 60 más allá,
    // al pie de la bajada.
    const A = { x: 48, z: 128 };
    const B = { x: A.x + 160, z: 128 };
    const CREST = A.x + 100;
    function ridge(): MatchState3D {
      const t = createFlatTerrain(257, 257, 10);
      for (let z = 0; z < 257; z++)
        for (let x = 0; x < 257; x++) {
          const up = (x - (CREST - 70)) / 70; // sube de 78 a 148
          const down = (B.x + 5 - x) / (B.x + 5 - CREST); // baja de 148 a 213
          t.heights[x + z * 257] = 10 + 45 * Math.max(0, Math.min(up, down));
        }
      return { terrain: t, wind: { x: 0, z: 0 }, tanks: tanks3DAt(t, ["A", "B"], [A, B], TANK_MAX_LIFE), players: [withItems("A", { roller: 2 }), fresh("B")] };
    }
    /** La cuenta de la fantasma del cliente (computeGhost): simulateWeaponShot3D con el arma, el tanque propio y los vivos. */
    const ghost = (m: MatchState3D, weapon: typeof WEAPONS.roller, pitch: number, power: number) =>
      simulateWeaponShot3D(
        m.terrain,
        weapon,
        { originX: m.tanks[0]!.x, originY: m.tanks[0]!.y, originZ: m.tanks[0]!.z, yaw: 0, pitch, power, wind: m.wind, shooterId: "A" },
        m.tanks,
      );
    /** Primera puntería (yaw 0) que cae pasando la cima, rueda y termina contra B. */
    function findAim(m: MatchState3D, weapon: typeof WEAPONS.roller): { pitch: number; power: number } | null {
      for (let pitch = 40; pitch <= 75; pitch += 5)
        for (let power = 300; power <= 1000; power += 10) {
          const r = ghost(m, weapon, pitch, power);
          if (r.outcome === "tank" && r.tankId === "B" && r.landed && r.landed.x > CREST && r.x - r.landed.x > 10) return { pitch, power };
        }
      return null;
    }

    it("hay una puntería de Roller que pasa la cima, baja rodando y le pega al otro", () => {
      const m = ridge();
      const aim = findAim(m, WEAPONS.roller);
      expect(aim).not.toBeNull();
      // El server resuelve ese tiro con la misma cuenta: mismo final, mismo punto de caída.
      const seen = ghost(m, WEAPONS.roller, aim!.pitch, aim!.power);
      const { shot, state } = resolveTurn(m, { playerId: "A", yaw: 0, pitch: aim!.pitch, power: aim!.power, weaponId: "roller" });
      expect(shot).toEqual(seen);
      expect(shot.landed!.x).toBeGreaterThan(CREST);
      expect(lifeOf(state, "B")).toBeLessThan(TANK_MAX_LIFE);
      expect(lifeOf(state, "A")).toBe(TANK_MAX_LIFE);
    });

    it("con la potencia al 60% de antes no había ninguna", () => {
      const weak = { ...WEAPONS.roller, roll: { ...WEAPONS.roller.roll!, powerFactor: 0.6 } };
      expect(findAim(ridge(), weak)).toBeNull();
    });
  });

  it("si vuelve rodando hasta el que tiró, le pega a él", () => {
    const terrain = hillside();
    const m: MatchState3D = {
      terrain,
      wind: { x: 0, z: 0 },
      tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 150, z: 128 }, { x: 30, z: 30 }], TANK_MAX_LIFE),
      players: [withItems("A", { roller: 2 }), fresh("B")],
    };
    const { shot, state } = resolveTurn(m, { playerId: "A", yaw: 180, pitch: 45, power: 210, weaponId: "roller" });
    expect(shot.landed!.x).toBeLessThan(150 - TANK_RADIUS - ROLLER_RADIUS); // cayó cuesta arriba, sin tocarlo
    expect(shot.outcome).toBe("tank");
    expect(shot.tankId).toBe("A");
    expect(lifeOf(state, "A")).toBe(0);
  });

  it("sin Rollers no se puede tirar, y el cráter es más chico que el de la Baby", () => {
    expect(() => resolveTurn(onHill({ x: 30, z: 30 }, [fresh("A"), fresh("B")]), ROLL)).toThrow();
    expect(WEAPONS.roller.craterRadius).toBeLessThan(WEAPONS.babyMissile.craterRadius);
  });
});

describe("Escudo", () => {
  /** Terreno plano a 10, A en el centro y B donde cae yaw 90 / pitch 45 / power 600. */
  function duel(b: Player, a: Player = withItems("A", { missile: 3 })): MatchState3D {
    const terrain = createFlatTerrain(257, 257, 10);
    return {
      terrain,
      wind: { x: 0, z: 0 },
      tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 128, z: 128 }, { x: 128, z: 128 + 93 }], TANK_MAX_LIFE),
      players: [a, b],
    };
  }
  const MISSILE = { playerId: "A", yaw: 90, pitch: 45, power: 600, weaponId: "missile" } as const;

  it("con escudo, el Missile no baja la vida y el segundo Missile sí", () => {
    const bare = resolveTurn(duel(fresh("B")), MISSILE);
    expect(bare.shot.outcome).toBe("tank");
    expect(lifeOf(bare.state, "B")).toBe(0); // sin escudo, ese tiro lo mata

    const first = resolveTurn(duel(buyItem(fresh("B"), "shield")), MISSILE);
    expect(first.shot.outcome).toBe("tank");
    expect(first.blocked).toEqual(["B"]);
    expect(first.damage).toEqual([]);
    expect(lifeOf(first.state, "B")).toBe(TANK_MAX_LIFE);
    expect(invOf(first.state, "B").shield).toBe(0); // se gastó
    expect(invOf(first.state, "A").missile).toBe(2);
    expect(first.state.players[0]!.money).toBe(MONEY_START); // un tiro bloqueado no paga
    // El cráter se abre igual y el tanque cae a él; esa caída no le saca vida.
    expect(first.falls).toHaveLength(1);
    expect(first.falls[0]).toMatchObject({ tankId: "B", shielded: true });
    expect(first.state.tanks[1]!.y).toBeLessThan(10);

    const second = resolveTurn(first.state, MISSILE);
    expect(second.blocked).toEqual([]);
    expect(lifeOf(second.state, "B")).toBeLessThan(TANK_MAX_LIFE);
    expect(second.damage.some((d) => d.targetId === "B" && d.cause === "explosion")).toBe(true);
  });

  it("también absorbe un Roller, una sola vez", () => {
    const bx = resolveTurn(onHill(), ROLL).shot.landed!.x + 20;
    const m = onHill({ x: bx, z: 128 }, [withItems("A", { roller: 2 }), buyItem(fresh("B"), "shield")]);
    const first = resolveTurn(m, ROLL);
    expect(first.shot.tankId).toBe("B");
    expect(first.blocked).toEqual(["B"]);
    expect(lifeOf(first.state, "B")).toBe(TANK_MAX_LIFE);
    const second = resolveTurn(first.state, ROLL);
    expect(second.blocked).toEqual([]);
    expect(lifeOf(second.state, "B")).toBeLessThan(TANK_MAX_LIFE);
  });

  it("no frena la caída: si le sacan el piso sin que la explosión lo alcance, cae, duele y el escudo sigue", () => {
    // B al borde de una meseta a 30; el Missile pega abajo, al pie del barranco, y se lleva el borde.
    const terrain = createFlatTerrain(257, 257, 10);
    for (let z = 0; z < 257; z++) for (let x = 140; x < 257; x++) terrain.heights[x + z * 257] = 30;
    const m: MatchState3D = {
      terrain,
      wind: { x: 0, z: 0 },
      tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 136 - 93.27, z: 128 }, { x: 141, z: 128 }], TANK_MAX_LIFE),
      players: [withItems("A", { missile: 3 }), buyItem(fresh("B"), "shield")],
    };
    const { shot, state, blocked, damage, falls } = resolveTurn(m, { ...MISSILE, yaw: 0 });
    expect(shot.outcome).toBe("ground");
    expect(shot.y).toBeLessThan(11); // explotó abajo, lejos de B (que está a 30)
    expect(blocked).toEqual([]);
    expect(invOf(state, "B").shield).toBe(1);
    expect(falls[0]).toMatchObject({ tankId: "B", shielded: false });
    expect(damage.map((d) => [d.targetId, d.cause])).toEqual([["B", "fall"]]);
    expect(lifeOf(state, "B")).toBeLessThan(TANK_MAX_LIFE);
  });

  it("un tiro que se fue del mapa no lo gasta", () => {
    const { shot, state, blocked } = resolveTurn(duel(buyItem(fresh("B"), "shield")), { ...MISSILE, power: 1000 });
    expect(shot.outcome).toBe("offmap");
    expect(blocked).toEqual([]);
    expect(invOf(state, "B").shield).toBe(1);
    expect(lifeOf(state, "B")).toBe(TANK_MAX_LIFE);
  });

  it("tapa también la explosión propia", () => {
    // A tira casi vertical y sin potencia: le cae encima.
    const a = buyItem(withItems("A", { missile: 3 }), "shield");
    const { state, blocked } = resolveTurn(duel(fresh("B"), a), { ...MISSILE, pitch: 90, power: 50 });
    expect(blocked).toEqual(["A"]);
    expect(lifeOf(state, "A")).toBe(TANK_MAX_LIFE);
    expect(invOf(state, "A")).toMatchObject({ shield: 0, missile: 2 });
  });
});

describe("tienda con Roller y Escudo", () => {
  it("ofrece Missile, Roller, Napalm, Nuke, Tierra, Escudo, Paracaídas y Nafta, en ese orden", () => {
    expect(Object.keys(SHOP_ITEMS)).toEqual(["missile", "roller", "napalm", "nuke", "dirt", "shield", "parachute", "fuel"]);
  });

  it("el Roller viene de a 2", () => {
    const a = buyItem(fresh("A"), "roller");
    expect(a.inventory.roller).toBe(2);
    expect(a.money).toBe(MONEY_START - SHOP_ITEMS.roller.price);
    expect(buyItem(a, "roller").inventory.roller).toBe(4);
  });

  it("escudo: uno por vez; no vence con la ronda y se puede volver a comprar cuando se gastó", () => {
    const a = buyItem(fresh("A"), "shield");
    expect(a.inventory.shield).toBe(1);
    expect(cannotBuy(a, "shield")).not.toBeNull();
    expect(() => buyItem(a, "shield")).toThrow();
    const next = endRoundPayouts([a], new Set()).players[0]!;
    expect(next.inventory.shield).toBe(1);
    expect(cannotBuy({ ...next, inventory: { ...next.inventory, shield: 0 } }, "shield")).toBeNull();
  });
});
