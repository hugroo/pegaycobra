import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, generateCode, isValidCode } from "../src/codes";
import { Game, parseFireMessage, shotDurationMs, shotMark, TURN_SECONDS } from "../src/game";

describe("códigos de sala", () => {
  it("son 4 letras mayúsculas sin O, I, 0 ni 1", () => {
    for (const bad of ["O", "I", "0", "1"]) expect(CODE_ALPHABET).not.toContain(bad);
    for (let i = 0; i < 2000; i++) {
      const c = generateCode(new Set());
      expect(c).toMatch(/^[A-Z]{4}$/);
      expect(c).not.toMatch(/[OI01]/);
      expect(isValidCode(c)).toBe(true);
    }
  });

  it("no repiten un código en uso", () => {
    let calls = 0;
    const rng = () => (calls++ < 4 ? 0 : 0.5); // primero AAAA, después otra cosa
    expect(generateCode(new Set(["AAAA"]), rng)).not.toBe("AAAA");
  });
});

describe("mensaje de tiro", () => {
  it("lee yaw, pitch, power y weapon (sin weapon = Baby Missile)", () => {
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600 })).toEqual({ yaw: 30, pitch: 45, power: 600, weapon: "babyMissile" });
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weapon: "missile" })).toEqual({
      yaw: 30,
      pitch: 45,
      power: 600,
      weapon: "missile",
    });
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weapon: "roller" })!.weapon).toBe("roller");
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weapon: "napalm" })!.weapon).toBe("napalm");
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weapon: "dirt" })!.weapon).toBe("dirt");
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weapon: "mirv" })!.weapon).toBe("mirv");
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weapon: "leapfrog" })!.weapon).toBe("leapfrog");
  });

  it("cualquier otro campo (daño, impacto, posición) se ignora y no llega al sim", () => {
    const msg = { yaw: 30, pitch: 45, power: 600, damage: 100, impactX: 120, posY: 3 };
    expect(parseFireMessage(msg)).toEqual({ yaw: 30, pitch: 45, power: 600, weapon: "babyMissile" });
  });

  it("descarta el mensaje si pide otra arma, si falta un número o si viene basura", () => {
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weapon: "babyNuke" })).toBeNull();
    expect(parseFireMessage({ yaw: 30, pitch: 45, power: 600, weaponId: "babyNuke" })).toBeNull();
    expect(parseFireMessage({ angle: 45, power: 600 })).toBeNull(); // el formato 2D ya no alcanza
    expect(parseFireMessage({ yaw: "30", pitch: 45, power: 600 })).toBeNull();
    expect(parseFireMessage({ yaw: 30, pitch: Number.NaN, power: 600 })).toBeNull();
    expect(parseFireMessage(null)).toBeNull();
    expect(parseFireMessage([30, 45, 600])).toBeNull();
  });
});

describe("marca del último tiro", () => {
  /** Un recorrido de `n` puntos: el punto i es (i, i, i). */
  const line = (n: number) => Array.from({ length: n * 3 }, (_, k) => Math.floor(k / 3));

  it("un tiro común deja una línea raleada, de punta a punta, y un punto donde cayó", () => {
    const mark = shotMark({ outcome: "ground", x: 30, y: 4, z: 50, ticks: 400, path: line(401) });
    expect(mark.spots).toEqual([30, 50, 0]);
    expect(mark.path.length).toBeLessThanOrEqual(42 * 3);
    expect(mark.path.slice(0, 3)).toEqual([0, 0, 0]);
    expect(mark.path.slice(-3)).toEqual([400, 400, 400]);
  });

  it("al agua: el punto queda donde se hundió, marcado como agua; el que se fue del mapa no deja punto", () => {
    expect(shotMark({ outcome: "water", x: 10, y: 0.5, z: 20, ticks: 9, path: line(10) }).spots).toEqual([10, 20, 1]);
    const gone = shotMark({ outcome: "offmap", x: -3, y: 9, z: 20, ticks: 9, path: line(10) });
    expect(gone.spots).toEqual([]);
    expect(gone.path).toEqual(line(10));
  });

  it("un Racimo deja el punto de cada cabeza y una sola línea, hasta donde se abrió", () => {
    const head = (x: number, outcome: "ground" | "tank" | "water" | "offmap") => ({ outcome, x, y: 3, z: 7, ticks: 60, path: line(30) });
    const heads = [head(1, "ground"), head(2, "water"), head(3, "offmap"), head(4, "tank"), head(5, "ground")];
    const mark = shotMark({ outcome: "ground", x: 1, y: 3, z: 7, ticks: 60, path: line(31), split: { x: 30, y: 30, z: 30, tick: 30, heads } });
    expect(mark.spots).toEqual([1, 7, 0, 2, 7, 1, 4, 7, 0, 5, 7, 0]);
    expect(mark.path).toEqual(line(31)); // el recorrido de las cabezas no viaja
  });

  it("un Rebote conserva el punto donde picó", () => {
    const mark = shotMark({ outcome: "ground", x: 9, y: 2, z: 9, ticks: 400, path: line(401), bounce: { x: 207, y: 207, z: 207, tick: 207 } });
    const xs = mark.path.filter((_, k) => k % 3 === 0);
    expect(xs).toContain(207);
  });
});

