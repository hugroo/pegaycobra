import { describe, expect, it } from "vitest";
import {
  buyItem,
  createFlatTerrain,
  isPlayable,
  MONEY_START,
  resolveTurn,
  shotImpacts,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  SPLIT_MAX_KICK,
  splitDirection,
  startingInventory,
  TANK_MAX_LIFE,
  tanks3DAt,
  terrainHeightAt,
  VELOCITY_TO_POSITION,
  WEAPONS,
  type DamageEvent,
  type MatchState3D,
  type Player,
  type ShotHead,
  type Terrain,
} from "../src";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });
const withItems = (id: string, items: Player["inventory"]): Player => ({ ...fresh(id), inventory: { ...startingInventory(), ...items } });
const lifeOf = (s: MatchState3D, id: string) => s.tanks.find((t) => t.id === id)!.life;
const invOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.inventory;

const GROUND = 10;
const HEADS = WEAPONS.mirv.split!.heads;
/** A qué distancia de la del medio caen las otras. */
const RADIUS = WEAPONS.mirv.split!.radius;
const FAR = { x: 30, z: 30 };

/** Terreno plano a 10, A en el centro y B donde diga el test (por defecto lejos, fuera del tiro). */
function duel(b: { x: number; z: number } = FAR, players: Player[] = [withItems("A", { mirv: 1, missile: 3, nuke: 1 }), fresh("B")]): MatchState3D {
  const terrain = createFlatTerrain(257, 257, GROUND);
  return { terrain, wind: { x: 0, z: 0 }, tanks: tanks3DAt(terrain, ["A", "B"], [{ x: 128, z: 128 }, b], TANK_MAX_LIFE), players };
}
/** El duelo de roller-shield.test.ts: desde el centro cae a 93 celdas, en z = 221. */
const AIM = { playerId: "A", yaw: 90, pitch: 45, power: 600 } as const;
const MIRV = { ...AIM, weaponId: "mirv" } as const;
const MISSILE = { ...AIM, weaponId: "missile" } as const;

/** Celdas que el tiro bajó. */
function lowered(before: Terrain, after: Terrain): number {
  let n = 0;
  for (let i = 0; i < before.heights.length; i++) if (after.heights[i]! < before.heights[i]!) n++;
  return n;
}
/** Dónde cae cada cabeza con nadie en el camino. */
const landings = () => resolveTurn(duel(), MIRV).shot.split!.heads;
const explosionsOn = (damage: DamageEvent[], id: string) => damage.filter((d) => d.targetId === id && d.cause === "explosion");

