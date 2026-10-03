# pegaycobra

Revival web de Scorched 3D: artillería por turnos, terreno destructible y tienda entre rondas.
No es un port. El loop se escribe de nuevo y las reglas (física, cráter, daño, plata) se toman
del original.

Estado: **jugable en 3D en el navegador, multijugador de 2 a 4, partida de 5 rondas con tienda.**
Dos armas (Baby Missile infinita y Missile comprado), paracaídas y nafta.

```
packages/sim   TypeScript puro: terreno width × depth, tiro con yaw/pitch, cráter en disco, daño,
               plata, rondas, tienda, nafta y puntaje. Sin DOM, sin Node.
               (El modo perfil de una fila sigue ahí, con sus tests.)
apps/server    Node + TS + Colyseus. Corre packages/sim y es la autoridad.
apps/client    Vite + TS + Three.js. HTML/CSS para lobby y HUD.
```

## Instalar

Requiere Node ≥ 20 y pnpm 9.

```bash
corepack enable
pnpm install
```

`corepack enable` deja `pnpm` en el PATH. En Windows puede pedir una consola de administrador.
Si no podés, `corepack pnpm install` funciona igual, pero `pnpm dev` y `pnpm test` llaman a
`pnpm` por dentro y van a fallar con "pnpm no se reconoce".

## Jugar

```bash
pnpm dev
```

Levanta los dos procesos juntos:

| Qué | Dónde |
|---|---|
| Cliente (Vite) | <http://localhost:5173> |
| Server (Colyseus, WebSocket) | `ws://localhost:2567` |

**Hacen falta al menos dos navegadores** (o dos pestañas, o una ventana normal y una de
incógnito). En uno: escribí tu nombre y tocá *Crear sala*. Te da un código de 4 letras. En el
otro: escribí el código y tocá *Entrar*. Cuando hay 2 o más, el anfitrión (el que creó la sala)
toca *Arrancar*.

Controles (una sola barra abajo):

| Qué | Cómo |
|---|---|
| Girar y elevar el cañón | Arrastrar con el botón izquierdo (horizontal = giro, vertical = elevación), o ← → / ↑ ↓ |
| Potencia | Rueda del mouse (en tu turno), la barra, o PageUp / PageDown |
| Elegir arma | Botones *Baby Missile* / *Missile*, o las teclas 1 / 2 |
| Nafta (mover el tanque antes de tirar) | Botón *Nafta* o tecla N, y después un clic en el piso dentro del anillo amarillo |
| Tirar | Espacio o el botón *Tirar* |
| Mover la cámara | Arrastrar con el botón derecho (fuera de tu turno, también el izquierdo) |
| Zoom | Shift + rueda, + / −, o la rueda cuando no es tu turno |

Tenés 30 s por turno; si no tirás, perdés el turno. El HUD muestra la ronda (2/5), de quién es
el turno, los segundos, el viento, tu plata, tu inventario y la sala; la dirección del viento es
la flecha celeste en el piso, al lado del tanque del turno. El panel de la izquierda muestra la
vida, los puntos y los Missiles de cada jugador. Si un tiro sale del mapa, todas las pestañas
muestran "¡Se fue!".

### La partida

- **5 rondas.** Cada ronda tiene terreno nuevo, viento sorteado de nuevo, tanques reubicados y
  vida llena. Empieza un jugador distinto cada ronda.
- **La ronda termina** cuando queda un solo tanque vivo, o cuando cada jugador ya tiró 15 veces.
- **Al terminar la ronda se cobra:** cada tanque que sigue vivo recibe $10.000, y después todos
  reciben 15% de interés sobre la plata que tienen. Lo que gastaste en la tienda ya no está, así
  que no da interés. El daño y los kills se cobran en el momento del tiro.
- **Tienda de 20 s entre rondas**, visible para todos, con la plata de cada uno. Cierra antes si
  todos tocan *Listo*. No se puede comprar más de lo que alcanza.

  | Ítem | Precio | Qué hace |
  |---|---|---|
  | Missile ×3 | $1.200 | Explosión de radio 6 (la Baby es 3.5). Se gasta uno por tiro |
  | Paracaídas | $1.250 | La ronda siguiente, caer no te hace daño. Uno por ronda |
  | Nafta | $3.000 | Antes de tirar, mové el tanque hasta 20 celdas. Una vez por turno |

  La Baby Missile es infinita y no se vende.