/** Yaw con el que arranca el cañón del jugador (mirando al centro del mapa). */
function aimYaw(g: Game, id: string): number {
  return g.aims.get(id)!.yaw;
}

function twoPlayerGame(turnSeconds = TURN_SECONDS) {
  const g = new Game(turnSeconds);
  g.addPlayer("A", "Ana");
  g.addPlayer("B", "Beto");
  return g;
}

describe("lobby", () => {
  it("el primero es anfitrión y solo él arranca, con 2 o más", () => {
    const g = new Game();
    g.addPlayer("A", "Ana");
    expect(g.hostId).toBe("A");
    expect(g.start("A", 1)).toBe(false); // solo uno
    g.addPlayer("B", "Beto");
    expect(g.start("B", 1)).toBe(false); // no es anfitrión
    expect(g.start("A", 1)).toBe(true);
    expect(g.phase).toBe("aiming");
    expect(g.turnId).toBe("A");
  });

  it("máximo 4 y nadie entra después de arrancar", () => {
    const g = new Game();
    for (const id of ["A", "B", "C", "D"]) g.addPlayer(id, id);
    expect(() => g.addPlayer("E", "E")).toThrow();
    const h = twoPlayerGame();
    h.start("A", 1);
    expect(() => h.addPlayer("C", "C")).toThrow();
  });

  it("si se va el anfitrión, pasa al siguiente", () => {
    const g = twoPlayerGame();
    g.removePlayer("A");
    expect(g.hostId).toBe("B");
    expect(g.seats).toHaveLength(1);
  });

  it("los nombres se limpian y tienen un default", () => {
    const g = new Game();
    expect(g.addPlayer("A", "   ").name).toBe("Jugador 1");
    expect(g.addPlayer("B", "x".repeat(50)).name).toHaveLength(16);
  });
});

