// SPDX-License-Identifier: GPL-2.0-or-later
// Mundo 3D con Three.js. Solo dibuja: el terreno llega del server (mensajes "terrain"), los
// tanques, la vida y los fuegos del estado, la trayectoria real del mensaje "shot". La fantasma la
// calcula main.ts con el sim y acá solo se dibuja.
//
// Ejes: los mismos del sim. x y z son el piso, y es la altura; 1 unidad de Three = 1 wu.
// yaw 0 = +X, 90 = +Z. En Three, rotar +θ alrededor de Y lleva +X hacia -Z, por eso rotation.y = -yaw.

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { ROLL_STEP, TANK_RADIUS, terrainHeightAt, type Terrain, type WeaponId } from "@pegaycobra/sim";
import { LAKE, SKY, SUN_DIR, landColor, type RGB } from "./landscape";

/** Paleta de tanques: el server manda el índice. Los cuatro primeros son los de los asientos. */
export const TANK_COLORS = ["#ff6b6b", "#4dabf7", "#69db7c", "#f783ac", "#ffd43b", "#ff922b", "#b197fc", "#3bc9db"];

/** Los tanques se dibujan más grandes que su esfera de colisión (2 wu) para que se lean de lejos. */
const TANK_SCALE = 2.1;
/** Cuánto brilla el tanque con su propio color, para que se lea también a la sombra de un cerro. */
const TANK_GLOW = 0.35;
/** Pivote del cañón en coordenadas locales del tanque (antes de escalar). [wu] */
const PIVOT_Y = 1.05;
const BARREL_LEN = 2.6;
const EXPLOSION_MS = 450;
/** Cuánto dura el destello donde se abre un Racimo. [ms] */
const OPEN_MS = 320;
/** Cuánto dura el destello de un Rebote donde pica. [ms] */
const BOUNCE_MS = 380;
/** Cuánto dura el polvo que levanta la Tierra. [ms] */
const DUST_MS = 800;
/** Nubes del polvo de la Tierra: una en el medio y el resto en ronda. */
const DUST_PUFFS = 7;
/** Lo que tarda el Rodillo en aplastarse cuando toca el piso. [ms] */
const SQUASH_MS = 120;
/** Cuánto dura el cartel de daño en el punto de impacto. [ms] */
const IMPACT_LABEL_MS = 1000;
/** Cuánto se queda la cámara mirando el impacto después de que llega el proyectil. [ms] */
export const LINGER_MS = 1300;
/** Lo que dura un chapuzón: el de un tanque que se ahoga y el de un tiro que se hunde. [ms] */
const SPLASH_MS = 1000;
const SPLASH_SMALL_MS = 600;
/** Llamas que se dibujan sobre cada fuego de Napalm. */
const FLAMES_PER_FIRE = 11;
/** La fantasma está viva: sus rayas corren hacia donde caería el tiro. La marca de un tiro viejo no se mueve. */
const GHOST_DASH = 1.6;
const GHOST_GAP = 1.2;
/** [wu/s] */
const GHOST_DASH_SPEED = 3;
/** Flecha del viento: lo que mide por unidad de viento (20 wu con viento 5) y lo menos que mide. [wu] */
const WIND_ARROW_LEN = 4;
const WIND_ARROW_MIN = 3;
/** A qué distancia del tanque del turno queda el centro de la flecha, hacia el centro del mapa. [wu] */
const WIND_ARROW_AWAY = 14;
/** Color del fogonazo de una explosión, y el del polvo que levanta la Tierra. */
const BLAST = "#ffb347";
const DUST = "#a8845a";
/** Color del proyectil y de su estela. */
const SHOT = "#fff4c2";
/** Radio de la bola de la Chispa: el resto se mide contra esta. [wu] */
const BALL_RADIUS = 0.7;
/** Cada cabeza de un Racimo, contra la bola de la Chispa. */
const HEAD_SIZE = 0.65;

/**
 * Lado del mapa de sombras según el ancho de la vista [px CSS]. El celular no puede con el de
 * escritorio; con 1024 la sombra del cerro sale más blanda pero sigue marcando la pendiente.
 */
function shadowSize(width: number): number {
  if (width <= 760) return 1024;
  if (width <= 1024) return 2048;
  return 4096;
}

/**
 * Deja en `geo` lugar para `n` puntos, marca que se dibujan esos y devuelve el atributo para
 * escribirlos. El buffer se reusa de un frame al otro: solo se pide uno nuevo cuando no alcanza.
 */
function reservePoints(geo: THREE.BufferGeometry, n: number): THREE.BufferAttribute {
  let pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < n) {
    geo.dispose(); // suelta los buffers viejos en la placa
    geo.deleteAttribute("lineDistance");
    pos = new THREE.BufferAttribute(new Float32Array(Math.max(64, n * 2) * 3), 3);
    geo.setAttribute("position", pos);
  }
  pos.needsUpdate = true;
  geo.setDrawRange(0, n);
  return pos;
}

/** Copia un recorrido (tríos x/y/z) a la línea, reusando su buffer. */
function setPath(geo: THREE.BufferGeometry, path: ArrayLike<number>): void {
  (reservePoints(geo, path.length / 3).array as Float32Array).set(path);
}

/**
 * Cómo se ve cada arma en el aire, para reconocerla sin leer el cartel: la forma, el tamaño contra
 * la bola de la Chispa y el color. Solo dibujo: por dónde va lo dice el recorrido del server.
 *   ball: la bola. drop: una gota, con la cola hacia atrás. bunch: las cinco cabezas juntas, hasta
 *   que se abren. roller: una bola con tacos, que al tocar el piso se aplasta y rueda.
 */
const SHOT_LOOK: Record<WeaponId, { shape: "ball" | "drop" | "bunch" | "roller"; size: number; color: string }> = {
  babyMissile: { shape: "ball", size: 1, color: SHOT },
  missile: { shape: "ball", size: 1.4, color: SHOT },
  roller: { shape: "roller", size: 1.2, color: SHOT },
  napalm: { shape: "drop", size: 1.1, color: "#ff7a1a" },
  babyNuke: { shape: "ball", size: 2, color: SHOT },
  nuke: { shape: "ball", size: 2.6, color: SHOT },
  dirt: { shape: "ball", size: 1.3, color: DUST },
  mirv: { shape: "bunch", size: 1, color: SHOT },
  leapfrog: { shape: "ball", size: 1, color: SHOT },
};

/** Silueta del tanque, como la manda el server. Solo cambia el dibujo. */
export type Hull = "box" | "flat" | "tower";

export interface TankModel {
  id: string;
  name: string;
  color: number;
  hull: Hull;
  x: number;
  y: number;
  z: number;
  life: number;
  /** Tiene un escudo puesto: se dibuja la burbuja. */
  shield: boolean;
  /** Está en piso bajo, a un hoyo del lago (onShore del sim): el cartel lleva la marca de orilla. */
  shore: boolean;
  yaw: number;
  pitch: number;
  isTurn: boolean;
  isMe: boolean;
}

export interface GhostModel {
  /** [x, y, z, ...] del sim. */
  path: number[];
  impact: { x: number; y: number; z: number } | null;
  /** El tiro no termina en el mapa (sale por un borde o se agota): la fantasma cierra en "se fue". */
  gone: boolean;
  /** El tiro termina en el agua y se hunde: la fantasma cierra en "al agua". */
  sunk?: boolean;
  shooter: TankModel;
  /** Radio de explosión del arma elegida. [wu] */
  radius: number;
  /**
   * Racimo: `path` llega hasta donde se abre y de ahí sale el recorrido de cada cabeza, con un
   * anillo donde caería (null: esa se va del mapa).
   */
  heads?: { path: number[]; impact: { x: number; y: number; z: number } | null }[];
  /** Rebote: dónde pica. `path` sigue de largo hasta `impact`, que es el segundo golpe. */
  bounce?: { x: number; y: number; z: number };
}

/**
 * Marca del último tiro de un tanque, como llega en el estado del server: la línea fina del
 * recorrido y un punto en el piso donde cayó. Queda quieta hasta que ese tanque tira de nuevo.
 */
export interface MarkModel {
  id: string;
  color: number;
  /** [x, y, z, ...]. Con un Racimo, hasta donde se abrió. */
  path: number[];
  /** Dónde cayó: uno, o uno por cabeza de un Racimo. `wet`: se hundió en el lago. Lo que se fue del mapa no deja punto. */
  spots: { x: number; z: number; wet: boolean }[];
}

