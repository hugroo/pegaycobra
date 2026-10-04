// Integración: chat de sala. Lo que manda uno lo reciben los de su sala, en el mismo orden, y nadie más.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import type { Server } from "@colyseus/core";
import { createServer, ROOM_NAME } from "../src/server";
import { CHAT_MAX, chatText, type ChatBroadcast } from "../src/room";

const PORT = 27670 + Math.floor(Math.random() * 1000);
let server: Server;

beforeAll(async () => {
  server = await createServer(PORT);
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout esperando condición");
    await sleep(10);
  }
}

/** Todo lo que le llega por "chat" a un cliente, en el orden en que le llega. */
function inbox(room: Room<any>): ChatBroadcast[] {
  const got: ChatBroadcast[] = [];
  room.onMessage("chat", (m: ChatBroadcast) => got.push(m));
  return got;
}

describe("chat de sala", () => {
  it("dos clientes mandan, los dos reciben lo mismo en el mismo orden, y un tercero en otra sala no", async () => {
    const url = `ws://localhost:${PORT}`;
    const a: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Ana" });
    const b: Room<any> = await new Client(url).joinById(a.roomId, { name: "Beto" });
    const c: Room<any> = await new Client(url).create(ROOM_NAME, { name: "Caro" });
    expect(c.roomId).not.toBe(a.roomId);
    const [gotA, gotB, gotC] = [inbox(a), inbox(b), inbox(c)];
    await until(() => a.state.players?.size === 2 && b.state.players?.size === 2);

    a.send("chat", { text: "hola" });
    b.send("chat", { text: "  dale,\n<b>arrancá</b>  ", name: "Ana", slot: 0 });
    a.send("chat", { text: "x".repeat(CHAT_MAX + 50) });
    // Nada de esto sale: no es texto, o no queda nada que mostrar.
    a.send("chat", { text: "   \n\t " });
    a.send("chat", { text: 42 });
    a.send("chat", {});
    a.send("chat");
    a.send("chat", { text: "listo" });

    await until(() => gotA.length === 4 && gotB.length === 4);
    expect(gotA).toEqual(gotB); // el orden es el del server, igual para los dos

    // Los de Ana llegan en el orden en que los mandó; el de Beto, donde le haya tocado.
    const slotOf = (r: Room<any>) => a.state.players.get(r.sessionId).slot as number;
    expect(gotA.filter((m) => m.id === a.sessionId)).toEqual([
      { id: a.sessionId, name: "Ana", slot: slotOf(a), text: "hola" },
      { id: a.sessionId, name: "Ana", slot: slotOf(a), text: "x".repeat(CHAT_MAX) },
      { id: a.sessionId, name: "Ana", slot: slotOf(a), text: "listo" },
    ]);
    // El nombre y el color los pone el server, no el mensaje. El texto llega plano, en una línea.
    expect(gotA.filter((m) => m.id === b.sessionId)).toEqual([
      { id: b.sessionId, name: "Beto", slot: slotOf(b), text: "dale, <b>arrancá</b>" },
    ]);
    expect(slotOf(a)).not.toBe(slotOf(b));

    // Caro, en otra sala, manda y recibe lo suyo: lo de Ana y Beto no le llegó, ni lo de ella a ellos.
    c.send("chat", { text: "¿hay alguien?" });
    await until(() => gotC.length === 1);
    await sleep(100);
    expect(gotC.map((m) => m.text)).toEqual(["¿hay alguien?"]);
    expect(gotA.length).toBe(4);
    expect(gotB.length).toBe(4);

    await Promise.all([a.leave(), b.leave(), c.leave()]);
  });

  it("chatText: una línea de texto plano, corta", () => {
    // 0 = NUL, 0x202e = el que da vuelta la dirección del texto.
    expect(chatText({ text: ` hola ${String.fromCodePoint(0, 0x202e)} che ` })).toBe("hola che");
    expect(chatText({ text: "a\r\nb" })).toBe("a b");
    expect(chatText({ text: "😀".repeat(CHAT_MAX + 5) })).toBe("😀".repeat(CHAT_MAX)); // no parte un emoji
    expect(chatText({ text: "" })).toBeNull();
    expect(chatText({ text: ["hola"] })).toBeNull();
    expect(chatText(null)).toBeNull();
    expect(chatText("hola")).toBeNull();
  });
});
