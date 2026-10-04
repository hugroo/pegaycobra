// SPDX-License-Identifier: GPL-2.0-or-later
// Mundo 3D con Three.js. Solo dibuja: el terreno llega del server (mensajes "terrain"), los
// tanques, la vida y los fuegos del estado, la trayectoria real del mensaje "shot". La fantasma la
// calcula main.ts con el sim y acá solo se dibuja.
//
// Ejes: los mismos del sim. x y z son el piso, y es la altura; 1 unidad de Three = 1 wu.
// yaw 0 = +X, 90 = +Z. En Three, rotar +θ alrededor de Y lleva +X hacia -Z, por eso rotation.y = -yaw.

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { TANK_RADIUS, terrainHeightAt, type Terrain } from "@pegaycobra/sim";
import { LAKE, SKY, SUN_DIR, landColor, type RGB } from "./landscape";

export const SLOT_COLORS = ["#ff6b6b", "#4dabf7", "#69db7c", "#f783ac"];

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
/** Cuánto dura el polvo que levanta un Rebote donde pica. [ms] */
const BOUNCE_MS = 380;
/** Cuánto dura el cartel de daño en el punto de impacto. [ms] */
const IMPACT_LABEL_MS = 1000;
/** Cuánto se queda la cámara mirando el impacto después de que llega el proyectil. [ms] */
export const LINGER_MS = 1300;
/** Lo que dura un chapuzón: el de un tanque que se ahoga y el de un tiro que se hunde. [ms] */
const SPLASH_MS = 1000;
const SPLASH_SMALL_MS = 600;
/** Llamas que se dibujan sobre cada fuego de Napalm. */
const FLAMES_PER_FIRE = 11;
/** Color del fogonazo de una explosión, y el del polvo que levanta la Tierra. */
const BLAST = "#ffb347";
const DUST = "#a8845a";

/** Silueta del tanque, como la manda el server. Solo cambia el dibujo. */
export type Hull = "box" | "flat" | "tower";