export interface ShotModel {
  /** El arma disparada: de ahí sale cómo se dibuja el proyectil (SHOT_LOOK). */
  weapon: WeaponId;
  path: number[];
  start: number;
  /** Lo que dura el tiro entero: con un Racimo, hasta que cae la última cabeza. */
  durationMs: number;
  explodes: boolean;
  color: number;
  /** Radio de explosión del arma disparada. [wu] */
  radius: number;
  /** Racimo que se abrió: `path` llega hasta la apertura y de ahí sigue cada cabeza. `lands`: explota donde termina. */
  heads?: { path: number[]; lands: boolean }[];
  /** Rebote que picó: el punto de `path` donde tocó el piso. Ahí da un destello y sigue. */
  bounce?: number;
  /** Rodillo que tocó el piso: el punto de `path` desde donde rueda. */
  roll?: number;
  /** El tiro no explota, levanta polvo (Tierra): en vez del fogonazo, nubes color tierra. */
  dust?: boolean;
  /** Dónde terminó el tiro y qué dice el cartel de impacto ("-40", "se fue"). Los dos vienen del server. */
  impact: { x: number; y: number; z: number };
  label: string;
}

/** Un fuego de Napalm: disco en el piso. Viene del estado del server. [wu] */
export interface FireModel {
  x: number;
  z: number;
  radius: number;
}

/** Modo nafta: alcance alrededor del tanque y el destino bajo el cursor. */
export interface MoveModel {
  center: { x: number; z: number };
  range: number;
  hover: { x: number; y: number; z: number; ok: boolean } | null;
}

export interface FrameModel {
  tanks: TankModel[];
  ghost: GhostModel | null;
  /** El mismo objeto mientras la marca no cambie: recién con uno nuevo se rearma la línea. */
  marks: MarkModel[];
  shot: ShotModel | null;
  wind: { x: number; z: number };
  fires: FireModel[];
  move: MoveModel | null;
  now: number;
}