describe("Racimo", () => {
  it("sale como un Misil y se abre en el aire, en la cima de la parábola, en 5", () => {
    const m = duel();
    const { shot } = resolveTurn(m, MIRV, { recordPath: true });
    const missile = resolveTurn(m, MISSILE, { recordPath: true }).shot;
    const split = shot.split!;
    expect(split).toBeDefined();
    expect(split.heads).toHaveLength(HEADS);
    expect(HEADS).toBe(5);

    // Hasta que se abre, es el recorrido del Misil punto por punto.
    const path = shot.path!;
    expect(path).toEqual(missile.path!.slice(0, (split.tick + 1) * 3));
    expect([split.x, split.y, split.z]).toEqual(path.slice(-3));

    // Se abre arriba, no en el piso: en el punto más alto del recorrido (un paso después, cuando ya no sube).
    const ys = missile.path!.filter((_, i) => i % 3 === 1);
    const top = ys.indexOf(Math.max(...ys));
    expect(split.tick).toBe(top + 1);
    expect(split.y).toBeGreaterThan(GROUND + 20);
    expect(split.tick).toBeGreaterThan(100);
    expect(split.tick).toBeLessThan(missile.ticks - 100);

    // Cada cabeza sale de ese punto y sigue cayendo por su lado.
    for (const h of split.heads) {
      expect(h.path!.slice(0, 3)).toEqual([split.x, split.y, split.z]);
      expect(h.ticks).toBeGreaterThan(split.tick);
      expect(h.path!.length / 3 - 1).toBe(h.ticks - split.tick);
      expect([h.x, h.y, h.z]).toEqual(h.path!.slice(-3));
    }
    // La del medio sigue el tiro como venía: cae donde cae el Misil, en el mismo tick.
    const aimed = split.heads[0]!;
    expect([aimed.outcome, aimed.x, aimed.y, aimed.z, aimed.ticks]).toEqual([missile.outcome, missile.x, missile.y, missile.z, missile.ticks]);
    expect([shot.outcome, shot.x, shot.y, shot.z]).toEqual([missile.outcome, missile.x, missile.y, missile.z]);
    expect(shot.ticks).toBe(Math.max(...split.heads.map((h) => h.ticks)));
  });

  it("los impactos no son el mismo punto: las otras cuatro caen cerca, en X alrededor de la del medio", () => {
    const heads = landings();
    expect(heads.every((h) => h.outcome === "ground")).toBe(true);
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        expect(Math.hypot(heads[i]!.x - heads[j]!.x, heads[i]!.z - heads[j]!.z)).toBeGreaterThan(6);
      }
    }
    const [mid, ...rest] = heads;
    const offsets = rest.map((h) => [h.x - mid!.x, h.z - mid!.z]);
    // Cerca: cada una a `radius` de la del medio, todas adentro de lo que tapa un solo Bombazo.
    expect(RADIUS).toBeLessThan(WEAPONS.nuke.explosionRadius / 2);
    for (const [dx, dz] of offsets) {
      expect(Math.hypot(dx!, dz!)).toBeCloseTo(RADIUS, 6);
      expect(Math.abs(dx!)).toBeCloseTo(RADIUS / Math.SQRT2, 6);
    }
    expect(offsets.map(([dx, dz]) => `${Math.sign(dx!)},${Math.sign(dz!)}`).sort()).toEqual(["-1,-1", "-1,1", "1,-1", "1,1"]);
  });

  it("quedan cinco hoyos chicos, no uno grande", () => {
    const m = duel();
    const { state, shot } = resolveTurn(m, MIRV);
    // Lo que abre una cabeza sola: un Racimo rasante, que no tiene cima y no se abre.
    const one = lowered(m.terrain, resolveTurn(m, { ...MIRV, pitch: 0, power: 300 }).state.terrain);
    expect(one).toBeGreaterThan(0);

    // Bajó el piso donde cayó cada una...
    for (const h of shot.split!.heads) {
      expect(terrainHeightAt(state.terrain, Math.trunc(h.x), Math.trunc(h.z))).toBeLessThan(GROUND - 2);
    }
    // ...y entre dos puntas vecinas de la X el piso sigue intacto: son hoyos separados.
    const [, a, b, c, d] = shot.split!.heads as [ShotHead, ShotHead, ShotHead, ShotHead, ShotHead];
    for (const [p, q] of [[a, b], [b, c], [c, d], [d, a]] as const) {
      expect(terrainHeightAt(state.terrain, (Math.trunc(p.x) + Math.trunc(q.x)) / 2, (Math.trunc(p.z) + Math.trunc(q.z)) / 2)).toBe(GROUND);
    }
    const holes = lowered(m.terrain, state.terrain);
    expect(holes).toBeGreaterThan(4 * one);
    expect(holes).toBeLessThanOrEqual(HEADS * one);

    // Ninguno es más hondo que el de una cabeza sola, y todo junto no llega a un hoyo de Misil ni de lejos a uno de Bombazo.
    const deepest = Math.min(...state.terrain.heights);
    expect(deepest).toBeGreaterThan(GROUND - 4);
    expect(Math.min(...resolveTurn(m, MISSILE).state.terrain.heights)).toBeLessThan(deepest - 2);
    expect(holes).toBeLessThan(lowered(m.terrain, resolveTurn(m, { ...AIM, weaponId: "nuke" }).state.terrain) / 5);
    expect(WEAPONS.mirv.craterRadius).toBeLessThan(WEAPONS.babyMissile.craterRadius);
    expect(invOf(state, "A").mirv).toBe(0);
  });

  it("la fantasma del cliente hace la misma cuenta que el server", () => {
    const m = duel();
    const a = m.tanks[0]!;
    const ghost = simulateWeaponShot3D(
      m.terrain,
      WEAPONS.mirv,
      { originX: a.x, originY: a.y, originZ: a.z, yaw: AIM.yaw, pitch: AIM.pitch, power: AIM.power, wind: m.wind, shooterId: "A" },
      m.tanks,
      { recordPath: true },
    );
    expect(resolveTurn(m, MIRV, { recordPath: true }).shot).toEqual(ghost);
    // Los golpes salen en el orden en que caen; en lo llano caen juntas y queda el orden en que salieron.
    expect(shotImpacts(ghost)).toEqual(ghost.split!.heads);
  });

  it("cada cabeza es un golpe aparte y el daño se suma: dos le pegan al mismo tanque", () => {
    // B justo entre donde cae la del medio y una de las puntas: lo alcanzan las dos, y ninguna otra.
    const [mid, tip] = landings();
    const m = duel({ x: (mid!.x + tip!.x) / 2, z: (mid!.z + tip!.z) / 2 });
    const { shot, state, damage, blocked } = resolveTurn(m, MIRV);
    expect(shot.split!.heads.map((h) => h.outcome)).toEqual(Array(HEADS).fill("ground")); // no le pegó de lleno ninguna
    const hits = explosionsOn(damage, "B");
    expect(hits).toHaveLength(2);
    expect(hits[0]!.damage).toBeGreaterThan(20);
    expect(blocked).toEqual([]);
    const total = damage.filter((d) => d.targetId === "B").reduce((sum, d) => sum + d.damage, 0);
    expect(total).toBeCloseTo(TANK_MAX_LIFE - lifeOf(state, "B"), 6);
    expect(total).toBeGreaterThan(hits[0]!.damage);
    expect(state.players[0]!.money).toBe(MONEY_START + damage.reduce((sum, d) => sum + d.money, 0));
    expect(lifeOf(state, "A")).toBe(TANK_MAX_LIFE);
  });

  it("el Escudo solo anula el primero: se come una cabeza, no las cinco, y la segunda duele", () => {
    const [mid, tip] = landings();
    const spot = { x: (mid!.x + tip!.x) / 2, z: (mid!.z + tip!.z) / 2 };
    const bare = resolveTurn(duel(spot), MIRV);
    const first = resolveTurn(duel(spot, [withItems("A", { mirv: 2 }), buyItem(fresh("B"), "shield")]), MIRV);

    expect(first.blocked).toEqual(["B"]); // una vez, no una por cabeza
    expect(invOf(first.state, "B").shield).toBe(0);
    // Sin escudo le pegaban dos y lo mataban; con escudo, la primera no le saca nada y la segunda sí.
    expect(explosionsOn(bare.damage, "B")).toHaveLength(2);
    expect(lifeOf(bare.state, "B")).toBe(0);
    const hurt = explosionsOn(first.damage, "B");
    expect(hurt).toHaveLength(1);
    expect(hurt[0]!.damage).toBeGreaterThan(20);
    expect(lifeOf(first.state, "B")).toBeCloseTo(TANK_MAX_LIFE - hurt[0]!.damage, 6);
    expect(first.state.players[0]!.money).toBe(MONEY_START + hurt[0]!.money); // la cabeza bloqueada no paga
    // Cae un poco a cada cráter: la caída al de la cabeza que absorbió va tapada por el escudo; la del siguiente, no.
    expect(first.falls.filter((f) => f.tankId === "B").map((f) => f.shielded)).toEqual([true, false]);

    // Ya sin escudo, el Racimo siguiente le pega con las dos.
    const again = resolveTurn(first.state, MIRV);
    expect(again.blocked).toEqual([]);
    expect(lifeOf(again.state, "B")).toBeLessThan(lifeOf(first.state, "B"));
  });

  it("si lo alcanza una sola cabeza, el Escudo lo tapa entero", () => {
    // B donde cae una punta: le pega de lleno esa, y las demás explotan demasiado lejos.
    const tip = landings()[3]!;
    const spot = { x: tip.x, z: tip.z };
    const bare = resolveTurn(duel(spot), MIRV);
    expect(bare.shot.split!.heads[3]!.tankId).toBe("B");
    expect(explosionsOn(bare.damage, "B")).toHaveLength(1);
    expect(lifeOf(bare.state, "B")).toBe(0);

    const { state, blocked, damage } = resolveTurn(duel(spot, [withItems("A", { mirv: 1 }), buyItem(fresh("B"), "shield")]), MIRV);
    expect(blocked).toEqual(["B"]);
    expect(damage).toEqual([]);
    expect(lifeOf(state, "B")).toBe(TANK_MAX_LIFE);
    expect(invOf(state, "B").shield).toBe(0);
  });

  it("si choca mientras sube no llega a abrirse: explota ahí, como una cabeza sola", () => {
    // Un paredón a 80 delante de A: el tiro lo encuentra subiendo.
    const m = duel();
    for (let z = 150; z < 257; z++) for (let x = 0; x < 257; x++) m.terrain.heights[x + z * 257] = 80;
    const { shot, state } = resolveTurn(m, MIRV);
    expect(shot.split).toBeUndefined();
    expect(shot.outcome).toBe("ground");
    expect(shot.z).toBeLessThan(153);
    expect(shotImpacts(shot)).toEqual([shot]);
    const flat = duel();
    expect(lowered(m.terrain, state.terrain)).toBeLessThanOrEqual(lowered(flat.terrain, resolveTurn(flat, { ...MIRV, pitch: 0, power: 300 }).state.terrain));
    expect(lowered(m.terrain, state.terrain)).toBeGreaterThan(0);
  });

  it("las cabezas que se van del mapa no abren hoyo; las demás, sí", () => {
    const m = duel();
    // La primera potencia con la que la del medio todavía cae adentro y alguna punta ya se va.
    const power = Array.from({ length: 200 }, (_, k) => 600 + k).find((p) => {
      const s = resolveTurn(m, { ...MIRV, power: p }).shot;
      return s.outcome === "ground" && !!s.split?.heads.some((h) => h.outcome === "offmap");
    });
    expect(power).toBeDefined();
    const { shot, state } = resolveTurn(m, { ...MIRV, power: power! });
    const landed = shot.split!.heads.filter((h) => h.outcome === "ground");
    const gone = shot.split!.heads.filter((h) => h.outcome === "offmap");
    expect(gone.length).toBeGreaterThan(0);
    expect(landed.length + gone.length).toBe(HEADS);
    const one = lowered(m.terrain, resolveTurn(m, { ...MIRV, pitch: 0, power: 300 }).state.terrain);
    expect(lowered(m.terrain, state.terrain)).toBeLessThanOrEqual(landed.length * one);
    for (const h of landed) expect(terrainHeightAt(state.terrain, Math.trunc(h.x), Math.trunc(h.z))).toBeLessThan(GROUND);
  });

  it("si se fue entero no abre nada, y sin Racimo no se puede tirar", () => {
    const m = duel();
    const gone = resolveTurn(m, { ...MIRV, power: 1000 });
    expect(gone.shot.outcome).toBe("offmap");
    expect(shotImpacts(gone.shot).some((h) => h.outcome === "ground" || h.outcome === "tank")).toBe(false);
    expect(gone.state.terrain).toBe(m.terrain);
    expect(gone.damage).toEqual([]);
    expect(invOf(gone.state, "A").mirv).toBe(0);
    expect(() => resolveTurn(duel(FAR, [fresh("A"), fresh("B")]), MIRV)).toThrow();
  });

  it("el racimo cae del mismo tamaño con un tiro corto, uno alto o con viento", () => {
    /** Qué tan lejos de la del medio cayó cada una de las otras. */
    const reach = (m: MatchState3D, aim: { pitch: number; power: number }) => {
      const { split } = resolveTurn(m, { ...MIRV, ...aim }).shot;
      const [mid, ...rest] = split!.heads;
      return { tick: split!.tick, far: rest.map((h) => Math.hypot(h.x - mid!.x, h.z - mid!.z)) };
    };
    const low = reach(duel(), { pitch: 40, power: 420 });
    const high = reach(duel(), { pitch: 75, power: 900 });
    expect(high.tick).toBeGreaterThan(3 * low.tick); // uno se abre mucho más arriba que el otro
    for (const d of [...low.far, ...high.far]) expect(d).toBeCloseTo(RADIUS, 6);
    // Con viento todas derivan lo mismo: la X se corre entera, sin deformarse.
    const calm = landings();
    const blown = resolveTurn({ ...duel(), wind: { x: 4, z: -2 } }, MIRV).shot.split!.heads;
    expect(Math.abs(blown[0]!.x - calm[0]!.x)).toBeGreaterThan(5);
    for (let i = 1; i < HEADS; i++) {
      expect(blown[i]!.x - blown[0]!.x).toBeCloseTo(calm[i]!.x - calm[0]!.x, 6);
      expect(blown[i]!.z - blown[0]!.z).toBeCloseTo(calm[i]!.z - calm[0]!.z, 6);
    }
  });

  it("si la cima queda casi contra el piso se abren menos, en vez de salir disparadas de costado", () => {
    // Una meseta que arranca justo antes de la cima del tiro, una celda por debajo: caen enseguida.
    const m = duel();
    const open = resolveTurn(m, MIRV).shot.split!;
    for (let z = Math.floor(open.z) - 2; z < 257; z++) for (let x = 0; x < 257; x++) m.terrain.heights[x + z * 257] = open.y - 1;
    const { split } = resolveTurn(m, MIRV).shot;
    expect([split!.x, split!.y, split!.z]).toEqual([open.x, open.y, open.z]);
    const [mid, ...rest] = split!.heads;
    const fall = mid!.ticks - split!.tick;
    expect(fall).toBeLessThan(60);
    for (const h of rest) {
      const d = Math.hypot(h.x - mid!.x, h.z - mid!.z);
      expect(d).toBeLessThan(RADIUS - 1);
      expect(d).toBeLessThanOrEqual(SPLIT_MAX_KICK * VELOCITY_TO_POSITION * (h.ticks - split!.tick) + 1e-9);
    }
  });

  it("splitDirection: la del medio no se corre y las demás se reparten parejo alrededor del rumbo", () => {
    expect(splitDirection(HEADS, 37, 0)).toEqual({ x: 0, z: 0 });
    const dirs = [1, 2, 3, 4].map((i) => splitDirection(HEADS, 37, i));
    for (const d of dirs) expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 9);
    expect(dirs.reduce((s, d) => s + d.x, 0)).toBeCloseTo(0, 9);
    expect(dirs.reduce((s, d) => s + d.z, 0)).toBeCloseTo(0, 9);
    // Ninguna sale justo para adelante ni justo para atrás: son las puntas de una X.
    const ahead = { x: Math.cos((37 * Math.PI) / 180), z: Math.sin((37 * Math.PI) / 180) };
    for (const d of dirs) expect(Math.abs(d.x * ahead.x + d.z * ahead.z)).toBeCloseTo(Math.SQRT1_2, 9);
  });
});

describe("tienda con Racimo", () => {
  it("en la carta se llama Racimo, viene de a 1 y sale menos que un Bombazo", () => {
    expect(isPlayable("mirv")).toBe(true);
    expect(SHOP_ITEMS.mirv.name).toBe("Racimo");
    expect(SHOP_ITEMS.mirv.pack).toBe(1);
    expect(SHOP_ITEMS.mirv.price).toBe(WEAPONS.mirv.cost);
    expect(SHOP_ITEMS.mirv.price).toBeLessThan(SHOP_ITEMS.nuke.price);
    const a = buyItem(fresh("A"), "mirv");
    expect(a.inventory.mirv).toBe(1);
    expect(a.money).toBe(MONEY_START - SHOP_ITEMS.mirv.price);
    expect(buyItem(a, "mirv").inventory.mirv).toBe(2);
  });
});
