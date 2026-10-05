// SPDX-License-Identifier: GPL-2.0-or-later
// Minimapa: vista cenital fija (x a la derecha, z hacia abajo) en un canvas 2D. Solo dibuja lo
// que le pasa main.ts: el terreno con la misma escala de color que la vista 3D, los fuegos de Napalm, los tanques, dónde cae
// la fantasma, hasta dónde llega el arma elegida, dónde cayó el último tiro real (el del mensaje
// "shot", igual en todas las pestañas), la marca del último tiro de cada tanque (la del estado) y,
// en la tienda, dónde nace cada uno en la ronda que viene.

import type { Terrain } from "@pegaycobra/sim";
import { hillshade, LAKE, landColor, type RGB } from "./landscape";
import { TANK_COLORS, type MarkModel, type SpawnModel } from "./scene3d";

export interface MiniTank {
  x: number;
  z: number;
  color: number;
  alive: boolean;
  isMe: boolean;
  /** En piso bajo, a un hoyo del lago: lleva la marca de orilla. */
  shore: boolean;
}

export interface MiniModel {
  terrain: Terrain;
  /** Cambia cuando cambia el terreno: recién ahí se repinta la base. */
  terrainVersion: number;
  tanks: MiniTank[];
  /** Fuegos de Napalm prendidos en la ronda: discos en el piso. [wu] */
  fires: { x: number; z: number; radius: number }[];
  /**
   * Fantasma de mi turno: recorrido [x, y, z, ...] y si termina dentro del mapa. Con un Racimo,
   * `path` llega hasta donde se abre y `heads` trae el recorrido de cada cabeza. Con un Rebote,
   * `path` trae los dos tramos y `bounce` es donde pica.
   */
  ghost: { path: number[]; lands: boolean; color: number; heads?: { path: number[]; lands: boolean }[]; bounce?: { x: number; z: number } } | null;
  /**
   * En mi turno: hasta dónde llega el arma elegida, como un aro alrededor de mi tanque. El radio es
   * el alcance del arma (WEAPONS[...].reach): piso llano, sin viento. Lo que queda afuera del aro no
   * lo alcanza ese tiro; con un arma que llega más que el mapa, el aro no se ve. [wu]
   */
  reach: { x: number; z: number; radius: number; color: number } | null;
  /** Proyectil real en vuelo: uno, o las cabezas de un Racimo ya abierto. */
  balls: { x: number; z: number }[];
  /**
   * Último tiro real, ya terminado: dónde explotó (un Racimo, una marca por cabeza, más chicas).
   * `lands` false = se fue del mapa. Una Tierra no deja marca: la loma ya está en el terreno.
   */
  impacts: { x: number; z: number; lands: boolean }[];
  /** Marca del último tiro de cada tanque: el recorrido, fino y quieto, y un punto donde cayó. */
  marks: MarkModel[];
  /**
   * Tienda: dónde nace cada uno en la ronda que viene, un rombo de su color (lleno si lo eligió).
   * Alrededor del de cada rival, el aro de `gap` celdas adentro del cual no puedo nacer. [wu]
   */
  spawns: SpawnModel[];
  gap: number;
}