interface TankView {
  root: THREE.Group;
  yawG: THREE.Group;
  pitchG: THREE.Group;
  /** Lo que sigue al giro del cañón pero queda a la vista con el tanque muerto (el mástil de la Torre). */
  deckG: THREE.Group;
  bodyMat: THREE.MeshLambertMaterial;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  nameEl: HTMLSpanElement;
  /** Marca de orilla, al lado del nombre. Es un aviso: no cambia nada del tiro. */
  shoreEl: HTMLElement;
  distEl: HTMLElement;
  barEl: HTMLElement;
  /** Flecha en el borde de la pantalla, para cuando el tanque queda fuera de cámara. */
  edgeEl: HTMLDivElement;
  edgeArrow: HTMLElement;
  edgeText: HTMLElement;
  marker: THREE.Mesh;
  /** Burbuja del escudo. */
  shield: THREE.Mesh;
  color: number;
  hull: Hull;
  /** Altura de la flecha de turno (local, antes de escalar): la Torre la lleva más arriba. */
  markerY: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Hasta dónde llega cada silueta (local, antes de escalar): ahí va el cartel, y la flecha de turno arriba. */
const HULL_TOP: Record<Hull, number> = { box: 3.6, flat: 3.6, tower: 6.2 };

/**
 * Las tres siluetas, con primitivas. El pivote y el largo del cañón son los mismos en las tres (el
 * tiro sale del mismo lugar); cambia el casco. Nada pasa por el arco que barre el cañón: el mástil
 * de la Torre va atrás y a un costado, en `deck`, que gira con el cañón.
 */
function buildHull(hull: Hull, bodyMat: THREE.Material, dark: THREE.Material, deck: THREE.Group): THREE.Mesh[] {
  const box = (w: number, h: number, d: number, y: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.y = y;
    return mesh;
  };
  const dome = (r: number, y: number, squash = 1) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
    mesh.position.y = y;
    mesh.scale.y = squash;
    return mesh;
  };
  if (hull === "flat") {
    // Chato: ancho y bajo, una torreta aplastada. Nada sobresale por encima del cañón.
    return [box(4.4, 0.4, 3.2, 0.2, dark), box(4.0, 0.45, 2.9, 0.62, bodyMat), dome(1.15, 0.84, 0.5)];
  }
  if (hull === "tower") {
    // Torre: casco redondo y un mástil alto con una cofa arriba. Se ve de lejos por encima del cerro.
    // El casco es un cilindro para que el mástil, que gira con el cañón, siempre pise sobre él.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 3.6, 10), bodyMat);
    mast.position.set(-0.85, 2.9, 0.85);
    const nest = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.6, 1.1), bodyMat);
    nest.position.set(-0.85, 4.95, 0.85);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 8), dark);
    tip.position.set(-0.85, 5.6, 0.85);
    for (const part of [mast, nest, tip]) part.castShadow = true;
    deck.add(mast, nest, tip);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.45, 0.9, 20), bodyMat);
    body.position.y = 1.0;
    return [box(2.8, 0.6, 2.4, 0.3, dark), body, dome(0.7, PIVOT_Y + 0.25)];
  }
  // Caja: la de siempre.
  return [box(3.4, 0.6, 2.6, 0.3, dark), box(3, 0.8, 2.2, 0.95, bodyMat), dome(0.75, PIVOT_Y + 0.25)];
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly edgeLayer: HTMLDivElement;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight("#fff1d6", 2.3);
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
  private terrain: Terrain | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  /** 0..1 por celda: cuánto quemó un cráter (solo visual). */
  private scorch = new Float32Array(0);
  /** 0..1 por celda: cuánto la tiñe un fuego de Napalm (solo visual: el heightmap no cambia). */
  private heat = new Float32Array(0);
  /** Los fuegos ya pintados; si cambia, se repinta la mancha y se rearman las llamas. */
  private fireKey = "";
  private readonly flames = new THREE.Group();
  private readonly flameGeo = new THREE.ConeGeometry(0.55, 1, 6).translate(0, 0.5, 0); // base en y = 0
  private readonly flameMat = new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.85 });
  private readonly tanks = new Map<string, TankView>();

  private readonly ghostLine: THREE.Line;
  private readonly ghostRing: THREE.Mesh;
  private readonly ghostGone: CSS2DObject;
  private readonly moveRing: THREE.Mesh;
  private readonly moveMarker: THREE.Mesh;
  /** Racimo en la fantasma: la marca donde se abre y, por cabeza, su línea y su anillo. Se crean al usarse. */
  private readonly ghostOpen: THREE.Mesh;
  private readonly ghostHeads: { line: THREE.Line; ring: THREE.Mesh }[] = [];
  /** Rebote en la fantasma: la marca en el piso donde pica. */
  private readonly ghostBounce: THREE.Mesh;
  /** Marcas del último tiro, por tanque: la línea y un punto por golpe. Se crean al usarse. */
  private readonly marks = new Map<string, { src: MarkModel | null; line: THREE.Line; spots: THREE.Mesh[] }>();
  private readonly markDotGeo = new THREE.CircleGeometry(0.9, 20).rotateX(-Math.PI / 2);
  /** En el agua no hay hoyo que mirar: la marca es un aro sobre el lago. */
  private readonly markRingGeo = new THREE.RingGeometry(0.75, 1.2, 24).rotateX(-Math.PI / 2);
  private readonly shotLine: THREE.Line;
  private readonly shotBall: THREE.Mesh;
  /** Las otras formas del proyectil (SHOT_LOOK): la gota, las cabezas juntas y el Rodillo, que gira en `rollerSpin`. */
  private readonly shotDrop = new THREE.Group();
  private readonly shotBunch = new THREE.Group();
  private readonly shotRoller = new THREE.Group();
  private readonly rollerSpin = new THREE.Group();
  private readonly blast: THREE.Mesh;
  /** Polvo de la Tierra: nubes que suben y se abren sobre la loma. */
  private readonly dust = new THREE.Group();
  private readonly dustMat = new THREE.MeshBasicMaterial({ color: DUST, transparent: true, depthWrite: false });
  /** Racimo en vuelo: el destello de la apertura y, por cabeza, su estela, su bola y su fogonazo. */
  private readonly openFlash: THREE.Mesh;
  private readonly shotHeads: { line: THREE.Line; ball: THREE.Mesh; blast: THREE.Mesh }[] = [];
  /** Chapuzones en curso: dos anillos que se abren sobre el agua y un chorro que sube y cae. */
  private readonly splashes: { x: number; z: number; big: boolean; start: number; root: THREE.Group; rings: THREE.Mesh[]; spout: THREE.Mesh }[] = [];
  private readonly splashRingGeo = new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2);
  private readonly splashSpoutGeo = new THREE.ConeGeometry(0.5, 1, 10).translate(0, 0.5, 0); // base en y = 0
  /** Rebote en vuelo: el destello donde pica y el aro que se abre en el piso. */
  private readonly bounceFlash: THREE.Mesh;
  private readonly bounceRing: THREE.Mesh;
  private readonly impactLabel: CSS2DObject;
  private readonly windArrow: THREE.Mesh;
  /** Con qué viento, tanque y piso se armó la flecha: se rearma recién cuando cambia (turno nuevo). */
  private windKey = "";
  /** Sube cada vez que cambia el piso. */
  private terrainRev = 0;
  private readonly border: THREE.LineLoop;

  // Cámara orbital: mira a `target` desde una esfera de radio `dist`.
  private readonly target = new THREE.Vector3(128, 20, 128);
  private readonly targetGoal = new THREE.Vector3(128, 20, 128);
  camTheta = rad(225);
  camPhi = rad(32);
  camDist = 75;
  /** Distancia y ángulo efectivos, ya corregidos si el terreno tapa la vista. */
  private viewDist = 75;
  private viewPhi = rad(32);
  private thetaGoal: number | null = null;
  /** Alto de lo que el HUD tapa abajo (barra de tiro o tienda): las flechas de rivales quedan por encima. [px] */
  edgeBottomInset = 0;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    host.appendChild(this.labels.domElement);
    this.edgeLayer = document.createElement("div");
    this.edgeLayer.className = "edge-layer";
    host.appendChild(this.edgeLayer);

    const sky = new THREE.Color().setRGB(...SKY, THREE.SRGBColorSpace);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 260, 700);
    // Poca luz de cielo y un sol fuerte y bajo: la ladera que mira al sol queda clara y la otra en
    // sombra, así el relieve se lee por la luz. El sol además proyecta sombra (cerros y tanques).
    this.scene.add(new THREE.HemisphereLight("#cfe3ff", "#8a7a55", 0.75));
    const sun = this.sun;
    sun.position.set(128 + SUN_DIR[0] * 320, SUN_DIR[1] * 320, 128 + SUN_DIR[2] * 320);
    sun.target.position.set(128, 0, 128);
    sun.castShadow = true; // el tamaño del mapa lo pone resize(), según el ancho
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -190;
    sc.right = sc.top = 190;
    sc.near = 60;
    sc.far = 620;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.5;
    this.scene.add(sun, sun.target);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // El lago: sigue más allá del borde del mapa, para que el mapa no flote en el vacío.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(...LAKE, THREE.SRGBColorSpace) }),
    );
    floor.position.set(128, -0.3, 128);
    this.scene.add(floor);

    this.scene.add(this.flames);

    this.border = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: "#ffcf5a", transparent: true, opacity: 0.35 }),
    );
    this.scene.add(this.border);

    this.ghostLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: "#ffffff", dashSize: GHOST_DASH, gapSize: GHOST_GAP, transparent: true, opacity: 0.6 }),
    );
    this.ghostLine.frustumCulled = false;
    this.scene.add(this.ghostLine);

    // Anillo de radio 1: se escala al radio de explosión del arma.
    this.ghostRing = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.8, depthTest: false }),
    );
    this.ghostRing.renderOrder = 10;
    this.scene.add(this.ghostRing);
    this.ghostOpen = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.8),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.ghostOpen.renderOrder = 10;
    this.ghostOpen.visible = false;
    this.scene.add(this.ghostOpen);
    // Disco chico apoyado en el piso: ahí pica, no explota.
    this.ghostBounce = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.ghostBounce.renderOrder = 10;
    this.ghostBounce.visible = false;
    this.scene.add(this.ghostBounce);

    const goneEl = document.createElement("div");
    goneEl.className = "ghost-gone";
    goneEl.textContent = "Se fue";
    this.ghostGone = new CSS2DObject(goneEl);
    this.ghostGone.visible = false;
    this.scene.add(this.ghostGone);

    // Nafta: anillo de alcance (radio 1, se escala) y marcador del destino.
    this.moveRing = new THREE.Mesh(
      new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#ffcf5a", transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.moveRing.renderOrder = 11;
    this.scene.add(this.moveRing);
    this.moveMarker = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.4, 0.3, 24),
      new THREE.MeshBasicMaterial({ color: "#69db7c", transparent: true, opacity: 0.75, depthTest: false }),
    );
    this.moveMarker.renderOrder = 12;
    this.scene.add(this.moveMarker);

    this.shotLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: SHOT, transparent: true, opacity: 0.75 }),
    );
    this.shotLine.frustumCulled = false;
    this.scene.add(this.shotLine);
    this.shotBall = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 16, 12), new THREE.MeshBasicMaterial({ color: SHOT }));
    this.scene.add(this.shotBall);
    // Gota: la bola y un cono de cola. El frente mira a +Z, que es lo que lookAt apunta al recorrido.
    const dropMat = new THREE.MeshBasicMaterial({ color: SHOT_LOOK.napalm.color });
    this.shotDrop.add(
      new THREE.Mesh(this.shotBall.geometry, dropMat),
      new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.7, 12).rotateX(-Math.PI / 2).translate(0, 0, -1.15), dropMat),
    );
    // Racimo cerrado: las cinco cabezas apretadas, una adelante y cuatro alrededor.
    for (const [x, y, z] of [[0, 0, 0.45], [0.5, 0, -0.2], [-0.5, 0, -0.2], [0, 0.5, -0.2], [0, -0.5, -0.2]] as const) {
      const head = new THREE.Mesh(this.shotBall.geometry, this.shotBall.material);
      head.scale.setScalar(HEAD_SIZE);
      head.position.set(x, y, z);
      this.shotBunch.add(head);
    }
    // Rodillo: la bola con cuatro tacos oscuros, que son los que dejan ver que gira. Avanza hacia +X
    // y gira alrededor de Z.
    const stud = new THREE.BoxGeometry(0.34, 0.34, 1.05);
    const studMat = new THREE.MeshBasicMaterial({ color: "#3b2f2a" });
    this.rollerSpin.add(new THREE.Mesh(this.shotBall.geometry, this.shotBall.material));
    for (let k = 0; k < 4; k++) {
      const s = new THREE.Mesh(stud, studMat);
      s.position.set(Math.cos((k * Math.PI) / 2) * 0.6, Math.sin((k * Math.PI) / 2) * 0.6, 0);
      this.rollerSpin.add(s);
    }
    this.shotRoller.add(this.rollerSpin);
    this.scene.add(this.shotDrop, this.shotBunch, this.shotRoller);
    this.blast = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: BLAST, transparent: true, opacity: 0.9 }),
    );
    this.scene.add(this.blast);
    for (let k = 0; k < DUST_PUFFS; k++) this.dust.add(new THREE.Mesh(this.blast.geometry, this.dustMat));
    this.dust.visible = false;
    this.scene.add(this.dust);
    // Un aro que mira a la cámara: se abre alrededor de las cabezas sin taparlas.
    this.openFlash = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1, 40),
      new THREE.MeshBasicMaterial({ color: SHOT, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.openFlash.visible = false;
    this.scene.add(this.openFlash);
    this.bounceFlash = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.bounceFlash.visible = false;
    this.bounceRing = new THREE.Mesh(
      this.splashRingGeo,
      new THREE.MeshBasicMaterial({ color: SHOT, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.bounceRing.visible = false;
    this.scene.add(this.bounceFlash, this.bounceRing);
    const impactEl = document.createElement("div");
    impactEl.className = "impact-label";
    this.impactLabel = new CSS2DObject(impactEl);
    this.impactLabel.visible = false;
    this.scene.add(this.impactLabel);

    // Flecha del viento, calcada sobre el piso. La forma la arma drawWind.
    this.windArrow = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: "#9ad1ff", transparent: true, opacity: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    this.windArrow.frustumCulled = false;
    this.windArrow.visible = false;
    this.scene.add(this.windArrow);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const size = shadowSize(w);
    const shadow = this.sun.shadow;
    if (shadow.mapSize.x !== size) {
      shadow.mapSize.set(size, size);
      // El mapa ya armado es del tamaño viejo: se suelta y el renderer lo arma de nuevo.
      shadow.map?.dispose();
      shadow.map = null;
    }
  }

  get hasTerrain(): boolean {
    return this.terrain !== null;
  }

  // -------------------------------------------------------------------------
  // Terreno
  // -------------------------------------------------------------------------

  /**
   * Crea o actualiza el mesh. `rect` limita qué vértices se recalculan (parche de cráter o de loma).
   * `newRound`: el terreno es de una ronda nueva, se borran las marcas de quemado.
   */
  setTerrain(t: Terrain, rect?: { x0: number; z0: number; w: number; d: number }, newRound = false): void {
    const fresh = !this.terrainMesh || !this.terrain || this.terrain.width !== t.width || this.terrain.depth !== t.depth;
    this.terrain = t;
    this.terrainRev++;
    if (fresh) {
      this.buildTerrain(t);
      return;
    }
    if (newRound) this.scorch.fill(0);
    const geo = this.terrainMesh!.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const r = rect ?? { x0: 0, z0: 0, w: t.width, d: t.depth };
    const c = new THREE.Color();
    for (let z = r.z0; z < r.z0 + r.d; z++) {
      for (let x = r.x0; x < r.x0 + r.w; x++) {
        const i = x + z * t.width;
        const before = pos.getY(i);
        const now = t.heights[i]!;
        // Quemado: lo que bajó un cráter queda oscuro (en el original, DeformTextures + scorch).
        if (!newRound && now < before - 0.05) this.scorch[i] = Math.min(1, (this.scorch[i] ?? 0) + Math.min(1, (before - now) / 3));
        // Lo que subió es tierra nueva (una loma): tapa lo quemado.
        else if (!newRound && now > before + 0.05) this.scorch[i] = 0;
        pos.setY(i, now);
      }
    }
    // El color depende de la pendiente, que mira a los vecinos: se repinta una celda más allá del parche.
    const x1 = Math.min(t.width, r.x0 + r.w + 1);
    const z1 = Math.min(t.depth, r.z0 + r.d + 1);
    for (let z = Math.max(0, r.z0 - 1); z < z1; z++) {
      for (let x = Math.max(0, r.x0 - 1); x < x1; x++) {
        const i = x + z * t.width;
        terrainColor(t, x, z, this.scorch[i] ?? 0, this.heat[i] ?? 0, c);
        col.setXYZ(i, c.r, c.g, c.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private buildTerrain(t: Terrain): void {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    const { width: w, depth: d, heights } = t;
    this.scorch = new Float32Array(w * d);
    this.heat = new Float32Array(w * d);
    this.fireKey = ""; // el mesh nuevo nace sin mancha: drawFires la vuelve a pintar
    const positions = new Float32Array(w * d * 3);
    const colors = new Float32Array(w * d * 3);
    const c = new THREE.Color();
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const i = x + z * w;
        positions[i * 3] = x;
        positions[i * 3 + 1] = heights[i]!;
        positions[i * 3 + 2] = z;
        terrainColor(t, x, z, 0, 0, c);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
    }
    const index = new Uint32Array((w - 1) * (d - 1) * 6);
    let k = 0;
    for (let z = 0; z < d - 1; z++) {
      for (let x = 0; x < w - 1; x++) {
        const a = x + z * w;
        const b = a + 1;
        const cc = a + w;
        const dd = cc + 1;
        // Orden antihorario visto desde arriba (+Y), así las normales miran hacia arriba.
        index[k++] = a;
        index[k++] = cc;
        index[k++] = b;
        index[k++] = b;
        index[k++] = cc;
        index[k++] = dd;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    this.terrainMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.terrainMesh.castShadow = true;
    this.terrainMesh.receiveShadow = true;
    this.scene.add(this.terrainMesh);

    const mw = w - 1;
    const md = d - 1;
    this.border.geometry.dispose();
    this.border.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.2, 0),
      new THREE.Vector3(mw, 0.2, 0),
      new THREE.Vector3(mw, 0.2, md),
      new THREE.Vector3(0, 0.2, md),
    ]);
  }

  /**
   * Fuego de Napalm: tiñe de naranja las celdas del disco (la mancha) y le pone llamas encima.
   * El terreno es el mismo mesh con otro color; las alturas no se tocan.
   */
  private drawFires(fires: FireModel[], now: number): void {
    const t = this.terrain;
    if (!t || !this.terrainMesh) return;
    const key = fires.map((f) => `${f.x},${f.z},${f.radius}`).join("|");
    if (key !== this.fireKey) {
      this.fireKey = key;
      const before = this.heat;
      this.heat = new Float32Array(t.width * t.depth);
      this.flames.clear();
      for (const f of fires) {
        const r = Math.ceil(f.radius);
        const x1 = Math.min(t.width - 1, Math.ceil(f.x) + r);
        const z1 = Math.min(t.depth - 1, Math.ceil(f.z) + r);
        for (let z = Math.max(0, Math.floor(f.z) - r); z <= z1; z++) {
          for (let x = Math.max(0, Math.floor(f.x) - r); x <= x1; x++) {
            const dist = Math.hypot(x - f.x, z - f.z);
            if (dist > f.radius) continue;
            const i = x + z * t.width;
            this.heat[i] = Math.max(this.heat[i]!, 1 - 0.35 * (dist / f.radius));
          }
        }
        // Llamas repartidas en espiral adentro del disco.
        for (let k = 0; k < FLAMES_PER_FIRE; k++) {
          const flame = new THREE.Mesh(this.flameGeo, this.flameMat);
          const rr = f.radius * 0.92 * Math.sqrt((k + 0.5) / FLAMES_PER_FIRE);
          flame.position.set(f.x + Math.cos(k * 2.4) * rr, 0, f.z + Math.sin(k * 2.4) * rr);
          this.flames.add(flame);
        }
      }
      // Se repintan solo las celdas cuyo fuego cambió (las que se prendieron o, en ronda nueva, se apagaron).
      const col = this.terrainMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
      const c = new THREE.Color();
      for (let i = 0; i < this.heat.length; i++) {
        if (this.heat[i] === before[i]) continue;
        terrainColor(t, i % t.width, Math.floor(i / t.width), this.scorch[i] ?? 0, this.heat[i]!, c);
        col.setXYZ(i, c.r, c.g, c.b);
      }
      col.needsUpdate = true;
    }
    // Las llamas van apoyadas en el piso de ahora (si un cráter lo bajó, bajan con él) y titilan.
    this.flames.children.forEach((flame, k) => {
      flame.position.y = terrainHeightAt(t, flame.position.x, flame.position.z) - 0.1;
      flame.scale.set(1, 1.7 + 0.8 * Math.sin(now / 110 + k * 1.9), 1);
    });
    this.flameMat.opacity = 0.75 + 0.15 * Math.sin(now / 70);
  }

  /** Punto del terreno bajo el cursor (o null). */
  pick(ndcX: number, ndcY: number): THREE.Vector3 | null {
    if (!this.terrainMesh) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = ray.intersectObject(this.terrainMesh, false)[0];
    return hit ? hit.point : null;
  }

  // -------------------------------------------------------------------------
  // Cámara
  // -------------------------------------------------------------------------

  /**
   * Chapuzón en (x, z), desde `now`: grande (un tanque se ahogó, la cámara lo mira) o chico (un tiro
   * se hundió en el lago). Solo se dibuja: quién se ahogó lo dice el server.
   */
  splash(x: number, z: number, big: boolean, now: number): void {
    const mat = (color: string) => new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const root = new THREE.Group();
    const rings = [new THREE.Mesh(this.splashRingGeo, mat("#ffffff")), new THREE.Mesh(this.splashRingGeo, mat("#9ad1ff"))];
    const spout = new THREE.Mesh(this.splashSpoutGeo, mat("#ffffff"));
    root.add(...rings, spout);
    this.scene.add(root);
    this.splashes.push({ x, z, big, start: now, root, rings, spout });
  }

  /** Anima los chapuzones y saca los que terminaron. Devuelve el grande que sigue en curso, para la cámara. */
  private drawSplashes(now: number): { x: number; y: number; z: number } | null {
    let look: { x: number; y: number; z: number } | null = null;
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i]!;
      const q = (now - s.start) / (s.big ? SPLASH_MS : SPLASH_SMALL_MS);
      if (q >= 1) {
        this.scene.remove(s.root);
        for (const m of [...s.rings, s.spout]) (m.material as THREE.Material).dispose();
        this.splashes.splice(i, 1);
        continue;
      }
      const size = s.big ? 12 : 3;
      const y = (this.terrain ? terrainHeightAt(this.terrain, s.x, s.z) : 0) + 0.25;
      s.root.position.set(s.x, y, s.z);
      s.rings.forEach((ring, n) => {
        // El segundo anillo sale un poco después y llega menos lejos.
        const k = Math.max(0, q - n * 0.2) / (1 - n * 0.2);
        ring.scale.setScalar(0.5 + size * (1 - n * 0.35) * k);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      });
      // El chorro sube rápido y cae en la primera mitad.
      const up = Math.max(0, Math.sin(Math.min(1, q * 2) * Math.PI));
      s.spout.scale.set(size * 0.22, Math.max(0.001, size * 1.1 * up), size * 0.22);
      (s.spout.material as THREE.MeshBasicMaterial).opacity = 0.85 * up;
      if (s.big) look = { x: s.x, y, z: s.z };
    }
    return look;
  }

  /** Hacia dónde mira la cámara (se acerca suave). */
  focus(x: number, y: number, z: number): void {
    this.targetGoal.set(x, y, z);
  }

  /** Gira la cámara (suave) para quedar detrás de un tanque que apunta con `yaw`. */
  lookAlong(yaw: number): void {
    this.thetaGoal = rad(yaw + 180);
  }

  orbit(dTheta: number, dPhi: number): void {
    this.thetaGoal = null;
    this.camTheta += dTheta;
    this.camPhi = Math.min(rad(85), Math.max(rad(6), this.camPhi + dPhi));
  }

  zoom(factor: number): void {
    this.camDist = Math.min(420, Math.max(14, this.camDist * factor));
  }

  /** Vector "derecha de la pantalla" en el piso, para que arrastrar a la derecha gire a la derecha. */
  screenRight(): THREE.Vector3 {
    const v = new THREE.Vector3();
    this.camera.getWorldDirection(v);
    return new THREE.Vector3(-v.z, 0, v.x).normalize();
  }

  private dirFor(theta: number, phi: number): THREE.Vector3 {
    const cp = Math.cos(phi);
    return new THREE.Vector3(Math.cos(theta) * cp, Math.sin(phi), Math.sin(theta) * cp);
  }

  /** ¿Se ve el objetivo desde (theta, phi, dist)? Devuelve hasta dónde llega la vista libre. */
  private freeDistance(theta: number, phi: number, dist: number): number {
    if (!this.terrain) return dist;
    const dir = this.dirFor(theta, phi);
    for (let d = 3; d <= dist; d += 1.5) {
      const px = this.target.x + dir.x * d;
      const py = this.target.y + dir.y * d;
      const pz = this.target.z + dir.z * d;
      if (py < terrainHeightAt(this.terrain, px, pz) + 2) return d;
    }
    return dist;
  }

  /** Primer ángulo desde arriba (≥ el pedido) con vista libre; si no hay, el más alto y más cerca. */
  private clearView(theta: number, phi: number, dist: number): { phi: number; dist: number } {
    const top = rad(82);
    for (let p = phi; p <= top + 1e-6; p += rad(5)) {
      if (this.freeDistance(theta, p, dist) >= dist) return { phi: p, dist };
    }
    return { phi: top, dist: Math.max(8, this.freeDistance(theta, top, dist) - 2) };
  }

  /** `hold`: la cámara está mirando un impacto; el giro pedido con lookAlong espera a que termine. */
  private updateCamera(dt: number, hold: boolean): void {
    const k = 1 - Math.exp(-dt * 5);
    this.target.lerp(this.targetGoal, k);
    if (this.thetaGoal !== null && !hold) {
      let d = this.thetaGoal - this.camTheta;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camTheta += d * k;
      if (Math.abs(d) < 0.002) this.thetaGoal = null;
    }
    // Si el cerro tapa la vista, primero se sube la cámara (más cenital) hasta ver el objetivo;
    // si ni así, se acerca. Así nunca queda adentro de una ladera.
    const want = this.clearView(this.camTheta, this.camPhi, this.camDist);
    const fast = want.phi > this.viewPhi || want.dist < this.viewDist;
    this.viewPhi += (want.phi - this.viewPhi) * (fast ? 0.35 : k);
    this.viewDist += (want.dist - this.viewDist) * (fast ? 0.35 : k);
    this.camera.position.copy(this.target).addScaledVector(this.dirFor(this.camTheta, this.viewPhi), this.viewDist);
    if (this.terrain) {
      const ground = terrainHeightAt(this.terrain, this.camera.position.x, this.camera.position.z);
      if (this.camera.position.y < ground + 3) this.camera.position.y = ground + 3;
    }
    this.camera.lookAt(this.target);
  }

  // -------------------------------------------------------------------------
  // Tanques
  // -------------------------------------------------------------------------

  private tankView(m: TankModel): TankView {
    let v = this.tanks.get(m.id);
    if (v && v.hull === m.hull && v.color === m.color) return v;
    if (v) this.dropTank(m.id, v); // cambió de silueta o de color: se arma de nuevo
    const color = new THREE.Color(TANK_COLORS[m.color] ?? "#cccccc");
    const bodyMat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: TANK_GLOW });
    const dark = new THREE.MeshLambertMaterial({ color: "#222833" });
    const root = new THREE.Group();
    const yawG = new THREE.Group();
    yawG.position.y = PIVOT_Y + 0.35;
    const pitchG = new THREE.Group();
    yawG.add(pitchG);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, BARREL_LEN, 10), bodyMat);
    barrel.rotation.z = -Math.PI / 2; // el cilindro nace en Y; lo acostamos sobre +X
    barrel.position.x = BARREL_LEN / 2;
    pitchG.add(barrel);
    const deckG = new THREE.Group();
    const hullParts = buildHull(m.hull, bodyMat, dark, deckG);
    for (const part of [...hullParts, barrel]) part.castShadow = true;
    root.add(...hullParts, deckG, yawG);
    root.scale.setScalar(TANK_SCALE);
    const top = HULL_TOP[m.hull];

    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.9, 1.6, 4).rotateX(Math.PI),
      new THREE.MeshBasicMaterial({ color }),
    );
    const markerY = top + 1.6;
    marker.position.y = markerY;
    root.add(marker);

    // Escudo: burbuja translúcida alrededor del tanque. Solo visual; la regla está en el sim.
    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 28, 18),
      new THREE.MeshBasicMaterial({ color: "#9ad1ff", transparent: true, opacity: 0.25, depthWrite: false }),
    );
    shield.position.y = 0.9;
    shield.visible = false;
    root.add(shield);

    const labelEl = document.createElement("div");
    labelEl.className = "tank-label";
    const nameEl = document.createElement("span");
    const bar = document.createElement("i");
    const barEl = document.createElement("b");
    barEl.style.background = TANK_COLORS[m.color] ?? "#ccc";
    bar.append(barEl);
    const distEl = document.createElement("small");
    const shoreEl = document.createElement("em");
    shoreEl.textContent = "≈";
    shoreEl.title = "En la orilla: un Misil lo manda al agua";
    shoreEl.hidden = true;
    const head = document.createElement("div");
    head.append(nameEl, shoreEl);
    labelEl.append(head, bar, distEl);
    const label = new CSS2DObject(labelEl);
    label.position.set(0, top, 0);
    root.add(label);

    const edgeEl = document.createElement("div");
    edgeEl.className = "edge-marker";
    edgeEl.style.color = TANK_COLORS[m.color] ?? "#ccc";
    const edgeArrow = document.createElement("i");
    const edgeText = document.createElement("span");
    edgeEl.append(edgeArrow, edgeText);
    edgeEl.hidden = true;
    this.edgeLayer.appendChild(edgeEl);

    this.scene.add(root);
    v = { root, yawG, pitchG, deckG, bodyMat, label, labelEl, nameEl, shoreEl, distEl, barEl, edgeEl, edgeArrow, edgeText, marker, shield, color: m.color, hull: m.hull, markerY };
    this.tanks.set(m.id, v);
    return v;
  }

  private syncTanks(models: TankModel[], now: number): void {
    const seen = new Set<string>();
    for (const m of models) {
      seen.add(m.id);
      const v = this.tankView(m);
      const alive = m.life > 0;
      v.root.position.set(m.x, m.y, m.z);
      v.yawG.rotation.y = -rad(m.yaw);
      v.deckG.rotation.y = v.yawG.rotation.y;
      v.pitchG.rotation.z = rad(m.pitch);
      v.bodyMat.color.set(alive ? (TANK_COLORS[m.color] ?? "#ccc") : "#4b515c");
      v.bodyMat.emissive.copy(v.bodyMat.color);
      v.yawG.visible = alive;
      v.marker.visible = alive && m.isTurn;
      v.marker.position.y = v.markerY + Math.sin(now / 220) * 0.25;
      v.marker.rotation.y = now / 600;
      v.shield.visible = alive && m.shield;
      (v.shield.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.06 * Math.sin(now / 350);
      v.nameEl.textContent = (alive ? m.name : `${m.name} ✕`) + (m.isMe ? " (vos)" : "");
      v.shoreEl.hidden = !(alive && m.shore);
      v.barEl.style.width = `${Math.max(0, Math.min(100, m.life))}%`;
      v.labelEl.classList.toggle("turn", m.isTurn && alive);
      v.labelEl.classList.toggle("dead", !alive);
    }
    for (const [id, v] of this.tanks) if (!seen.has(id)) this.dropTank(id, v);
  }

  private dropTank(id: string, v: TankView): void {
    this.scene.remove(v.root);
    v.labelEl.remove();
    v.edgeEl.remove();
    this.tanks.delete(id);
  }

  /**
   * Marcador de rivales: si el tanque está en cuadro, su cartel muestra nombre y distancia; si
   * quedó fuera de cámara, una flecha pegada al borde de la pantalla apunta hacia él.
   * Se llama después de mover la cámara.
   */
  private syncRivalMarkers(models: TankModel[]): void {
    const me = models.find((t) => t.isMe);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.camera.updateMatrixWorld();
    const view = this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    const p = new THREE.Vector3();
    for (const m of models) {
      const v = this.tanks.get(m.id);
      if (!v) continue;
      const rival = !m.isMe && m.life > 0;
      const dist = me ? `${Math.round(Math.hypot(m.x - me.x, m.y - me.y, m.z - me.z))} m` : "";
      v.distEl.textContent = rival ? dist : "";
      if (!rival) {
        v.edgeEl.hidden = true;
        continue;
      }
      // Se mide a la altura del cartel: si el cartel no entra entero en cuadro, va la flecha.
      p.set(m.x, m.y + 5, m.z).applyMatrix4(view);
      const behind = p.z > -this.camera.near;
      p.applyMatrix4(this.camera.projectionMatrix);
      // Detrás de la cámara la proyección sale espejada: se da vuelta para que la flecha apunte bien.
      const nx = behind ? -p.x : p.x;
      let ny = behind ? -p.y : p.y;
      if (!behind && Math.abs(nx) < 0.92 && ny > -0.96 && ny < 0.84) {
        v.edgeEl.hidden = true;
        continue;
      }
      if (Math.abs(nx) < 1e-3 && Math.abs(ny) < 1e-3) ny = -1;
      const dx = nx * (w / 2);
      const dy = -ny * (h / 2);
      const room = h / 2 - 38 - (dy > 0 ? this.edgeBottomInset : 0);
      const k = Math.min((w / 2 - 70) / Math.max(1e-3, Math.abs(dx)), Math.max(1, room) / Math.max(1e-3, Math.abs(dy)));
      v.edgeEl.style.transform = `translate(${w / 2 + dx * k}px, ${h / 2 + dy * k}px) translate(-50%, -50%)`;
      v.edgeArrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      v.edgeText.textContent = dist ? `${m.name} · ${dist}` : m.name;
      v.edgeEl.hidden = false;
    }
  }

  /** Punta del cañón dibujado, en el mundo. */
  private barrelTip(m: TankModel): THREE.Vector3 {
    const y = rad(m.yaw);
    const p = rad(m.pitch);
    const pivot = new THREE.Vector3(m.x, m.y + (PIVOT_Y + 0.35) * TANK_SCALE, m.z);
    const dir = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
    return pivot.addScaledVector(dir, BARREL_LEN * TANK_SCALE);
  }

  // -------------------------------------------------------------------------
  // Trayectorias
  // -------------------------------------------------------------------------

  /** Corre las rayas de una línea de la fantasma según la hora. */
  private march(line: THREE.Line, now: number): void {
    const geo = line.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    let d = geo.getAttribute("lineDistance") as THREE.BufferAttribute | undefined;
    if (!d) {
      d = new THREE.BufferAttribute(new Float32Array(pos.count), 1);
      geo.setAttribute("lineDistance", d);
    }
    const period = GHOST_DASH + GHOST_GAP;
    const shift = period - (((now / 1000) * GHOST_DASH_SPEED) % period);
    const p = pos.array;
    let along = 0;
    for (let i = 0; i < geo.drawRange.count; i++) {
      if (i > 0) along += Math.hypot(p[i * 3]! - p[i * 3 - 3]!, p[i * 3 + 1]! - p[i * 3 - 2]!, p[i * 3 + 2]! - p[i * 3 - 1]!);
      d.setX(i, along + shift);
    }
    d.needsUpdate = true;
  }

  /**
   * Las marcas del último tiro de cada tanque: línea continua, fina y pálida, del color del tanque, y
   * un punto apoyado en el piso de ahora (el fondo del hoyo, o la loma que lo tapó). No se mueven.
   */
  private drawMarks(marks: MarkModel[]): void {
    for (const [id, v] of this.marks) {
      if (marks.some((m) => m.id === id)) continue;
      v.src = null;
      v.line.visible = false;
      for (const spot of v.spots) spot.visible = false;
    }
    for (const m of marks) {
      let v = this.marks.get(m.id);
      if (!v) {
        const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }));
        line.frustumCulled = false;
        this.scene.add(line);
        v = { src: null, line, spots: [] };
        this.marks.set(m.id, v);
      }
      const view = v;
      if (view.src !== m) {
        view.src = m;
        const color = new THREE.Color(TANK_COLORS[m.color] ?? "#fff");
        (view.line.material as THREE.LineBasicMaterial).color.copy(color).lerp(new THREE.Color("#ffffff"), 0.45);
        setPath(view.line.geometry, m.path);
        view.line.visible = m.path.length >= 6;
        while (view.spots.length < m.spots.length) {
          const spot = new THREE.Mesh(this.markDotGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false }));
          spot.renderOrder = 9;
          this.scene.add(spot);
          view.spots.push(spot);
        }
        view.spots.forEach((spot, i) => {
          const s = m.spots[i];
          spot.visible = !!s;
          if (!s) return;
          spot.geometry = s.wet ? this.markRingGeo : this.markDotGeo;
          (spot.material as THREE.MeshBasicMaterial).color.copy(color);
        });
      }
      m.spots.forEach((s, i) => view.spots[i]!.position.set(s.x, this.aboveGround(s.x, -Infinity, s.z) + 0.2, s.z));
    }
  }

  private drawGhost(g: GhostModel | null, now: number): void {
    this.drawGhostHeads(g, now);
    this.ghostBounce.visible = !!g?.bounce && g.path.length >= 6;
    if (g?.bounce) {
      this.ghostBounce.position.set(g.bounce.x, g.bounce.y + 0.15, g.bounce.z);
      (this.ghostBounce.material as THREE.MeshBasicMaterial).color.set(TANK_COLORS[g.shooter.color] ?? "#fff");
    }
    if (!g || g.path.length < 6) {
      this.ghostLine.visible = false;
      this.ghostRing.visible = false;
      this.ghostGone.visible = false;
      return;
    }
    // Arranca en la punta del cañón dibujado y se engancha con el primer punto del sim que queda
    // más adelante que esa punta, medido a lo largo del cañón.
    const tip = this.barrelTip(g.shooter);
    const y = rad(g.shooter.yaw);
    const p = rad(g.shooter.pitch);
    const dir = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
    const base = new THREE.Vector3(g.shooter.x, g.shooter.y + TANK_RADIUS, g.shooter.z);
    const reach = tip.clone().sub(base).dot(dir);
    const n = g.path.length / 3;
    const geo = this.ghostLine.geometry;
    // Los puntos se escriben en el buffer de siempre: la punta, uno de cada dos del sim y el último.
    const pos = reservePoints(geo, Math.ceil(n / 2) + 2);
    const tmp = new THREE.Vector3();
    let count = 0;
    pos.setXYZ(count++, tip.x, tip.y, tip.z);
    let started = false;
    for (let i = 0; i < n; i += 2) {
      tmp.fromArray(g.path, i * 3);
      if (!started && tmp.sub(base).dot(dir) < reach) continue;
      started = true;
      pos.setXYZ(count++, g.path[i * 3]!, g.path[i * 3 + 1]!, g.path[i * 3 + 2]!);
    }
    pos.setXYZ(count++, g.path[(n - 1) * 3]!, g.path[(n - 1) * 3 + 1]!, g.path[(n - 1) * 3 + 2]!);
    geo.setDrawRange(0, count);
    this.march(this.ghostLine, now);
    this.ghostLine.visible = true;

    if (g.impact) {
      this.ghostRing.position.set(g.impact.x, g.impact.y + 0.15, g.impact.z);
      this.ghostRing.scale.setScalar(g.radius);
      (this.ghostRing.material as THREE.MeshBasicMaterial).color.set(TANK_COLORS[g.shooter.color] ?? "#fff");
      this.ghostRing.visible = true;
    } else {
      this.ghostRing.visible = false;
    }
    // Sin impacto en el mapa, la línea termina en un cartel "se fue".
    // El final suele quedar fuera de cuadro, así que el cartel va en el último punto que se ve.
    this.ghostGone.visible = false;
    if (!g.gone) return;
    const goneText = g.sunk ? "Al agua" : "Se fue";
    if (this.ghostGone.element.textContent !== goneText) this.ghostGone.element.textContent = goneText;
    const ndc = new THREE.Vector3();
    for (let i = count - 1; i >= 0; i--) {
      ndc.fromBufferAttribute(pos, i).project(this.camera);
      if (Math.abs(ndc.x) > 0.88 || Math.abs(ndc.y) > 0.88 || ndc.z > 1) continue;
      this.ghostGone.position.fromBufferAttribute(pos, i);
      this.ghostGone.visible = true;
      break;
    }
  }

  /**
   * La apertura de un Racimo en la fantasma: una marca donde se abre y, de ahí, una línea punteada
   * por cabeza con su anillo donde caería. Sin cabezas (cualquier otra arma, o un Racimo que no
   * llega a abrirse) no dibuja nada.
   */
  private drawGhostHeads(g: GhostModel | null, now: number): void {
    const heads = g && g.path.length >= 6 ? (g.heads ?? []) : [];
    while (this.ghostHeads.length < heads.length) {
      const line = new THREE.Line(new THREE.BufferGeometry(), this.ghostLine.material);
      line.frustumCulled = false;
      const ring = new THREE.Mesh(this.ghostRing.geometry, (this.ghostRing.material as THREE.Material).clone());
      ring.renderOrder = 10;
      this.scene.add(line, ring);
      this.ghostHeads.push({ line, ring });
    }
    this.ghostOpen.visible = heads.length > 0;
    if (g && heads.length > 0) {
      this.ghostOpen.position.fromArray(g.path, g.path.length - 3);
      (this.ghostOpen.material as THREE.MeshBasicMaterial).color.set(TANK_COLORS[g.shooter.color] ?? "#fff");
    }
    this.ghostHeads.forEach((v, i) => {
      const h = heads[i];
      v.line.visible = !!h && h.path.length >= 6;
      v.ring.visible = !!h?.impact;
      if (!g || !h) return;
      if (v.line.visible) {
        const n = h.path.length / 3;
        const count = Math.ceil(n / 2) + 1;
        const pos = reservePoints(v.line.geometry, count);
        for (let k = 0; k < count; k++) {
          const a = Math.min(k * 2, n - 1) * 3;
          pos.setXYZ(k, h.path[a]!, h.path[a + 1]!, h.path[a + 2]!);
        }
        this.march(v.line, now);
      }
      if (h.impact) {
        v.ring.position.set(h.impact.x, h.impact.y + 0.15, h.impact.z);
        v.ring.scale.setScalar(g.radius);
        (v.ring.material as THREE.MeshBasicMaterial).color.set(TANK_COLORS[g.shooter.color] ?? "#fff");
      }
    });
  }

  /** `y`, o la altura del piso en (x, z) si el piso quedó más arriba (una loma tapó ese punto). [wu] */
  private aboveGround(x: number, y: number, z: number): number {
    return this.terrain ? Math.max(y, terrainHeightAt(this.terrain, x, z)) : y;
  }

  /** Dibuja el tiro real. Devuelve la posición actual del proyectil (para la cámara) o null. */
  private drawShot(s: ShotModel | null, now: number): THREE.Vector3 | null {
    this.shotLine.visible = false;
    this.shotBall.visible = this.shotDrop.visible = this.shotBunch.visible = this.shotRoller.visible = false;
    this.blast.visible = false;
    this.dust.visible = false;
    this.impactLabel.visible = false;
    this.openFlash.visible = false;
    this.bounceFlash.visible = this.bounceRing.visible = false;
    for (const v of this.shotHeads) v.line.visible = v.ball.visible = v.blast.visible = false;
    if (!s || s.path.length < 3) return null;
    const n = s.path.length / 3;
    const heads = s.heads ?? [];
    // Pasos del tiro entero: los de `path` y, si se abrió, los de la cabeza que más tarda en caer.
    const total = n - 1 + Math.max(0, ...heads.map((h) => h.path.length / 3 - 1));
    const elapsed = now - s.start;
    const p = Math.min(1, elapsed / Math.max(1, s.durationMs));
    const last = Math.min(n - 1, Math.floor(p * total));

    const geo = this.shotLine.geometry as THREE.BufferGeometry;
    if (geo.userData.src !== s.path) {
      setPath(geo, s.path);
      geo.userData.src = s.path;
    }
    geo.setDrawRange(0, last + 1);
    this.shotLine.visible = true;
    const at = new THREE.Vector3(s.path[last * 3]!, s.path[last * 3 + 1]!, s.path[last * 3 + 2]!);

    const msPerTick = s.durationMs / Math.max(1, total);
    if (heads.length > 0) {
      if (last < n - 1) this.drawProjectile(s, last, at, elapsed, msPerTick);
      else this.drawShotHeads(s, heads, p * total - (n - 1), msPerTick, elapsed, at);
    } else if (p < 1) {
      this.drawProjectile(s, last, at, elapsed, msPerTick);
    } else if (s.explodes && s.dust) {
      this.drawDust(at, s.radius, elapsed - s.durationMs);
    } else if (s.explodes && elapsed - s.durationMs < EXPLOSION_MS) {
      const q = (elapsed - s.durationMs) / EXPLOSION_MS;
      this.blast.position.copy(at);
      this.blast.scale.setScalar(s.radius * (0.35 + 0.9 * q));
      (this.blast.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - q);
      this.blast.visible = true;
    }
    // Rebote: un destello donde picó y un aro que se abre en el piso, desde que la bola pasa por ahí.
    // Ahí no explota: ni fogonazo ni hoyo.
    if (s.bounce !== undefined && s.bounce < n) {
      const since = elapsed - s.bounce * msPerTick;
      if (since >= 0 && since < BOUNCE_MS) {
        const q = since / BOUNCE_MS;
        this.bounceFlash.position.fromArray(s.path, s.bounce * 3);
        this.bounceFlash.scale.setScalar(2.2 - 1.6 * q);
        (this.bounceFlash.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - q);
        this.bounceRing.position.copy(this.bounceFlash.position);
        this.bounceRing.position.y += 0.2;
        this.bounceRing.scale.setScalar(1.5 + 5 * q);
        (this.bounceRing.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - q);
        this.bounceFlash.visible = this.bounceRing.visible = true;
      }
    }
    // Cartel de daño: anclado al punto de impacto en el mundo, así sigue a la cámara.
    if (p >= 1 && elapsed - s.durationMs < IMPACT_LABEL_MS) {
      const q = (elapsed - s.durationMs) / IMPACT_LABEL_MS;
      const el = this.impactLabel.element;
      if (el.textContent !== s.label) el.textContent = s.label;
      el.style.opacity = String(Math.min(1, (1 - q) * 3));
      this.impactLabel.position.set(s.impact.x, this.aboveGround(s.impact.x, s.impact.y, s.impact.z) + 3 + 4 * q, s.impact.z);
      this.impactLabel.visible = true;
    }
    return at;
  }

  /**
   * El proyectil en el punto `i` de `path`, con la forma de su arma (SHOT_LOOK). La gota y el Racimo
   * miran hacia donde van; el Rodillo, desde que toca el piso, se aplasta y gira lo que avanza.
   */
  private drawProjectile(s: ShotModel, i: number, at: THREE.Vector3, elapsed: number, msPerTick: number): void {
    const look = SHOT_LOOK[s.weapon];
    (this.shotBall.material as THREE.MeshBasicMaterial).color.set(look.color);
    const n = s.path.length / 3;
    if (look.shape === "ball" || n < 2) {
      this.shotBall.position.copy(at);
      this.shotBall.scale.setScalar(look.size);
      this.shotBall.visible = true;
      return;
    }
    // Hacia dónde va: del punto de ahora al que sigue (en el último, desde el anterior).
    const a = Math.min(i, n - 2) * 3;
    const dir = new THREE.Vector3(s.path[a + 3]! - s.path[a]!, s.path[a + 4]! - s.path[a + 1]!, s.path[a + 5]! - s.path[a + 2]!);
    if (look.shape === "roller") {
      const rolled = s.roll !== undefined && i >= s.roll ? i - s.roll : -1;
      const k = rolled < 0 ? 0 : Math.min(1, (rolled * msPerTick) / SQUASH_MS);
      this.shotRoller.position.copy(at);
      this.shotRoller.rotation.y = -Math.atan2(dir.z, dir.x);
      this.shotRoller.scale.set(look.size * (1 + 0.25 * k), look.size * (1 - 0.4 * k), look.size * (1 + 0.25 * k));
      // En el aire da vueltas despacio; en el piso, lo que corresponde a lo que avanzó.
      this.rollerSpin.rotation.z = rolled < 0 ? -elapsed / 260 : -(rolled * ROLL_STEP) / (BALL_RADIUS * look.size);
      this.shotRoller.visible = true;
      return;
    }
    const obj = look.shape === "drop" ? this.shotDrop : this.shotBunch;
    obj.position.copy(at);
    obj.lookAt(dir.add(at));
    if (look.shape === "bunch") obj.rotateZ(elapsed / 220);
    obj.scale.setScalar(look.size);
    obj.visible = true;
  }

  /** Polvo de la Tierra: nubes color tierra que suben y se abren sobre la loma. No hay fogonazo ni hoyo. */
  private drawDust(at: THREE.Vector3, radius: number, since: number): void {
    if (since >= DUST_MS) return;
    const q = Math.max(0, since) / DUST_MS;
    this.dustMat.opacity = 0.75 * (1 - q);
    this.dust.children.forEach((puff, k) => {
      const a = (k * Math.PI * 2) / (DUST_PUFFS - 1);
      const d = k === 0 ? 0 : radius * (0.4 + 0.3 * q);
      const x = at.x + Math.cos(a) * d;
      const z = at.z + Math.sin(a) * d;
      const size = radius * (k === 0 ? 0.3 : 0.2) * (0.6 + q);
      puff.position.set(x, this.aboveGround(x, -Infinity, z) + size * 0.5 + 3 * q, z);
      puff.scale.set(size, size * 0.75, size);
    });
    this.dust.visible = true;
  }

  /**
   * Un Racimo ya abierto: el destello en el punto de apertura y cada cabeza con su estela, su bola
   * mientras cae y su fogonazo cuando llega (cada una a su tiempo). `tick` son los pasos desde la
   * apertura. Deja en `at` el centro de las cabezas, que es lo que sigue la cámara.
   */
  private drawShotHeads(s: ShotModel, heads: NonNullable<ShotModel["heads"]>, tick: number, msPerTick: number, elapsed: number, at: THREE.Vector3): void {
    while (this.shotHeads.length < heads.length) {
      const line = new THREE.Line(new THREE.BufferGeometry(), this.shotLine.material);
      line.frustumCulled = false;
      const ball = new THREE.Mesh(this.shotBall.geometry, this.shotBall.material);
      ball.scale.setScalar(HEAD_SIZE);
      const blast = new THREE.Mesh(this.blast.geometry, (this.blast.material as THREE.Material).clone());
      this.scene.add(line, ball, blast);
      this.shotHeads.push({ line, ball, blast });
    }
    const openedAt = (s.path.length / 3 - 1) * msPerTick;
    if (elapsed - openedAt < OPEN_MS) {
      const q = Math.max(0, elapsed - openedAt) / OPEN_MS;
      this.openFlash.position.copy(at);
      this.openFlash.quaternion.copy(this.camera.quaternion);
      this.openFlash.scale.setScalar(1.6 + 3.4 * q);
      (this.openFlash.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - q);
      this.openFlash.visible = true;
    }
    const sum = new THREE.Vector3();
    const pos = new THREE.Vector3();
    heads.forEach((h, i) => {
      const v = this.shotHeads[i]!;
      const m = h.path.length / 3;
      if (m < 1) return;
      const k = Math.min(m - 1, Math.floor(tick));
      const geo = v.line.geometry as THREE.BufferGeometry;
      if (geo.userData.src !== h.path) {
        setPath(geo, h.path);
        geo.userData.src = h.path;
      }
      geo.setDrawRange(0, k + 1);
      v.line.visible = true;
      pos.fromArray(h.path, k * 3);
      sum.add(pos);
      if (k < m - 1) {
        v.ball.position.copy(pos);
        v.ball.visible = true;
        return;
      }
      const since = elapsed - (openedAt + (m - 1) * msPerTick);
      if (!h.lands || since >= EXPLOSION_MS) return;
      const q = Math.max(0, since) / EXPLOSION_MS;
      v.blast.position.copy(pos);
      v.blast.scale.setScalar(s.radius * (0.35 + 0.9 * q));
      (v.blast.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - q);
      v.blast.visible = true;
    });
    at.copy(sum.divideScalar(heads.length));
  }

  /**
   * Flecha del viento en el piso: apunta hacia donde sopla y mide lo que sopla. Va delante del tanque
   * del turno, del lado del centro del mapa (el mismo lugar en todas las pestañas), y sigue el
   * relieve para que una ladera no la tape. El viento cambia al empezar el turno: ahí se rearma.
   */
  private drawWind(wind: { x: number; z: number }, anchor: TankModel | undefined): void {
    const t = this.terrain;
    const speed = Math.hypot(wind.x, wind.z);
    this.windArrow.visible = !!anchor && !!t && speed >= 0.05;
    if (!anchor || !t || speed < 0.05) return;
    const key = `${wind.x}|${wind.z}|${anchor.x}|${anchor.z}|${this.terrainRev}`;
    if (key === this.windKey) return;
    this.windKey = key;
    const ux = wind.x / speed;
    const uz = wind.z / speed;
    const len = Math.max(WIND_ARROW_MIN, speed * WIND_ARROW_LEN);
    const head = Math.min(4.5, len / 2);
    const shaft = len - head;
    let nx = (t.width - 1) / 2 - anchor.x;
    let nz = (t.depth - 1) / 2 - anchor.z;
    const off = Math.hypot(nx, nz);
    if (off < 1e-3) nx = 1;
    else {
      nx /= off;
      nz /= off;
    }
    const cx = anchor.x + nx * WIND_ARROW_AWAY - ux * (len / 2);
    const cz = anchor.z + nz * WIND_ARROW_AWAY - uz * (len / 2);
    // Cortes a lo largo, uno por wu: [distancia desde la cola, medio ancho]. El asta y después la punta.
    const cuts: [number, number][] = [];
    const n = Math.max(1, Math.ceil(shaft));
    for (let i = 0; i <= n; i++) cuts.push([(shaft * i) / n, head * 0.22]);
    const m = Math.max(1, Math.ceil(head));
    for (let i = 0; i <= m; i++) cuts.push([shaft + (head * i) / m, head * 0.6 * (1 - i / m)]);
    // La malla es siempre la misma tira: los vértices se mueven de lugar y se dibuja hasta donde llega.
    const geo = this.windArrow.geometry;
    const pos = reservePoints(geo, cuts.length * 3);
    const tris = (cuts.length - 1) * 12;
    if ((geo.getIndex()?.count ?? 0) < tris) {
      // El índice de la tira no depende del viento: se arma una vez, para todo el lugar que hay.
      const index: number[] = [];
      for (let a = 0; a + 5 < pos.count; a += 3) index.push(a, a + 1, a + 4, a, a + 4, a + 3, a + 1, a + 2, a + 5, a + 1, a + 5, a + 4);
      geo.setIndex(index);
    }
    let v = 0;
    for (const [d, half] of cuts) {
      for (const side of [-1, 0, 1]) {
        const x = cx + ux * d - uz * half * side;
        const z = cz + uz * d + ux * half * side;
        pos.setXYZ(v++, x, terrainHeightAt(t, x, z) + 0.5, z);
      }
    }
    geo.setDrawRange(0, tris);
  }

  private drawMove(m: MoveModel | null): void {
    if (!m || !this.terrain) {
      this.moveRing.visible = false;
      this.moveMarker.visible = false;
      return;
    }
    // El anillo flota a la altura del tanque; con depthTest apagado se ve aunque lo tape el cerro.
    this.moveRing.position.set(m.center.x, terrainHeightAt(this.terrain, m.center.x, m.center.z) + 0.4, m.center.z);
    this.moveRing.scale.setScalar(m.range);
    this.moveRing.visible = true;
    if (m.hover) {
      this.moveMarker.position.set(m.hover.x, m.hover.y + 0.3, m.hover.z);
      (this.moveMarker.material as THREE.MeshBasicMaterial).color.set(m.hover.ok ? "#69db7c" : "#ff6b6b");
      this.moveMarker.visible = true;
    } else {
      this.moveMarker.visible = false;
    }
  }

  // -------------------------------------------------------------------------

  private last = performance.now();

  render(f: FrameModel): void {
    const dt = Math.min(0.1, (f.now - this.last) / 1000);
    this.last = f.now;
    this.syncTanks(f.tanks, f.now);
    this.drawMarks(f.marks);
    this.drawGhost(f.ghost, f.now);
    const ball = this.drawShot(f.shot, f.now);
    const turn = f.tanks.find((t) => t.isTurn);
    this.drawWind(f.wind, turn);
    this.drawFires(f.fires, f.now);
    this.drawMove(f.move);
    const drowning = this.drawSplashes(f.now);

    // Cámara: sigue al proyectil, se queda un momento en el impacto (para ver el cráter) y
    // después vuelve al tanque del turno. El turno nuevo llega antes de que termine ese momento:
    // el giro para ponerse detrás del que juega espera, así el hoyo se mira con la cámara quieta.
    // Si el tiro levantó una loma, el punto de impacto quedó bajo tierra: se mira el piso nuevo.
    // Mientras alguien se ahoga, la cámara mira el chapuzón.
    const onImpact = !!ball && !!f.shot && f.now - f.shot.start < f.shot.durationMs + LINGER_MS;
    if (drowning) this.focus(drowning.x, drowning.y + 2, drowning.z);
    else if (ball && onImpact) this.focus(ball.x, this.aboveGround(ball.x, ball.y, ball.z) + 2, ball.z);
    else if (turn) this.focus(turn.x, turn.y + 3, turn.z);
    this.updateCamera(dt, onImpact || !!drowning);

    this.syncRivalMarkers(f.tanks);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

const SCORCH = new THREE.Color("#1c1410");
const FIRE = new THREE.Color("#ff5a14");
const land: RGB = [0, 0, 0];
/**
 * Color de una celda: el del paisaje (altura y pendiente, ver landscape.ts) y encima el quemado
 * de los cráteres y, arriba de todo, la mancha de un fuego de Napalm. La luz la pone el sol.
 */
function terrainColor(t: Terrain, x: number, z: number, scorch: number, heat: number, out: THREE.Color): void {
  out.setRGB(...landColor(t, x, z, land), THREE.SRGBColorSpace);
  if (scorch > 0) out.lerp(SCORCH, 0.35 + 0.55 * scorch);
  if (heat > 0) out.lerp(FIRE, heat);
}
