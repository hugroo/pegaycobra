// SPDX-License-Identifier: GPL-2.0-or-later
// Códigos de sala: 4 letras mayúsculas, sin O ni I (y sin dígitos, así no hay 0 ni 1).

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Pasa a mayúsculas y saca espacios; no corrige O→0 ni nada parecido. */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase();
}

/** Genera un código que no esté en `taken`. */
export function generateCode(taken: ReadonlySet<string>, rng: () => number = Math.random): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
  throw new Error("no quedan códigos de sala libres");
}
