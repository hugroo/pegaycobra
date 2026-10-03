// SPDX-License-Identifier: GPL-2.0-or-later
// Mundo 3D con Three.js. Solo dibuja: el terreno llega del server (mensajes "terrain"), los
// tanques y la vida del estado, la trayectoria real del mensaje "shot". La fantasma la calcula
// main.ts con el sim y acá solo se dibuja.
//
// Ejes: los mismos del sim. x y z son el piso, y es la altura; 1 unidad de Three = 1 wu.
// yaw 0 = +X, 90 = +Z. En Three, rotar +θ alrededor de Y lleva +X hacia -Z, por eso rotation.y = -yaw.

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { TANK_RADIUS, terrainHeightAt, type Terrain } from "@pegaycobra/sim";

export const SLOT_COLORS = ["#ff6b6b", "#4dabf7", "#69db7c", "#f783ac"];

/** Los tanques se dibujan más grandes que su esfera de colisión (2 wu) para que se vean. */
const TANK_SCALE = 1.6;
/** Pivote del cañón en coordenadas locales del tanque (antes de escalar). [wu] */
const PIVOT_Y = 1.05;
const BARREL_LEN = 2.6;
const EXPLOSION_MS = 450;
/** Cuánto se queda la cámara mirando el impacto después de que llega el proyectil. [ms] */
export const LINGER_MS = 1300;

export interface TankModel {
  id: string;
  name: string;
  slot: number;
  x: number;
  y: number;
  z: number;
  life: number;
  yaw: number;
  pitch: number;
  isTurn: boolean;
  isMe: boolean;
}

export interface GhostModel {
  /** [x, y, z, ...] del sim. */
  path: number[];
  impact: { x: number; y: number; z: number } | null;
  shooter: TankModel;
  /** Radio de explosión del arma elegida. [wu] */
  radius: number;
}

export interface ShotModel {
  path: number[];
  start: number;
  durationMs: number;
  explodes: boolean;
  slot: number;
  /** Radio de explosión del arma disparada. [wu] */
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
  move: MoveModel | null;
  now: number;
}

interface TankView {
  root: THREE.Group;
  yawG: THREE.Group;
  pitchG: THREE.Group;
  bodyMat: THREE.MeshLambertMaterial;
  label: CSS2DObject;
  labelEl: HTMLDivElement;
  nameEl: HTMLSpanElement;
  barEl: HTMLElement;
  marker: THREE.Mesh;
  slot: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
  private terrain: Terrain | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  /** 0..1 por celda: cuánto quemó un cráter (solo visual). */
  private scorch = new Float32Array(0);
  private readonly tanks = new Map<string, TankView>();

  private readonly ghostLine: THREE.Line;
  private readonly ghostRing: THREE.Mesh;
  private readonly moveRing: THREE.Mesh;
  private readonly moveMarker: THREE.Mesh;
  private readonly shotLine: THREE.Line;
  private readonly shotBall: THREE.Mesh;
  private readonly blast: THREE.Mesh;
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

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color("#0f1c2e");
    this.scene.fog = new THREE.Fog("#0f1c2e", 260, 700);
    this.scene.add(new THREE.HemisphereLight("#cfe3ff", "#3b3020", 1.1));
    const sun = new THREE.DirectionalLight("#fff3dd", 1.6);
    sun.position.set(180, 260, 60);
    this.scene.add(sun);

