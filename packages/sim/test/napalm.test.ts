import { describe, expect, it } from "vitest";
import {
  burnTurn3D,
  buyItem,
  createFlatTerrain,
  fireFromShot,
  inFire,
  isPlayable,
  MONEY_START,
  moneyForDamage,
  moveTank,
  resolveTurn,
  SHOP_ITEMS,
  simulateWeaponShot3D,
  startingInventory,
  startRound3D,
  TANK_MAX_LIFE,
  tanks3DAt,
  WEAPONS,
  type MatchState3D,
  type Player,
  type Terrain,
} from "../src";
import { dial } from "./aim";

const fresh = (id: string): Player => ({ id, money: MONEY_START, inventory: startingInventory() });
const withItems = (id: string, items: Player["inventory"]): Player => ({ ...fresh(id), inventory: { ...startingInventory(), ...items } });
const lifeOf = (s: MatchState3D, id: string) => s.tanks.find((t) => t.id === id)!.life;
const invOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.inventory;
const moneyOf = (s: MatchState3D, id: string) => s.players.find((p) => p.id === id)!.money;

const BURN = WEAPONS.napalm.burn!;
const A = { x: 128, z: 128 };
/** Donde cae yaw 90 / pitch 45 desde A, en piso plano, si sale con potencia 600. */
const B = { x: 128, z: 128 + 93 };

/** Un cerro en el camino del tiro: si el Napalm abriera cráter, acá se notaría. */
function hilly(): Terrain {
  const t = createFlatTerrain(257, 257, 10);
  for (let z = 0; z < 257; z++) for (let x = 0; x < 257; x++) t.heights[x + z * 257] = 10 + 12 * Math.exp(-((x - B.x) ** 2 + (z - B.z) ** 2) / 400);
  return t;
}

function duel(
  terrain: Terrain = createFlatTerrain(257, 257, 10),
  players: Player[] = [withItems("A", { napalm: 1, missile: 3 }), fresh("B")],
): MatchState3D {
  return { terrain, wind: { x: 0, z: 0 }, tanks: tanks3DAt(terrain, ["A", "B"], [A, B], TANK_MAX_LIFE), players };
}

const NAPALM = { playerId: "A", yaw: 90, pitch: 45, power: dial("napalm", 600), weaponId: "napalm" } as const;