- **Gana quien tiene más puntos al final de la ronda 5.** Puntos = daño hecho a otros (1 por
  punto de vida) + 10 por kill. La plata no suma puntos: sirve solo para la tienda. Si hay
  empate en puntos desempatan kills y después daño; si sigue igual, es empate.
- **Si se van todos menos uno**, ese gana en el momento.

Para jugar en red local: `pnpm --filter @pegaycobra/client dev --host` y que los demás abran
`http://<tu-ip>:5173`. El cliente se conecta al server en el mismo host, puerto 2567. Para
apuntar a otro server: `VITE_SERVER_URL=ws://host:puerto`.

## Subirlo a la web (Railway)

En producción hay **un solo servicio**: el server de Node entrega también la web ya compilada
(`apps/client/dist`), así que la página y el WebSocket salen del mismo dominio. No hace falta
configurar ninguna URL.

```bash
pnpm build    # compila el cliente a apps/client/dist
pnpm start    # arranca el server, que sirve la web y el juego en $PORT (default 2567)
```

`railway.json` ya le dice a Railway que use esos dos comandos y que chequee `/health`.

1. Subí el repo a GitHub.
2. En <https://railway.com>: *New Project* → *Deploy from GitHub repo* → elegí el repo.
3. Cuando termine el deploy: servicio → *Settings* → *Networking* → *Generate Domain*.
4. Abrí esa URL en dos navegadores y jugá.

Cada `git push` a la rama principal redeploya solo. Un redeploy reinicia el server y corta las
partidas en curso (las salas viven en memoria). Dejá una sola réplica: con dos, dos jugadores
de la misma sala podrían caer en servidores distintos.

### Cómo se reparte el trabajo

- Mensajes del cliente, y nada más:

  | Mensaje | Cuándo | Qué valida el server |
  |---|---|---|
  | `start` | lobby | que sea el anfitrión y haya 2 o más |
  | `fillBots` | lobby | que sea el anfitrión. Agrega bots hasta llegar a 2 jugadores |
  | `fire { yaw, pitch, power, weapon }` | tu turno | `weapon` es `babyMissile` o `missile` y tenés munición. Cualquier otro campo (daño, impacto, posición) se descarta sin llegar al sim. Otra arma: el mensaje se ignora entero |
  | `move { moveTo: { x, z } }` | tu turno, antes de tirar | que tengas nafta, no te hayas movido ya en el turno, y el destino esté a ≤ 20 celdas, dentro del mapa y no pegado a otro tanque (`validateMove` del sim) |
  | `buy { item }` | tienda | que el ítem exista y te alcance la plata (`cannotBuy` del sim) |
  | `ready` | tienda | — |

- El server llama a `resolveTurn` del sim. Manda a todos un mensaje `shot` con el arma, la
  trayectoria (`path`, tríos x/y/z) y la duración de la animación. La munición se descuenta al
  disparar (todos ven el Missile gastado); la vida, la plata, los puntos y el cráter se aplican
  recién cuando termina la animación.
- Otros mensajes del server: `moved` (alguien usó nafta), `skip` (turno perdido por tiempo) y
  `roundEnd` (lo que cobró cada uno al terminar la ronda).
- El heightmap (257 × 257 float32) no va en el estado de Colyseus: viaja en mensajes binarios
  `terrain`. Entero al empezar cada ronda, y después de cada tiro solo el rectángulo que cambió
  (`apps/server/src/terrain-net.ts`). Así el cráter llega a todas las pestañas cuando el
  proyectil cae.
- El cliente dibuja: el terreno es un mesh de ese heightmap, los tanques salen del estado y el
  tiro de `path`. La cámara sigue al proyectil, se queda un momento en el impacto y vuelve al
  tanque del turno. Si el cerro tapa la vista, la cámara se sube.
- En tu turno, el cliente corre `simulateShot3D` del sim para dibujar una **trayectoria
  fantasma** punteada con un anillo donde caería. Es solo para mostrar: no se manda nada y el
  daño sigue saliendo del server. Al tirar se apaga y se anima la trayectoria que manda el server.
  Como posiciones y viento viajan en float32, la fantasma puede diferir del tiro real en una
  fracción de wu.
- La lógica de partida (rondas, turnos, tienda, reloj, salidas, ganador) está en
  `apps/server/src/game.ts`, sin Colyseus. `room.ts` solo la conecta con la red. La sala muere
  cuando queda vacía. No hay cuentas, base de datos ni persistencia.