    // Piso de fondo para que el mapa no flote en el vacío.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: "#1a2433" }),
    );
    floor.position.set(128, -0.3, 128);
    this.scene.add(floor);

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
      new THREE.MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.9 }),
    );
    this.scene.add(this.blast);

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
   * Crea o actualiza el mesh. `rect` limita qué vértices se recalculan (parche de cráter).
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
        pos.setY(i, now);
        terrainColor(now, this.scorch[i] ?? 0, c);
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
    const positions = new Float32Array(w * d * 3);
    const colors = new Float32Array(w * d * 3);
    const c = new THREE.Color();
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const i = x + z * w;
        positions[i * 3] = x;
        positions[i * 3 + 1] = heights[i]!;
        positions[i * 3 + 2] = z;
        heightColor(heights[i]!, c);
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
    if (v) return v;
    const color = new THREE.Color(SLOT_COLORS[m.slot] ?? "#cccccc");
    const bodyMat = new THREE.MeshLambertMaterial({ color });
    const dark = new THREE.MeshLambertMaterial({ color: "#222833" });
    const root = new THREE.Group();
    const treads = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.6, 2.6), dark);
    treads.position.y = 0.3;
    const body = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 2.2), bodyMat);
    body.position.y = 0.95;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
    dome.position.y = PIVOT_Y + 0.25;
    const yawG = new THREE.Group();
    yawG.position.y = PIVOT_Y + 0.35;
    const pitchG = new THREE.Group();
    yawG.add(pitchG);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, BARREL_LEN, 10), bodyMat);
    barrel.rotation.z = -Math.PI / 2; // el cilindro nace en Y; lo acostamos sobre +X
    barrel.position.x = BARREL_LEN / 2;
    pitchG.add(barrel);
    root.add(treads, body, dome, yawG);
    root.scale.setScalar(TANK_SCALE);

    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.9, 1.6, 4).rotateX(Math.PI),
      new THREE.MeshBasicMaterial({ color }),
    );
    marker.position.y = 5.2;
    root.add(marker);

    const labelEl = document.createElement("div");
    labelEl.className = "tank-label";
    const nameEl = document.createElement("span");
    const bar = document.createElement("i");
    const barEl = document.createElement("b");
    barEl.style.background = SLOT_COLORS[m.slot] ?? "#ccc";
    bar.append(barEl);
    labelEl.append(nameEl, bar);
    const label = new CSS2DObject(labelEl);
    label.position.set(0, 3.6, 0);
    root.add(label);

    this.scene.add(root);
    v = { root, yawG, pitchG, bodyMat, label, labelEl, nameEl, barEl, marker, slot: m.slot };
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
      v.pitchG.rotation.z = rad(m.pitch);
      v.bodyMat.color.set(alive ? (SLOT_COLORS[m.slot] ?? "#ccc") : "#4b515c");
      v.yawG.visible = alive;
      v.marker.visible = alive && m.isTurn;
      v.marker.position.y = 5.2 + Math.sin(now / 220) * 0.25;
      v.marker.rotation.y = now / 600;
      v.nameEl.textContent = (alive ? m.name : `${m.name} ✕`) + (m.isMe ? " (vos)" : "");
      v.barEl.style.width = `${Math.max(0, Math.min(100, m.life))}%`;
      v.labelEl.classList.toggle("turn", m.isTurn && alive);
      v.labelEl.classList.toggle("dead", !alive);
    }
    for (const [id, v] of this.tanks) {
      if (!seen.has(id)) {
        this.scene.remove(v.root);
        v.labelEl.remove();
        this.tanks.delete(id);
      }
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
    if (!g || g.path.length < 6) {
      this.ghostLine.visible = false;
      this.ghostRing.visible = false;
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
  }

  /** Dibuja el tiro real. Devuelve la posición actual del proyectil (para la cámara) o null. */
  private drawShot(s: ShotModel | null, now: number): THREE.Vector3 | null {
    this.shotLine.visible = false;
    this.shotBall.visible = false;
    this.blast.visible = false;
    if (!s || s.path.length < 3) return null;
    const n = s.path.length / 3;
    const elapsed = now - s.start;
    const p = Math.min(1, elapsed / Math.max(1, s.durationMs));
    const last = Math.min(n - 1, Math.floor(p * (n - 1)));

    const geo = this.shotLine.geometry as THREE.BufferGeometry;
    if (!geo.getAttribute("position") || geo.userData.src !== s.path) {
      geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(s.path), 3));
      geo.userData.src = s.path;
    }
    geo.setDrawRange(0, last + 1);
    this.shotLine.visible = true;
    const at = new THREE.Vector3(s.path[last * 3]!, s.path[last * 3 + 1]!, s.path[last * 3 + 2]!);

    if (p < 1) {
      this.shotBall.position.copy(at);
      this.shotBall.visible = true;
    } else if (s.explodes && elapsed - s.durationMs < EXPLOSION_MS) {
      const q = (elapsed - s.durationMs) / EXPLOSION_MS;
      this.blast.position.copy(at);
      this.blast.scale.setScalar(s.radius * (0.35 + 0.9 * q));
      (this.blast.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - q);
      this.blast.visible = true;
    }
    return at;
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
    this.drawMove(f.move);

    // Cámara: sigue al proyectil, se queda un momento en el impacto (para ver el cráter) y
    // después vuelve al tanque del turno.
    if (ball && f.shot && f.now - f.shot.start < f.shot.durationMs + LINGER_MS) this.focus(ball.x, ball.y + 2, ball.z);
    else if (turn) this.focus(turn.x, turn.y + 3, turn.z);
    this.updateCamera(dt);

    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

/** Color por altura: pasto abajo, tierra en las laderas, roca y nieve arriba. */
function heightColor(h: number, out: THREE.Color): void {
  if (h < 1) out.set("#3c4a2a");
  else if (h < 22) out.setRGB(0.36 + h * 0.004, 0.5 - h * 0.002, 0.2);
  else if (h < 45) out.setRGB(0.48 - (h - 22) * 0.002, 0.42 - (h - 22) * 0.004, 0.26);
  else if (h < 60) out.setRGB(0.5, 0.48, 0.45);
  else out.setRGB(0.9, 0.92, 0.95);
}

const SCORCH = new THREE.Color("#1c1410");
function terrainColor(h: number, scorch: number, out: THREE.Color): void {
  heightColor(h, out);
  if (scorch > 0) out.lerp(SCORCH, 0.35 + 0.55 * scorch);
}
