// SPDX-License-Identifier: GPL-2.0-or-later
// Minimapa: vista cenital fija (x a la derecha, z hacia abajo) en un canvas 2D. Solo dibuja lo
// que le pasa main.ts: el terreno en grises, los tanques, el viento, dónde cae la fantasma y
// dónde cayó el último tiro real (el del mensaje "shot", igual en todas las pestañas).

import type { Terrain } from "@pegaycobra/sim";
import { SLOT_COLORS } from "./scene3d";

export interface MiniTank {
  x: number;
  z: number;
  slot: number;
  alive: boolean;
  isMe: boolean;
}

export interface MiniModel {
  terrain: Terrain;
  /** Cambia cuando cambia el terreno: recién ahí se repinta la base en grises. */
  terrainVersion: number;
  tanks: MiniTank[];
  wind: { x: number; z: number };
  /** Fantasma de mi turno: recorrido [x, y, z, ...] y si termina dentro del mapa. */
  ghost: { path: number[]; lands: boolean; slot: number } | null;
  /** Proyectil real en vuelo. */
  ball: { x: number; z: number } | null;
  /** Último tiro real, ya terminado. `lands` false = se fue del mapa. */
  impact: { x: number; z: number; lands: boolean; slot: number } | null;
}

const WIND_COLOR = "#9ad1ff";

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = document.createElement("canvas");
  private baseVersion = -1;
  private size = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Altura → gris: valle oscuro, cima clara. Una celda del terreno = un píxel de la base. */
  private paintBase(t: Terrain): void {
    this.base.width = t.width;
    this.base.height = t.depth;
    const ctx = this.base.getContext("2d")!;
    const img = ctx.createImageData(t.width, t.depth);
    let max = 1;
    for (const h of t.heights) if (h > max) max = h;
    for (let i = 0; i < t.heights.length; i++) {
      const g = 28 + (Math.max(0, t.heights[i]!) / max) * 210;
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
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

    // Último tiro real: estrella amarilla donde explotó, o cruz en el borde por donde se fue.
    if (m.impact) {
      const [x, y] = at(m.impact.x, m.impact.z);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffcf5a";
      ctx.fillStyle = "#ffcf5a";
      if (m.impact.lands) {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          const r = i % 2 ? 3 : 7.5;
          ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#1a1305";
        ctx.stroke();
      } else cross(x, y, 5);
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
      ctx.stroke();
      ctx.setLineDash([]);
      const color = SLOT_COLORS[m.ghost.slot] ?? "#fff";
      if (m.ghost.lands) {
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
      ctx.fillStyle = SLOT_COLORS[t.slot] ?? "#ccc";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (m.ball) {
      const [x, y] = at(m.ball.x, m.ball.z);
      ctx.fillStyle = "#fff4c2";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Viento: flecha en la esquina de abajo a la izquierda, con los mismos ejes que el mapa.
    const speed = Math.hypot(m.wind.x, m.wind.z);
    const cx = 20;
    const cy = S - 20;
    ctx.fillStyle = "rgba(15, 20, 30, 0.78)";
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = WIND_COLOR;
    ctx.strokeStyle = WIND_COLOR;
    if (speed < 0.05) {
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const ux = m.wind.x / speed;
      const uz = m.wind.z / speed;
      const len = 5 + speed * 1.8; // media flecha: 7 px con viento 1, 14 px con viento 5
      const hx = cx + ux * len;
      const hy = cy + uz * len;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - ux * len, cy - uz * len);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx + ux * 3, hy + uz * 3);
      ctx.lineTo(hx - ux * 4 - uz * 4, hy - uz * 4 + ux * 4);
      ctx.lineTo(hx - ux * 4 + uz * 4, hy - uz * 4 - ux * 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const label = speed < 0.05 ? "calma" : speed.toFixed(1);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000";
    ctx.strokeText(label, cx + 20, cy);
    ctx.fillStyle = WIND_COLOR;
    ctx.fillText(label, cx + 20, cy);
  }
}