- Solo con `pnpm dev`, el cliente expone `window.__pyc` (sala, terreno y puntería) para depurar
  desde la consola. No existe en el build.

## Tests

```bash
pnpm test
```

Corre `vitest run` en todos los paquetes. En `apps/server` hay tests de `Game` (turnos, rondas,
tienda, nafta, fin de partida) y uno de integración: levanta el server de verdad, conecta dos
clientes del SDK y juega las 5 rondas por red, con compra de Missiles incluida, hasta que gana
el de más puntos. Ese test tarda unos 20–35 s.

Para un solo paquete o en modo watch:

```bash
pnpm --filter @pegaycobra/sim test
pnpm --filter @pegaycobra/sim test:watch
pnpm typecheck
```

`packages/sim/tsconfig.json` compila con `lib: ["ES2022"]` y `types: []`. Si alguien usa
`window`, `document`, `process` o `Buffer` dentro del sim, el typecheck falla.

## Qué hay en `packages/sim`

| Archivo | Qué hace |
|---|---|
| `constants.ts` | Todas las constantes con nombre y unidad (`GRAVITY`, `WIND_SCALE`, `INTEREST_RATE`…) |
| `heightmap.ts` | `generateHeightmap(seed)`: semiesferas sumadas, scale, smooth, bordes a 0. `heightAt()` |
| `projectile.ts` | `simulateShot()`: potencia + ángulo + viento + gravedad, en pasos fijos |
| `crater.ts` | `applyCrater()` baja el heightmap; `flattenUnder()` aplana bajo un tanque que cayó |
| `damage.ts` | Daño de explosión por distancia, daño de caída, `settleTank()` |
| `weapons.ts` | Baby Missile, Missile, Baby Nuke, Nuke. Se pueden disparar las dos primeras (el Missile, si lo compraste) |
| `economy.ts` | Premio por daño y por kill, interés de fin de ronda, munición |
| `turn.ts` | `resolveTurn(state, { playerId, angleDeg, power }, { recordPath })`: lo que llama el server |
| `match.ts` | Perfil: `rollWind()`, `placeTanks()`, `spreadTanks()` + `GAME_TERRAIN`. `matchOutcome()` (ganador, lo usan los dos modos) |
| `terrain.ts` | **3D.** `generateTerrain(seed)`: grilla width × depth, semiesferas, scale, smooth 5×5. `terrainHeightAt()` bilineal. `applyCraterTerrain()` (disco), `flattenTerrainUnder()` |
| `shot3d.ts` | **3D.** `simulateShot3D()`: yaw 0–360 (0 = +X, 90 = +Z), pitch 0–90, potencia; viento `{x, z}`; gravedad en Y |
| `turn3d.ts` | **3D.** `rollWind3D()`, `placeTanks3D()`, `resolveTurn3D()`. `resolveTurn()` lo usa cuando el estado tiene `terrain`. Con paracaídas, la caída no daña |
| `campaign.ts` | **Partida.** `startRound3D()` (ronda nueva), `endRoundPayouts()` (premio por sobrevivir + interés), `SHOP_ITEMS`, `buyItem()` / `cannotBuy()`, `validateMove()` / `moveTank()` (nafta), `scoreTurn()`, `standings()`, `matchWinners()` |

Todo son funciones puras: reciben el estado y devuelven uno nuevo. En 3D el heightmap es un
`Float32Array` de width × depth con índice `x + z * width`; la altura es y. En perfil, el
índice es x. Los tests del perfil se quedan: fijan la parábola, que es la misma en los dos modos
(un test 3D comprueba que el alcance coincide).

### Unidades

- **wu**: unidad de mundo. 1 wu = 1 celda del heightmap.
- **tick**: un paso de integración. El original no usa dt: en cada paso hace `v += a` y
  después `p += v / 100`. Un tick equivale a `STEP_SECONDS` = 0.01125 s, solo para animar.
- **ángulo**: 0° = derecha, 90° = arriba, 180° = izquierda.
- **potencia**: 0..1000.
- **viento**: −5..5, positivo empuja hacia +x.

### Ejemplo numérico

Suelo plano a 10 wu, tanque en x = 40, sin viento:

| ángulo | potencia | viento | x de impacto | ticks |
|---|---|---|---|---|
| 45° | 600 | 0 | **133.27** | 363 (≈ 4.1 s) |
| 45° | 600 | +5 | 152.14 | 363 |
| 45° | 600 | −5 | 114.39 | 363 |
| 60° | 750 | 0 | 164.64 | 551 |