/** El punto de un tanque mide 4 px: el fuego se dibuja al menos así de grande, para que asome por debajo. [px] */
const FIRE_MIN_PX = 6.5;
/** Marca de orilla: el color del lago, el mismo del terreno. */
const SHORE_COLOR = `rgb(${LAKE.map((c) => Math.round(c * 255)).join(", ")})`;

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = document.createElement("canvas");
  private baseVersion = -1;
  private size = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Mismo color por altura que la vista 3D, con el sol marcando la pendiente. Una celda = un píxel. */
  private paintBase(t: Terrain): void {
    this.base.width = t.width;
    this.base.height = t.depth;
    const ctx = this.base.getContext("2d")!;
    const img = ctx.createImageData(t.width, t.depth);
    const c: RGB = [0, 0, 0];
    for (let z = 0; z < t.depth; z++) {
      for (let x = 0; x < t.width; x++) {
        const i = x + z * t.width;
        landColor(t, x, z, c);
        const light = 255 * hillshade(t, x, z);
        img.data[i * 4] = c[0] * light;
        img.data[i * 4 + 1] = c[1] * light;
        img.data[i * 4 + 2] = c[2] * light;
        img.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  draw(m: MiniModel): void {
    const css = this.canvas.clientWidth;
    if (css <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.size !== Math.round(css * dpr)) {
      this.size = Math.round(css * dpr);
      this.canvas.width = this.size;
      this.canvas.height = this.size;
    }
    if (this.baseVersion !== m.terrainVersion) {
      this.baseVersion = m.terrainVersion;
      this.paintBase(m.terrain);
    }
    const ctx = this.ctx;
    const S = css;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.base, 0, 0, S, S);

    const kx = S / (m.terrain.width - 1);
    const kz = S / (m.terrain.depth - 1);
    /** Mundo → canvas, sin salirse del borde (un punto fuera del mapa se dibuja pegado al borde). */
    const at = (x: number, z: number): [number, number] => [
      Math.min(S - 4, Math.max(4, x * kx)),
      Math.min(S - 4, Math.max(4, z * kz)),
    ];
    const cross = (x: number, y: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.stroke();
    };

    // Fuego: disco naranja a escala del mapa, debajo de todo lo demás.
    for (const f of m.fires) {
      const [x, y] = at(f.x, f.z);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(FIRE_MIN_PX, f.radius * kx), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 98, 20, 0.85)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#ffd43b";
      ctx.stroke();
    }

    // Último tiro real: estrella amarilla donde explotó, o cruz en el borde por donde se fue.
    const star = m.impacts.length > 1 ? 0.5 : 1;
    for (const impact of m.impacts) {
      const [x, y] = at(impact.x, impact.z);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffcf5a";
      ctx.fillStyle = "#ffcf5a";
      if (impact.lands) {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          const r = (i % 2 ? 3 : 7.5) * star;
          ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#1a1305";
        ctx.stroke();
      } else cross(x, y, 5 * star);
    }

    // Marca del último tiro de cada tanque: línea continua y pálida de su color, y un punto donde
    // cayó (un aro si fue al agua). Va debajo de la fantasma, que es la punteada.
    for (const mark of m.marks) {
      const color = TANK_COLORS[mark.color] ?? "#fff";
      const p = mark.path;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i + 2 < p.length; i += 3) ctx.lineTo(...at(p[i]!, p[i + 2]!));
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const s of mark.spots) {
        const [x, y] = at(s.x, s.z);
        ctx.beginPath();
        ctx.arc(x, y, s.wet ? 3 : 2.5, 0, Math.PI * 2);
        if (s.wet) {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = color;
        } else {
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "#000";
        }
        ctx.stroke();
      }
    }

    // Alcance del arma elegida: aro del color del tanque, a escala del mapa. Va debajo de la
    // fantasma, que es la que dice dónde cae este tiro.
    if (m.reach) {
      ctx.beginPath();
      ctx.arc(m.reach.x * kx, m.reach.z * kz, m.reach.radius * kx, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = TANK_COLORS[m.reach.color] ?? "#fff";
      ctx.stroke();
    }

    // Fantasma: recorrido punteado y, al final, el punto de caída (o "se fue" en el borde).
    if (m.ghost && m.ghost.path.length >= 6) {
      const p = m.ghost.path;
      const n = p.length / 3;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (let i = 0; i < n; i += 4) ctx.lineTo(...at(p[i * 3]!, p[i * 3 + 2]!));
      const [ex, ey] = at(p[(n - 1) * 3]!, p[(n - 1) * 3 + 2]!);
      ctx.lineTo(ex, ey);
      // Racimo: desde donde se abre, un trazo por cabeza.
      const heads = m.ghost.heads ?? [];
      for (const h of heads) {
        ctx.moveTo(ex, ey);
        for (let i = 4; i < h.path.length / 3; i += 4) ctx.lineTo(...at(h.path[i * 3]!, h.path[i * 3 + 2]!));
        ctx.lineTo(...at(h.path[h.path.length - 3]!, h.path[h.path.length - 1]!));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const color = TANK_COLORS[m.ghost.color] ?? "#fff";
      // Rebote: un punto chico donde pica; el círculo de caída va al final, en el segundo golpe.
      if (m.ghost.bounce) {
        const [bx, by] = at(m.ghost.bounce.x, m.ghost.bounce.z);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(bx, by, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (heads.length > 0) {
        // Un punto donde cae cada cabeza (o una cruz chica en el borde por donde se va).
        for (const h of heads) {
          const [hx, hy] = at(h.path[h.path.length - 3]!, h.path[h.path.length - 1]!);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = color;
          if (!h.lands) {
            cross(hx, hy, 2.5);
            continue;
          }
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(hx, hy, 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (m.ghost.lands) {
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = "#000";
        ctx.beginPath();
        ctx.arc(ex, ey, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(ex, ey, 1.6, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        cross(ex, ey, 4);
        ctx.font = "600 10px system-ui, sans-serif";
        ctx.textAlign = ex > S / 2 ? "right" : "left";
        ctx.textBaseline = ey > S / 2 ? "bottom" : "top";
        const tx = ex + (ex > S / 2 ? -7 : 7);
        const ty = ey + (ey > S / 2 ? -5 : 5);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000";
        ctx.strokeText("se fue", tx, ty);
        ctx.fillStyle = "#fff";
        ctx.fillText("se fue", tx, ty);
      }
    }

    for (const t of m.tanks) {
      const [x, y] = at(t.x, t.z);
      if (!t.alive) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#7c8494";
        cross(x, y, 3);
        continue;
      }
      if (t.isMe) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = TANK_COLORS[t.color] ?? "#ccc";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Orilla: una olita debajo del punto. Aviso y nada más.
      if (t.shore) {
        const wave = () => {
          ctx.beginPath();
          ctx.moveTo(x - 6, y + 8);
          ctx.quadraticCurveTo(x - 3, y + 5, x, y + 8);
          ctx.quadraticCurveTo(x + 3, y + 11, x + 6, y + 8);
          ctx.stroke();
        };
        ctx.lineCap = "round";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#000";
        wave();
        ctx.lineWidth = 2;
        ctx.strokeStyle = SHORE_COLOR;
        wave();
        ctx.lineCap = "butt";
      }
    }

    // Nacimientos de la ronda que viene: arriba de los tanques, que en la tienda ya no dicen dónde se juega.
    for (const s of m.spawns) {
      const color = TANK_COLORS[s.color] ?? "#fff";
      const [x, y] = at(s.x, s.z);
      if (!s.isMe) {
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(s.x * kx, s.z * kz, m.gap * kx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = s.isMe ? 6.5 : 5;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = s.picked ? color : "rgba(0, 0, 0, 0.55)";
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = s.isMe ? "#fff" : "#000";
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    for (const ball of m.balls) {
      const [x, y] = at(ball.x, ball.z);
      ctx.fillStyle = "#fff4c2";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