describe("Napalm", () => {
  it("cae como un tiro normal: mismo vuelo que un Missile, sin rodar", () => {
    const m = duel(hilly());
    const napalm = resolveTurn(m, NAPALM).shot;
    const missile = resolveTurn(m, { ...NAPALM, weaponId: "missile" }).shot;
    expect(napalm).toEqual(missile);
    expect(napalm.landed).toBeUndefined();
    expect(isPlayable("napalm")).toBe(true);
  });

  it("no deforma el terreno: deja un fuego donde pegó y el heightmap queda igual", () => {
    const m = duel(hilly());
    const before = m.terrain.heights.slice();
    const { state, shot, fire, damage, falls, blocked } = resolveTurn(m, NAPALM);
    expect(["ground", "tank"]).toContain(shot.outcome);
    // El mismo terreno que entró, sin una celda cambiada (el Missile, con la misma puntería, sí lo baja).
    expect(state.terrain).toBe(m.terrain);
    expect(state.terrain.heights).toEqual(before);
    expect(resolveTurn(m, { ...NAPALM, weaponId: "missile" }).state.terrain.heights).not.toEqual(before);
    expect(falls).toEqual([]);

    expect(state.fires).toEqual([{ x: shot.x, z: shot.z, radius: BURN.radius, damagePerTurn: BURN.damagePerTurn, ownerId: "A", weaponId: "napalm" }]);
    expect(fire).toBe(state.fires![0]);
    expect(damage).toEqual([]);
    expect(blocked).toEqual([]);
    expect(invOf(state, "A").napalm).toBe(0);
    expect(() => resolveTurn(state, NAPALM)).toThrow(); // era uno solo
  });

  it("al caer no saca vida, aunque le pegue de lleno: lo que lastima es el fuego", () => {
    const m = duel();
    const { state, shot, fire, damage } = resolveTurn(m, NAPALM);
    expect(shot.outcome).toBe("tank");
    expect(shot.tankId).toBe("B");
    expect(inFire(fire!, state.tanks[1]!)).toBe(true);
    expect(damage).toEqual([]);
    expect(state.tanks).toEqual(m.tanks); // misma vida y misma altura: nadie cayó
    expect(state.terrain).toBe(m.terrain);
    expect(moneyOf(state, "A")).toBe(MONEY_START);
  });

  it("daña al que sigue arriba cuando empieza su turno, y solo a él", () => {
    const lit = resolveTurn(duel(), NAPALM).state;

    const first = burnTurn3D(lit, "B");
    expect(lifeOf(first.state, "B")).toBe(TANK_MAX_LIFE - BURN.damagePerTurn);
    const reward = moneyForDamage({ damage: BURN.damagePerTurn, killed: false, armsLevel: WEAPONS.napalm.armsLevel, friendly: false });
    expect(first.burns).toEqual([{ targetId: "B", cause: "burn", damage: BURN.damagePerTurn, killed: false, money: reward, ownerId: "A" }]);
    expect(moneyOf(first.state, "A")).toBe(MONEY_START + reward); // cobra el que lo prendió
    expect(first.state.terrain).toBe(lit.terrain);
    expect(first.state.fires).toBe(lit.fires); // sigue prendido

    // A está lejos: su turno empieza sin quemarse, y el estado es el mismo objeto.
    const farAway = burnTurn3D(first.state, "A");
    expect(farAway.burns).toEqual([]);
    expect(farAway.state).toBe(first.state);

    // Nadie le tiró de nuevo: en su turno siguiente vuelve a perder vida, hasta morir.
    let s = first.state;
    let turns = 1;
    while (lifeOf(s, "B") > 0) {
      const r = burnTurn3D(s, "B");
      expect(r.burns).toHaveLength(1);
      s = r.state;
      turns++;
    }
    expect(turns).toBe(Math.ceil(TANK_MAX_LIFE / BURN.damagePerTurn));
    expect(burnTurn3D(s, "B").burns).toEqual([]); // muerto no se quema
  });

  it("no daña al que se fue: con nafta sale del fuego", () => {
    const players = [withItems("A", { napalm: 1 }), withItems("B", { fuel: 1 })];
    const lit = resolveTurn(duel(undefined, players), NAPALM).state;
    const burned = burnTurn3D(lit, "B").state; // el primer turno lo agarra parado ahí
    expect(lifeOf(burned, "B")).toBe(TANK_MAX_LIFE - BURN.damagePerTurn);

    const moved = moveTank(burned, "B", { x: B.x - (BURN.radius + 3), z: B.z });
    expect(moved.fires).toBe(burned.fires); // el fuego se queda donde estaba
    expect(inFire(moved.fires![0]!, moved.tanks[1]!)).toBe(false);
    const next = burnTurn3D(moved, "B");
    expect(next.burns).toEqual([]);
    expect(next.state).toBe(moved);
    expect(lifeOf(next.state, "B")).toBe(TANK_MAX_LIFE - BURN.damagePerTurn);

    // Moverse adentro del disco no alcanza.
    const stillIn = moveTank(burned, "B", { x: B.x - (BURN.radius - 2), z: B.z });
    expect(burnTurn3D(stillIn, "B").burns).toHaveLength(1);
  });

  it("el borde del disco es el radio, medido en el piso", () => {
    const fire = { x: 100, z: 100, radius: BURN.radius };
    expect(inFire(fire, { x: 100 + BURN.radius, z: 100 })).toBe(true);
    expect(inFire(fire, { x: 100 + BURN.radius + 0.01, z: 100 })).toBe(false);
    expect(inFire(fire, { x: 100, z: 100 - BURN.radius - 0.01 })).toBe(false);
  });

  it("la fantasma y el server usan la misma cuenta", () => {
    const m = duel(hilly());
    // Lo que hace computeGhost en el cliente: simulateWeaponShot3D con el arma, el tanque propio y
    // los vivos, y fireFromShot sobre ese resultado.
    const me = m.tanks[0]!;
    const ghostShot = simulateWeaponShot3D(
      m.terrain,
      WEAPONS.napalm,
      { originX: me.x, originY: me.y, originZ: me.z, yaw: NAPALM.yaw, pitch: NAPALM.pitch, power: NAPALM.power, wind: m.wind, shooterId: "A" },
      m.tanks,
    );
    const ghostFire = fireFromShot(WEAPONS.napalm, ghostShot, "A");
    const server = resolveTurn(m, NAPALM);
    expect(server.shot).toEqual(ghostShot);
    expect(server.fire).toEqual(ghostFire);
    expect(server.state.fires).toEqual([ghostFire]);
    // Quién se quema sale de inFire sobre ese mismo disco, en los dos lados.
    expect(burnTurn3D(server.state, "B").burns.length > 0).toBe(inFire(ghostFire!, m.tanks[1]!));
    // Un arma que no quema no deja fuego; un Napalm que se fue del mapa tampoco.
    expect(fireFromShot(WEAPONS.missile, ghostShot, "A")).toBeNull();
    expect(fireFromShot(WEAPONS.napalm, { ...ghostShot, outcome: "offmap" }, "A")).toBeNull();
  });

  it("si se va del mapa no prende nada, pero se gasta", () => {
    const { state, shot, fire } = resolveTurn(duel(), { ...NAPALM, power: 1000 });
    expect(shot.outcome).toBe("offmap");
    expect(fire).toBeNull();
    expect(state.fires).toBeUndefined();
    expect(invOf(state, "A").napalm).toBe(0);
  });

  it("el escudo no apaga el fuego: no se gasta con el Napalm y sigue comiéndose un golpe directo", () => {
    const m = duel(undefined, [withItems("A", { napalm: 1, missile: 3 }), buyItem(fresh("B"), "shield")]);
    const lit = resolveTurn(m, NAPALM);
    expect(lit.blocked).toEqual([]);
    expect(invOf(lit.state, "B").shield).toBe(1);
    expect(lit.state.fires).toHaveLength(1);

    const burned = burnTurn3D(lit.state, "B");
    expect(lifeOf(burned.state, "B")).toBe(TANK_MAX_LIFE - BURN.damagePerTurn);
    expect(invOf(burned.state, "B").shield).toBe(1); // quemarse tampoco lo gasta

    // Un Missile de lleno: eso sí se lo come, como siempre. Y el fuego sigue.
    const hit = resolveTurn(burned.state, { ...NAPALM, weaponId: "missile" });
    expect(hit.blocked).toEqual(["B"]);
    expect(invOf(hit.state, "B").shield).toBe(0);
    expect(lifeOf(hit.state, "B")).toBe(TANK_MAX_LIFE - BURN.damagePerTurn);
    expect(hit.state.fires).toBe(burned.state.fires);
    expect(lifeOf(burnTurn3D(hit.state, "B").state, "B")).toBe(TANK_MAX_LIFE - 2 * BURN.damagePerTurn);
  });

  it("dos fuegos encimados queman dos veces; el propio te lo cobran", () => {
    const m = duel(undefined, [withItems("A", { napalm: 2 }), fresh("B")]);
    const twice = resolveTurn(resolveTurn(m, NAPALM).state, NAPALM).state;
    expect(twice.fires).toHaveLength(2);
    expect(lifeOf(burnTurn3D(twice, "B").state, "B")).toBe(TANK_MAX_LIFE - 2 * BURN.damagePerTurn);

    // A tira casi vertical y sin potencia: le cae encima y se quema con su propio fuego.
    const own = resolveTurn(duel(), { ...NAPALM, pitch: 90, power: 50 }).state;
    const r = burnTurn3D(own, "A");
    expect(r.burns[0]).toMatchObject({ targetId: "A", ownerId: "A" });
    expect(r.burns[0]!.money).toBeLessThan(0);
    expect(moneyOf(r.state, "A")).toBe(MONEY_START + r.burns[0]!.money);
  });

  it("dura lo que queda de la ronda: la ronda siguiente arranca sin fuego", () => {
    const lit = resolveTurn(duel(), NAPALM).state;
    expect(lit.fires).toHaveLength(1);
    expect(startRound3D(7, lit.players).fires).toBeUndefined();
  });
});

describe("tienda con Napalm", () => {
  it("viene de a 1, al precio de WEAPONS.napalm", () => {
    expect(SHOP_ITEMS.napalm.pack).toBe(1);
    const a = buyItem(fresh("A"), "napalm");
    expect(a.inventory.napalm).toBe(1);
    expect(a.money).toBe(MONEY_START - WEAPONS.napalm.cost);
    expect(buyItem(a, "napalm").inventory.napalm).toBe(2);
  });
});