A 45° y potencia 600, la velocidad inicial es 0.06 · 601 = 36.06 vu, o sea 25.50 vu por eje.
La gravedad resta 10/70 = 0.1429 vu por tick, así que la subida y la bajada tardan
2 · 25.50 / 0.1429 ≈ 357 ticks, más 6 ticks porque la boca del cañón está 1.7 wu sobre el suelo.
En x avanza 0.255 wu por tick: 40.71 + 363 · 0.255 = 133.27.

## Licencia

**GPL-2.0-or-later.** Ver [LICENSE](LICENSE).

El sim adapta fórmulas, constantes y la tabla de armas de Scorched3D, que es GPL-2.0-or-later,
así que este repo también lo es. Cada archivo de `packages/sim/src` tiene una línea
`SPDX-License-Identifier: GPL-2.0-or-later` y comentarios que dicen de qué archivo del
original salió cada cosa.

No se copió ningún asset del original (texturas, modelos, audio). En el MVP, el terreno y los
tanques son primitivas generadas.

## Origen de las reglas

Árbol de referencia: <https://github.com/bberberov/scorched3d> (rama `core`). Archivo histórico:
<https://github.com/osgamearchive/scorched3d>. Binario de referencia v44: <http://www.scorched3d.co.uk/>.

| Regla | Archivo original | Dónde quedó |
|---|---|---|
| Heightmap: semiesferas sumadas | `src/common/landscapemap/HeightMapModifier.cpp` `generateTerrain()`, `addCirclePeak()` | `heightmap.ts` |
| Heightmap: scale, smooth, bordes a 0 | `HeightMapModifier.cpp` `scale()`, `smooth()`, `levelSurround()` | `heightmap.ts` |
| Parámetros del terreno | `data/globalmods/none/data/landscapes/defnhilly.xml` | `DEFAULT_TERRAIN` |
| Velocidad inicial (ángulo, potencia) | `src/common/tank/TankLib.cpp` `getVelocityVector()`, `getGunPosition()`; `src/common/simactions/PlayMovesSimAction.cpp` | `projectile.ts` |
| Paso de integración, viento, gravedad | `src/common/engine/PhysicsParticleObject.cpp` `setForces()`, `simulate()` | `projectile.ts` |
| Paso de tiempo del tiro | `src/common/actions/ShotProjectile.cpp`, `src/common/weapons/WeaponProjectile.cpp` (`stepSize`) | `STEP_SECONDS` |
| Rango del viento | `src/common/engine/Wind.cpp` | `WIND_MAX` |
| Gravedad, caída mínima, plata (defaults) | `src/common/common/OptionsGame.cpp` | `constants.ts` |
| Cráter | `src/common/landscapemap/DeformLandscape.cpp` `deformLandscapeInternal()` | `crater.ts` |
| Aplanar bajo el tanque | `DeformLandscape.cpp` `flattenAreaInternal()` | `crater.ts` |
| Radio del cráter = radio de la explosión | `src/common/actions/Explosion.cpp`, `src/common/weapons/WeaponExplosion.cpp` | `turn.ts` |
| Daño por distancia a la explosión | `src/common/target/TargetDamageCalc.cpp` `explosion()` | `damage.ts` |
| Tamaño y vida del tanque | `src/common/target/TargetLife.cpp`, `data/globalmods/none/data/tanktypes.xml` | `constants.ts` |
| Daño de caída | `src/common/actions/TargetFalling.cpp` `collision()` | `damage.ts` |
| Premio por daño y por kill | `src/common/target/TargetDamage.cpp` `damageTarget()` | `economy.ts` |
| Interés de fin de ronda | `src/common/simactions/ShowScoreSimAction.cpp` | `economy.ts` |
| Tope de plata | `src/common/tank/TankScore.cpp` | `MONEY_MAX` |
| Las 4 armas | `data/globalmods/none/data/accessories.xml` | `weapons.ts` |
| Viento al azar (0..5, dirección al azar) | `src/common/engine/Wind.cpp` `newLevel()` | `match.ts` `rollWind()` |
| Ubicación inicial de tanques | `src/common/landscapedef/LandscapeDefnTankStart.cpp` `LandscapeDefnTankStartHeight::placeTank()`; `defnhilly.xml` `<tankstart>` | `match.ts` `placeTanks()` |
| **3D:** heightmap 2D por semiesferas, smooth 5×5, bordes a 0 | `HeightMapModifier.cpp` `generateTerrain()`, `addCirclePeak()` (con x e y), `scale()`, `smooth()`, `levelSurround()` | `terrain.ts` |
| **3D:** cráter = disco | `DeformLandscape.cpp` `DeformLandscapeCacheItem`, `deformLandscapeInternal()` (recorre x e y, `dist = √(x² + y²)`) | `terrain.ts` `applyCraterTerrain()` |
| **3D:** aplanar bajo el tanque (cuadrado 5×5) | `DeformLandscape.cpp` `flattenAreaInternal()` | `terrain.ts` `flattenTerrainUnder()` |
| **3D:** dirección del tiro con dos ángulos | `TankLib.cpp` `getVelocityVector(xy, yz)` | `shot3d.ts` `aimDirection()` |
| **3D:** viento como vector `(sin a, cos a) × velocidad` | `Wind.cpp` `newLevel()`, `updateDirection()`; `PhysicsParticleObject.cpp` `setForces()` | `turn3d.ts` `rollWind3D()`, `shot3d.ts` |
| **3D:** altura interpolada | `GroundMaps::getInterpHeight` | `terrain.ts` `terrainHeightAt()` |
| **Partida:** 5 rondas | `OptionsGame.cpp` "NumberOfRounds" (default 5) | `ROUNDS_PER_MATCH` |
| **Partida:** 15 tiros por jugador por ronda | `OptionsGame.cpp` "MaxNumberOfRoundTurns" (15) | `ROUND_MAX_TURNS` |
| **Partida:** la tienda abre antes de la ronda 2 | `OptionsGame.cpp` "MoneyBuyOnRound" (2) | `FIRST_SHOP_ROUND` |
| **Partida:** premio al que sigue vivo | `OptionsGame.cpp` "MoneyWonForRound" (5000) + "MoneyWonForLives" (5000) × "PlayerLives" (1) | `SURVIVOR_BONUS` = 10000 |
| **Partida:** primero el premio, después el interés | `src/common/simactions/ShowScoreSimAction.cpp` | `endRoundPayouts()` |
| **Partida:** interés 15% | `OptionsGame.cpp` "MoneyInterest" (15) | `INTEREST_RATE` |
| **Partida:** puntos por kill; matarse resta | `OptionsGame.cpp` "ScorePerKill" (10); `TargetDamage.cpp` (kill propio: kills − 1 y score − ScorePerKill) | `SCORE_PER_KILL`, `scoreTurn()` |
| **Partida:** la plata no da puntos | `OptionsGame.cpp` "ScorePerMoney" (0) | `scoreTurn()` |
| **Tienda:** precio del Missile | `accessories.xml` Missile: `<cost>2000</cost>` por `<bundlesize>5</bundlesize>` → 400 c/u | `SHOP_ITEMS.missile` (3 × 400) |
| **Tienda:** precio del paracaídas | `accessories.xml` Parachute: 10000 por 8 → 1250 c/u | `SHOP_ITEMS.parachute` |
| **Tienda:** precio de la nafta | `accessories.xml` Fuel: 6000 por 40 unidades → 150 por celda | `SHOP_ITEMS.fuel` (20 × 150) |
| **Paracaídas:** con paracaídas, caer no daña | `src/common/actions/TargetFalling.cpp` `collision()` | `turn3d.ts` |

