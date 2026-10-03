// SPDX-License-Identifier: GPL-2.0-or-later
import { createServer } from "./server";

const port = Number(process.env.PORT ?? 2567);
await createServer(port);
console.log(`pegaycobra server escuchando en ws://localhost:${port}`);
