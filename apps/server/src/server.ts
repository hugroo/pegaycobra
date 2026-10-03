// SPDX-License-Identifier: GPL-2.0-or-later
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import { GameRoom } from "./room";

export const ROOM_NAME = "pegaycobra";

/** Carpeta del cliente compilado (`pnpm build`). Si existe, el server también sirve la web. */
const CLIENT_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../client/dist");

export async function createServer(port: number): Promise<Server> {
  const server = new Server({
    transport: new WebSocketTransport(),
    greet: false,
    express: (app) => {
      app.get("/health", (_req, res) => {
        res.json({ ok: true });
      });
      // En producción hay un solo servicio: la web y el WebSocket salen del mismo dominio.
      // En desarrollo no hay dist y la web la sirve Vite en el puerto 5173.
      if (existsSync(CLIENT_DIST)) app.use(express.static(CLIENT_DIST));
    },
  });
  server.define(ROOM_NAME, GameRoom);
  await server.listen(port);
  return server;
}