### Diferencias con el original (a propósito)

- **Modo 3D:**
  - **Ejes.** El original tiene el piso en (x, y) y la altura en z; acá el piso es (x, z) y la
    altura es y, que es lo que usa Three.js. Ángulos propios: yaw 0 = +X, 90 = +Z; pitch sobre
    el horizonte. El original usa `rotXY` y `rotYZ` con otra referencia.
  - **Suavizado más fuerte en la partida** (`GAME_TERRAIN_3D`: smooth 5×5 con todos los pesos
    iguales en vez de 0.04). Con el ruido por celda de `addCirclePeak`, el terreno original se ve
    como pelusa bajo luz por vértice. La física usa el mismo terreno que se dibuja.
  - **Ubicación de tanques propia** (`placeTanks3D`): sobre un anillo alrededor del centro,
    repartidos en ángulos iguales, nunca a menos de 60 celdas entre sí.
    `LandscapeDefnTankStartHeight::placeTank()` tira al azar y no garantiza distancia.
  - **Sin paredes:** si x o z salen del mapa, el tiro se pierde ("¡Se fue!").
  - **Quemado de cráter** solo visual: el cliente oscurece las celdas que bajó un cráter (en el
    original lo hace `DeformTextures` con una textura de quemado; acá no hay texturas).