describe("turnos", () => {
  it("solo dispara el del turno; el tiro pasa por animating y después cambia el turno", () => {
    const g = twoPlayerGame();
    g.start("A", 7);
    expect(g.fire("B", { yaw: 0, pitch: 45, power: 500 })).toBeNull();
    const shot = g.fire("A", { yaw: aimYaw(g, "A"), pitch: 60, power: 400 });
    expect(shot).not.toBeNull();
    expect(shot!.result.shot.path!.length).toBeGreaterThan(3);
    expect(g.phase).toBe("animating");
    expect(g.fire("A", { yaw: 0, pitch: 60, power: 400 })).toBeNull(); // no dispara dos veces
    g.finishShot();
    expect(["aiming", "shop"]).toContain(g.phase);
    if (g.phase === "aiming") expect(g.turnId).toBe("B");
  });

  it("el estado no cambia hasta finishShot (el cráter aparece al llegar el proyectil)", () => {
    const g = twoPlayerGame();
    g.start("A", 7);
    const before = g.match!.terrain;
    g.fire("A", { yaw: aimYaw(g, "A"), pitch: 80, power: 300 });
    expect(g.match!.terrain).toBe(before);
    g.finishShot();
    expect(g.match!.terrain).not.toBe(before);
  });

  it("los campos de daño o impacto que manda el cliente no cambian el resultado", () => {
    const run = (extra: object) => {
      const g = twoPlayerGame();
      g.start("A", 7);
      return g.fire("A", { yaw: aimYaw(g, "A"), pitch: 60, power: 400, ...extra })!.result;
    };
    expect(run({ damage: 999, impactX: 1, killed: "B" })).toEqual(run({}));
  });

  it("el estado arranca en 3D: tanques lejos entre sí y viento como vector", () => {
    const g = new Game();
    for (const id of ["A", "B", "C", "D"]) g.addPlayer(id, id);
    g.start("A", 99);
    const t = g.match!.tanks;
    for (let i = 0; i < t.length; i++)
      for (let j = i + 1; j < t.length; j++) expect(Math.hypot(t[i]!.x - t[j]!.x, t[i]!.z - t[j]!.z)).toBeGreaterThanOrEqual(60);
    expect(g.match!.terrain.width * g.match!.terrain.depth).toBe(g.match!.terrain.heights.length);
    expect(typeof g.match!.wind.x).toBe("number");
    expect(typeof g.match!.wind.z).toBe("number");
  });

  it("a los 20 s sin tirar, pierde el turno con un tiro nulo", () => {
    const g = twoPlayerGame();
    g.start("A", 7);
    const terrain = g.match!.terrain;
    for (let i = 0; i < TURN_SECONDS - 1; i++) expect(g.tickSecond()).toBe(false);
    expect(g.turnId).toBe("A");
    expect(g.tickSecond()).toBe(true);
    expect(g.turnId).toBe("B");
    expect(g.timeLeft).toBe(TURN_SECONDS);
    expect(g.match!.terrain).toBe(terrain); // nada explotó
  });

  it("la duración de la animación sale de los ticks del sim", () => {
    expect(shotDurationMs(363)).toBe(Math.round((363 * 0.01125 * 1000) / 1.5));
    expect(shotDurationMs(1e9)).toBe(8000);
  });
});

describe("fin de partida", () => {
  it("si se van todos menos uno, ese gana", () => {
    const g = new Game();
    for (const id of ["A", "B", "C"]) g.addPlayer(id, id);
    g.start("A", 3);
    g.removePlayer("B");
    expect(g.phase).toBe("aiming");
    g.removePlayer("A"); // era su turno
    expect(g.phase).toBe("ended");
    expect(g.winnerId).toBe("C");
  });

  it("si se va el otro durante la animación, gana el que queda en el acto (y el tiro se descarta)", () => {
    const g = twoPlayerGame();
    g.start("A", 3);
    g.fire("A", { yaw: aimYaw(g, "A"), pitch: 45, power: 300 });
    g.removePlayer("B");
    expect(g.phase).toBe("ended");
    expect(g.endReason).toBe("forfeit");
    expect(g.winnerId).toBe("A");
    g.finishShot(); // el timeout de la sala llega igual: no hace nada
    expect(g.phase).toBe("ended");
  });

  it("con 3, si uno se va durante la animación, la ronda sigue y se decide al terminar el tiro", () => {
    const g = new Game();
    for (const id of ["A", "B", "C"]) g.addPlayer(id, id);
    g.start("A", 3);
    g.fire("A", { yaw: aimYaw(g, "A"), pitch: 45, power: 300 });
    g.removePlayer("B");
    expect(g.phase).toBe("animating");
    g.finishShot();
    expect(g.match!.tanks.find((t) => t.id === "B")!.life).toBe(0);
    expect(["aiming", "shop"]).toContain(g.phase);
  });

  it("los turnos saltean tanques muertos", () => {
    const g = new Game();
    for (const id of ["A", "B", "C"]) g.addPlayer(id, id);
    g.start("A", 3);
    g.removePlayer("B");
    g.tickSecond();
    for (let i = 0; i < TURN_SECONDS; i++) g.tickSecond();
    expect(g.turnId).toBe("C");
  });
});
