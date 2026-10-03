// SPDX-License-Identifier: GPL-2.0-or-later
// Sonido generado acá con un oscilador por nota: sin archivos. Cuatro eventos: disparo, explosión,
// impacto a un tanque e inicio de tu turno. El navegador no deja sonar nada hasta un gesto del
// usuario: el primer clic (o tecla) crea y habilita el AudioContext; lo anterior queda mudo.

export type Sfx = "fire" | "boom" | "hit" | "turn";

interface Note {
  type: OscillatorType;
  /** Frecuencia al empezar y al terminar la nota. [Hz] */
  from: number;
  to: number;
  /** Cuándo arranca, desde que se pide el sonido, y cuánto dura. [s] */
  at: number;
  dur: number;
  /** Volumen pico, 0..1. */
  gain: number;
}

const SOUNDS: Record<Sfx, Note[]> = {
  fire: [{ type: "square", from: 260, to: 70, at: 0, dur: 0.16, gain: 0.16 }],
  boom: [{ type: "sawtooth", from: 120, to: 28, at: 0, dur: 0.55, gain: 0.3 }],
  hit: [{ type: "square", from: 900, to: 320, at: 0.06, dur: 0.14, gain: 0.14 }],
  turn: [
    { type: "sine", from: 660, to: 660, at: 0, dur: 0.11, gain: 0.18 },
    { type: "sine", from: 880, to: 880, at: 0.13, dur: 0.16, gain: 0.18 },
  ],
};

const MUTE_KEY = "pyc:mute";
let ctx: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === "1";
} catch {
  /* sin storage */
}

function unlock(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* sin Web Audio */
  }
}
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);

/** Corta o devuelve el sonido y lo recuerda. Devuelve si quedó cortado. */
export function toggleMute(): boolean {
  muted = !muted;
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* ignorado */
  }
  return muted;
}

export function play(sfx: Sfx): void {
  if (muted || !ctx || ctx.state !== "running") return;
  for (const n of SOUNDS[sfx]) {
    const t0 = ctx.currentTime + n.at;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = n.type;
    osc.frequency.setValueAtTime(n.from, t0);
    osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.dur);
    amp.gain.setValueAtTime(n.gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.001, t0 + n.dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + n.dur);
  }
}