- **Partida y tienda:**
  - **El puntaje es solo daño + kills.** 1 punto por punto de vida que le sacás a otro (regla
    propia) y 10 por kill (`ScorePerKill`). No se usa `ScoreWonForRound` (250 por ganar la
    ronda): sobrevivir paga plata, no puntos.
  - **Missile de a 3.** El original lo vende de a 5 por $2000; acá el pack es de 3 al mismo
    precio por unidad.
  - **El paracaídas dura toda la ronda siguiente** y se compra de a uno. En el original se
    venden de a 8 y se gasta uno por caída.
  - **La nafta mueve antes de tirar** y el turno sigue. En el original, mover reemplaza al tiro.
    Una carga alcanza 20 celdas en línea recta (el original da 40 unidades, una por casillero,
    con un máximo de 50 por movimiento) y no hay límite de pendiente (`MaxClimbingDistance`).
  - **Orden de turnos:** por orden de llegada, empezando por un jugador distinto cada ronda. El
    original usa "el que va perdiendo primero" (`TurnSequentialLoserFirst`).
  - **Si queda un solo jugador conectado, gana en el momento,** sin esperar el fin de la ronda.
- **Modo perfil (sigue en el sim, con sus tests):** el heightmap es una sola fila. Las
  semiesferas se evalúan solo sobre esa fila. Por defecto hay entre 10 y 16 colinas en vez de
  50–70, porque en un mapa de 256×256 la mayoría no cruza una fila dada. El smooth usa 5 muestras
  en vez de 5×5.
- **Sin noise, erosión ni máscara** en la generación.
- **Terreno de la partida sin `levelSurround` y con 14–20 colinas** (`GAME_TERRAIN`). Con el
  default de `defnhilly.xml`, en perfil, un tercio del mapa quedaba en el piso y la tierra se
  juntaba en un cerro central. La fórmula de las semiesferas es la misma.
- **Ubicación de tanques propia** (`spreadTanks`). El ancho se parte en una franja por jugador y
  cada tanque cae en la mitad central de una franja distinta, así quedan a ≥59 wu con 2 jugadores
  y a ≥30 wu con 4. `placeTanks` (la del original, al azar) queda en el sim pero no se usa:
  podía dejar a los dos en el mismo pico.
- **Punto flotante, no punto fijo.** El original hace toda la física con `fixed`
  (entero / 10000, `src/common/common/fixed.cpp`). Acá es `number` de doble precisión. Las
  constantes y el orden del paso son los mismos, pero las trayectorias no van a coincidir bit a
  bit con el binario v44: el redondeo a 4 decimales del original se acumula distinto.
- **Viento como escalar (solo en perfil).** En el original el viento es un vector horizontal
  (dirección unitaria × velocidad entera 0..5, `Wind.cpp`). En perfil solo importa la componente
  x, así que es un número con signo en [−5, 5]. En 3D es el vector, como en el original.
- **Boca del cañón.** Sale de centro del tanque (base + 1 wu) + 1 wu en la dirección del tiro.
  El largo del cañón es el del original (`getGunPosition`, `gunLength = 1`). La altura de la
  torreta es propia.
- **Sin paredes.** Si el tiro sale de `[0, width − 1]` se pierde (`outcome: "offmap"`).
- **La caída no se integra.** El original simula al tanque cayendo como partícula con gravedad.
  Como solo se mueve en vertical, la distancia caída es la diferencia de alturas, que es lo que
  se usa acá para el daño.
- **Dos armas jugables** (Baby Missile y Missile). Baby Nuke y Nuke son solo datos.
- **RNG propio** (mulberry32) en lugar del `RandomGenerator` del original: lo que importa es que
  la misma semilla dé el mismo terreno en el server y en los tests.

## Fuera de alcance por ahora

Nuke y Baby Nuke, sonido, cuentas, base de datos, matchmaking, una segunda cámara y deploy. No se
portó nada de OpenGL, wxWidgets, SDL ni Lua del original: el render es Three.js escrito de cero.
El viento se sortea al empezar cada ronda y no cambia dentro de la ronda (en el original es la
opción `WindChangeNever`). El que no tiene el turno ve el cañón ajeno en el último ángulo que
disparó, no moviéndose en vivo.