export interface TankModel {
  id: string;
  name: string;
  slot: number;
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

export interface ShotModel {
  path: number[];
  start: number;
  /** Lo que dura el tiro entero: con un Racimo, hasta que cae la última cabeza. */
  durationMs: number;
  explodes: boolean;
  slot: number;
  /** Radio de explosión del arma disparada. [wu] */
  radius: number;
  /** Racimo que se abrió: `path` llega hasta la apertura y de ahí sigue cada cabeza. `lands`: explota donde termina. */
  heads?: { path: number[]; lands: boolean }[];
  /** Rebote que picó: el punto de `path` donde tocó el piso. Ahí levanta polvo y sigue. */
  bounce?: number;
  /** El tiro no explota, levanta polvo (Tierra): el fogonazo es color tierra. */
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
  slot: number;
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
  private readonly shotLine: THREE.Line;
  private readonly shotBall: THREE.Mesh;
  private readonly blast: THREE.Mesh;
  /** Racimo en vuelo: el destello de la apertura y, por cabeza, su estela, su bola y su fogonazo. */
  private readonly openFlash: THREE.Mesh;
  private readonly shotHeads: { line: THREE.Line; ball: THREE.Mesh; blast: THREE.Mesh }[] = [];
  /** Chapuzones en curso: dos anillos que se abren sobre el agua y un chorro que sube y cae. */
  private readonly splashes: { x: number; z: number; big: boolean; start: number; root: THREE.Group; rings: THREE.Mesh[]; spout: THREE.Mesh }[] = [];
  private readonly splashRingGeo = new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2);
  private readonly splashSpoutGeo = new THREE.ConeGeometry(0.5, 1, 10).translate(0, 0.5, 0); // base en y = 0
  /** Rebote en vuelo: el polvo donde pica. */
  private readonly bounceDust: THREE.Mesh;
  private readonly impactLabel: CSS2DObject;
  private readonly windArrow: THREE.Mesh;
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
    const sun = new THREE.DirectionalLight("#fff1d6", 2.3);
    sun.position.set(128 + SUN_DIR[0] * 320, SUN_DIR[1] * 320, 128 + SUN_DIR[2] * 320);
    sun.target.position.set(128, 0, 128);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
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
      new THREE.LineDashedMaterial({ color: "#ffffff", dashSize: 1.6, gapSize: 1.2, transparent: true, opacity: 0.6 }),
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
    goneEl.textContent = "se fue";
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
      new THREE.LineBasicMaterial({ color: "#fff4c2", transparent: true, opacity: 0.75 }),
    );
    this.shotLine.frustumCulled = false;
    this.scene.add(this.shotLine);
    this.shotBall = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), new THREE.MeshBasicMaterial({ color: "#fff4c2" }));
    this.scene.add(this.shotBall);
    this.blast = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: BLAST, transparent: true, opacity: 0.9 }),
    );
    this.scene.add(this.blast);
    this.openFlash = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: "#fff4c2", transparent: true, opacity: 0.8 }),
    );
    this.openFlash.visible = false;
    this.scene.add(this.openFlash);
    this.bounceDust = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: DUST, transparent: true, opacity: 0.8 }),
    );
    this.bounceDust.visible = false;
    this.scene.add(this.bounceDust);
    const impactEl = document.createElement("div");
    impactEl.className = "impact-label";
    this.impactLabel = new CSS2DObject(impactEl);
    this.impactLabel.visible = false;
    this.scene.add(this.impactLabel);

    // Flecha del viento, acostada en el piso. Apunta a +X antes de rotarla.
    const s = new THREE.Shape();
    s.moveTo(0, -0.6);
    s.lineTo(3, -0.6);
    s.lineTo(3, -1.4);
    s.lineTo(5, 0);
    s.lineTo(3, 1.4);
    s.lineTo(3, 0.6);
    s.lineTo(0, 0.6);
    s.closePath();
    this.windArrow = new THREE.Mesh(
      new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: "#9ad1ff", transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
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

  private updateCamera(dt: number): void {
    const k = 1 - Math.exp(-dt * 5);
    this.target.lerp(this.targetGoal, k);
    if (this.thetaGoal !== null) {
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
    if (v && v.hull === m.hull) return v;
    if (v) this.dropTank(m.id, v); // cambió de silueta: se arma de nuevo
    const color = new THREE.Color(SLOT_COLORS[m.slot] ?? "#cccccc");
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
    barEl.style.background = SLOT_COLORS[m.slot] ?? "#ccc";
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
    edgeEl.style.color = SLOT_COLORS[m.slot] ?? "#ccc";
    const edgeArrow = document.createElement("i");
    const edgeText = document.createElement("span");
    edgeEl.append(edgeArrow, edgeText);
    edgeEl.hidden = true;
    this.edgeLayer.appendChild(edgeEl);

    this.scene.add(root);
    v = { root, yawG, pitchG, deckG, bodyMat, label, labelEl, nameEl, shoreEl, distEl, barEl, edgeEl, edgeArrow, edgeText, marker, shield, slot: m.slot, hull: m.hull, markerY };
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
      v.bodyMat.color.set(alive ? (SLOT_COLORS[m.slot] ?? "#ccc") : "#4b515c");
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

  private drawGhost(g: GhostModel | null): void {
    this.drawGhostHeads(g);
    this.ghostBounce.visible = !!g?.bounce && g.path.length >= 6;
    if (g?.bounce) {
      this.ghostBounce.position.set(g.bounce.x, g.bounce.y + 0.15, g.bounce.z);
      (this.ghostBounce.material as THREE.MeshBasicMaterial).color.set(SLOT_COLORS[g.shooter.slot] ?? "#fff");
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
    const pts: THREE.Vector3[] = [tip];
    const n = g.path.length / 3;
    const tmp = new THREE.Vector3();
    let started = false;
    for (let i = 0; i < n; i += 2) {
      tmp.set(g.path[i * 3]!, g.path[i * 3 + 1]!, g.path[i * 3 + 2]!);
      if (!started && tmp.clone().sub(base).dot(dir) < reach) continue;
      started = true;
      pts.push(tmp.clone());
    }
    pts.push(new THREE.Vector3(g.path[(n - 1) * 3]!, g.path[(n - 1) * 3 + 1]!, g.path[(n - 1) * 3 + 2]!));
    this.ghostLine.geometry.dispose();
    this.ghostLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.ghostLine.computeLineDistances();
    this.ghostLine.visible = true;

    if (g.impact) {
      this.ghostRing.position.set(g.impact.x, g.impact.y + 0.15, g.impact.z);
      this.ghostRing.scale.setScalar(g.radius);
      (this.ghostRing.material as THREE.MeshBasicMaterial).color.set(SLOT_COLORS[g.shooter.slot] ?? "#fff");
      this.ghostRing.visible = true;
    } else {
      this.ghostRing.visible = false;
    }
    // Sin impacto en el mapa, la línea termina en un cartel "se fue".
    // El final suele quedar fuera de cuadro, así que el cartel va en el último punto que se ve.
    this.ghostGone.visible = false;
    if (!g.gone) return;
    const goneText = g.sunk ? "al agua" : "se fue";
    if (this.ghostGone.element.textContent !== goneText) this.ghostGone.element.textContent = goneText;
    const ndc = new THREE.Vector3();
    for (let i = pts.length - 1; i >= 0; i--) {
      ndc.copy(pts[i]!).project(this.camera);
      if (Math.abs(ndc.x) > 0.88 || Math.abs(ndc.y) > 0.88 || ndc.z > 1) continue;
      this.ghostGone.position.copy(pts[i]!);
      this.ghostGone.visible = true;
      break;
    }
  }

  /**
   * La apertura de un Racimo en la fantasma: una marca donde se abre y, de ahí, una línea punteada
   * por cabeza con su anillo donde caería. Sin cabezas (cualquier otra arma, o un Racimo que no
   * llega a abrirse) no dibuja nada.
   */
  private drawGhostHeads(g: GhostModel | null): void {
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
      (this.ghostOpen.material as THREE.MeshBasicMaterial).color.set(SLOT_COLORS[g.shooter.slot] ?? "#fff");
    }
    this.ghostHeads.forEach((v, i) => {
      const h = heads[i];
      v.line.visible = !!h && h.path.length >= 6;
      v.ring.visible = !!h?.impact;
      if (!g || !h) return;
      if (v.line.visible) {
        const n = h.path.length / 3;
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k < n; k += 2) pts.push(new THREE.Vector3().fromArray(h.path, k * 3));
        pts.push(new THREE.Vector3().fromArray(h.path, (n - 1) * 3));
        v.line.geometry.dispose();
        v.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        v.line.computeLineDistances();
      }
      if (h.impact) {
        v.ring.position.set(h.impact.x, h.impact.y + 0.15, h.impact.z);
        v.ring.scale.setScalar(g.radius);
        (v.ring.material as THREE.MeshBasicMaterial).color.set(SLOT_COLORS[g.shooter.slot] ?? "#fff");
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
    this.shotBall.visible = false;
    this.blast.visible = false;
    this.impactLabel.visible = false;
    this.openFlash.visible = false;
    this.bounceDust.visible = false;
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
    if (!geo.getAttribute("position") || geo.userData.src !== s.path) {
      geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(s.path), 3));
      geo.userData.src = s.path;
    }
    geo.setDrawRange(0, last + 1);
    this.shotLine.visible = true;
    const at = new THREE.Vector3(s.path[last * 3]!, s.path[last * 3 + 1]!, s.path[last * 3 + 2]!);

    if (heads.length > 0) {
      if (last < n - 1) {
        this.shotBall.position.copy(at);
        this.shotBall.visible = true;
      } else {
        this.drawShotHeads(s, heads, p * total - (n - 1), s.durationMs / Math.max(1, total), elapsed, at);
      }
    } else if (p < 1) {
      this.shotBall.position.copy(at);
      this.shotBall.visible = true;
    } else if (s.explodes && elapsed - s.durationMs < EXPLOSION_MS) {
      const q = (elapsed - s.durationMs) / EXPLOSION_MS;
      this.blast.position.copy(at);
      this.blast.scale.setScalar(s.radius * (0.35 + 0.9 * q));
      const mat = this.blast.material as THREE.MeshBasicMaterial;
      mat.color.set(s.dust ? DUST : BLAST);
      mat.opacity = 0.9 * (1 - q);
      this.blast.visible = true;
    }
    // Rebote: polvo donde picó, desde que la bola pasa por ahí.
    if (s.bounce !== undefined && s.bounce < n) {
      const since = elapsed - (s.bounce / Math.max(1, total)) * s.durationMs;
      if (since >= 0 && since < BOUNCE_MS) {
        const q = since / BOUNCE_MS;
        this.bounceDust.position.fromArray(s.path, s.bounce * 3);
        this.bounceDust.scale.set(1.4 + 3 * q, 0.6 + 1.2 * q, 1.4 + 3 * q);
        (this.bounceDust.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - q);
        this.bounceDust.visible = true;
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
   * Un Racimo ya abierto: el destello en el punto de apertura y cada cabeza con su estela, su bola
   * mientras cae y su fogonazo cuando llega (cada una a su tiempo). `tick` son los pasos desde la
   * apertura. Deja en `at` el centro de las cabezas, que es lo que sigue la cámara.
   */
  private drawShotHeads(s: ShotModel, heads: NonNullable<ShotModel["heads"]>, tick: number, msPerTick: number, elapsed: number, at: THREE.Vector3): void {
    while (this.shotHeads.length < heads.length) {
      const line = new THREE.Line(new THREE.BufferGeometry(), this.shotLine.material);
      line.frustumCulled = false;
      const ball = new THREE.Mesh(this.shotBall.geometry, this.shotBall.material);
      ball.scale.setScalar(0.6);
      const blast = new THREE.Mesh(this.blast.geometry, (this.blast.material as THREE.Material).clone());
      this.scene.add(line, ball, blast);
      this.shotHeads.push({ line, ball, blast });
    }
    const openedAt = (s.path.length / 3 - 1) * msPerTick;
    if (elapsed - openedAt < OPEN_MS) {
      const q = Math.max(0, elapsed - openedAt) / OPEN_MS;
      this.openFlash.position.copy(at);
      this.openFlash.scale.setScalar(0.8 + 2.4 * q);
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
        geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(h.path), 3));
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

  private drawWind(wind: { x: number; z: number }, anchor: TankModel | undefined): void {
    const speed = Math.hypot(wind.x, wind.z);
    if (!anchor || speed < 0.05 || !this.terrain) {
      this.windArrow.visible = false;
      return;
    }
    // Al costado del tanque del turno, apoyada en el piso.
    const side = Math.atan2(wind.z, wind.x) + Math.PI / 2;
    const len = 5 * (1.2 + speed * 0.5); // 9 wu con viento 1, 18 wu con viento 5
    const ax = anchor.x + Math.cos(side) * 10 - (wind.x / speed) * (len / 2);
    const az = anchor.z + Math.sin(side) * 10 - (wind.z / speed) * (len / 2);
    this.windArrow.scale.set(len / 5, 1, 1.6);
    this.windArrow.position.set(ax, terrainHeightAt(this.terrain, ax, az) + 0.6, az);
    this.windArrow.rotation.y = -Math.atan2(wind.z, wind.x);
    this.windArrow.visible = true;
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
    this.drawGhost(f.ghost);
    const ball = this.drawShot(f.shot, f.now);
    const turn = f.tanks.find((t) => t.isTurn);
    this.drawWind(f.wind, turn);
    this.drawFires(f.fires, f.now);
    this.drawMove(f.move);
    const drowning = this.drawSplashes(f.now);

    // Cámara: sigue al proyectil, se queda un momento en el impacto (para ver el cráter) y
    // después vuelve al tanque del turno.
    // Si el tiro levantó una loma, el punto de impacto quedó bajo tierra: se mira el piso nuevo.
    // Mientras alguien se ahoga, la cámara mira el chapuzón.
    if (drowning) this.focus(drowning.x, drowning.y + 2, drowning.z);
    else if (ball && f.shot && f.now - f.shot.start < f.shot.durationMs + LINGER_MS) this.focus(ball.x, this.aboveGround(ball.x, ball.y, ball.z) + 2, ball.z);
    else if (turn) this.focus(turn.x, turn.y + 3, turn.z);
    this.updateCamera(dt);

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
