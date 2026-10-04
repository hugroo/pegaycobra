# pegaycobra

Revival web de Scorched 3D: artillería por turnos, terreno destructible y tienda entre rondas.
No es un port. El loop se escribe de nuevo y las reglas (física, cráter, daño, plata) se toman
del original.

Estado: **jugable en 3D en el navegador, multijugador de 2 a 4, partida de 5 rondas con tienda.**
Ocho armas (Chispa infinita; Misil, Rodillo, Quema, Bombazo, Tierra, Racimo y Rebote comprados), escudo, paracaídas y nafta.

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

Controles (la barra de abajo aparece solo en tu turno; un arma sin munición no se muestra):

| Qué | Cómo |
|---|---|
| Girar y elevar el cañón | Arrastrar con el botón izquierdo (horizontal = giro, vertical = elevación), o ← → / ↑ ↓ |
| Potencia | Rueda del mouse (en tu turno), la barra, o PageUp / PageDown |
| Elegir arma | Botones *Chispa* / *Misil* / *Rodillo* / *Quema* / *Bombazo* / *Tierra* / *Racimo* / *Rebote*, o las teclas 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 |
| Nafta (mover el tanque antes de tirar) | Botón *Nafta* o tecla N, y después un clic en el piso dentro del anillo amarillo |
| Tirar | Espacio o el botón *Tirar* |
| Mover la cámara | Arrastrar con el botón derecho (fuera de tu turno, también el izquierdo) |
| Zoom | Shift + rueda, + / −, o la rueda cuando no es tu turno |

Tenés 30 s por turno; si no tirás, perdés el turno. El HUD flota sobre el cerro. Arriba, siempre:
de quién es el turno (en ocre cuando es el tuyo), los segundos y el viento; la dirección del viento
es la flecha celeste en el piso, al lado del tanque del turno. Abajo, solo en tu turno: arma,
nafta, potencia, *Tirar*, tu plata y lo que tenés puesto (escudo, paracaídas). El panel de la
izquierda muestra la ronda (2/5), la sala y la vida de cada jugador; en tu turno y en la tienda
suma los puntos, los Misiles, los Rodillos y el escudo de cada uno. Si un tiro sale del mapa,
todas las pestañas muestran "¡Se fue!". Un tanque con escudo se ve dentro de una burbuja celeste;
cuando el escudo se come un tiro, el cartel del impacto dice "bloqueado" en vez del daño (con el
Bombazo no: el escudo no lo frena y el cartel dice el daño).
Un fuego de Quema es una mancha naranja con llamas en el piso y un disco naranja en el minimapa;
el panel de la izquierda marca "en el fuego" al tanque parado adentro, y cuando le empieza el turno
sale el cartel "se quema: -25".
Una Tierra levanta una loma: el piso sube en la vista 3D y en el minimapa de todas las pestañas, el
cartel del impacto dice "loma" y, si había un tanque ahí, queda parado arriba.
Un Racimo se abre en el aire: la fantasma marca dónde se abre y dibuja, desde ahí, el recorrido y
el anillo de cada una de las cinco cabezas. Al tirarlo se ven las cinco caer y explotar, quedan
cinco hoyos chicos y el cartel del impacto es uno solo, con el daño de todas sumado.
Un Rebote pica y sigue: la fantasma dibuja los dos tramos, con un punto donde pica y el anillo
donde termina el segundo. Al tirarlo se ve la bola tocar el piso, levantar polvo y seguir; el hoyo y
el cartel quedan en el segundo golpe.

### La partida

- **5 rondas.** Cada ronda tiene terreno nuevo, viento sorteado de nuevo, tanques reubicados y
  vida llena. Empieza un jugador distinto cada ronda.
- **El viento es parte del tiro.** Al empezar cada turno se corre un poco desde el del turno
  anterior (entre 0.25 y 1 de los 5 que puede tener): nunca queda igual y nunca pasa de golpe a un
  huracán. El cartel y la flecha cambian al empezar el turno, no con un tiro en el aire.
- **La ronda termina** cuando queda un solo tanque vivo, o cuando cada jugador ya tiró 15 veces.
- **Plata.** Se arranca con $4.000. El daño y los kills se cobran en el momento del tiro: con la
  Chispa, $10 por punto de vida y $30 por punto en el tiro que mata (un kill de lleno, $3.000).
- **Al terminar la ronda se cobra:** cada tanque que sigue vivo recibe $2.000, y después todos
  reciben 15% de interés sobre la plata que tienen, más $1.500 fijos. Lo que gastaste en la tienda
  ya no está, así que no da interés. No alcanza para comprar todo: hay que elegir.
- **Tienda de 20 s entre rondas**, visible para todos, con la plata de cada uno: una fila de
  cartas abajo (precio y qué hace cada cosa), sin tapar el mapa. Cierra antes si
  todos tocan *Listo*. No se puede comprar más de lo que alcanza.

  | Ítem | Precio | Qué hace |
  |---|---|---|
  | Misil ×3 | $1.200 | Explosión de radio 6 (la Chispa es 3.5). Se gasta uno por tiro |
  | Rodillo ×2 | $1.500 | Vuela con la misma potencia que un Misil, toca el piso y rueda cuesta abajo hasta 60 celdas o hasta un tanque, y ahí explota (radio 4.5, cráter chico). En lo llano explota donde cae. Si vuelve rodando hasta vos, te pega |
  | Quema ×1 | $2.000 | Cae como un Misil, pero no explota ni abre cráter: deja fuego en un disco de radio 5 hasta que termina la ronda. Al caer no saca vida. El tanque que **empieza su turno** con la base adentro del disco pierde 25, todos los turnos, hasta que salga (con nafta) o se muera. Los puntos y la plata de ese daño son del que tiró la Quema |
  | Bombazo ×1 | $6.000 | Un Misil enorme: vuela igual, y la explosión y el cráter son de radio 18 (tres veces el Misil). No rueda ni prende fuego. El escudo no lo frena ni se gasta. Es el ítem más caro |
  | Tierra ×1 | $1.150 | Cae como un Misil, pero suma tierra en vez de sacarla: levanta una loma de radio 10 (11 de alto en el centro) y el heightmap sube. No saca vida, no paga y el escudo no la frena. El tanque que queda debajo sube con la loma. Un Rodillo que pega en la ladera la baja rodando, y un Misil puede volver a abrirle un hoyo |
  | Racimo ×1 | $2.500 | Sale como un Misil y, en la cima de la parábola, se abre en 5. Una cabeza sigue el tiro y cae donde caería el Misil; las otras cuatro caen a 7 celdas de esa, en X. Cada una explota por su cuenta (radio 4.5) y deja un cráter chico. El daño de todas se suma. El escudo frena una sola |
  | Rebote ×2 | $1.600 | Sale como un Misil, pega en el piso y sigue, una sola vez, con la mitad de la velocidad. Donde pica no explota ni abre cráter: explota en el segundo golpe, como un Misil (radio 6). Si el primer golpe es contra un tanque, explota ahí y no sigue. No rueda y no se abre |
  | Escudo | $2.000 | Absorbe el próximo tiro cuya explosión te alcance (Chispa, Misil o Rodillo; el Bombazo no; del Racimo, una cabeza) y se gasta. Uno por vez; si nadie te pega, lo seguís teniendo la ronda siguiente |
  | Paracaídas | $1.250 | La ronda siguiente, caer no te hace daño. Uno por ronda |
  | Nafta | $3.000 | Antes de tirar, mové el tanque hasta 20 celdas. Una vez por turno |

  La Chispa es infinita y no está en la tienda.

  **Vender.** Debajo de cada carta que tenés hay un renglón *Vendé*: te devuelven la mitad del
  precio, al toque. Se vende de a un pack; si ya tiraste alguno, se vende lo que queda (de 3 Misiles
  con uno tirado, vuelven $400 por los dos). El Escudo queda puesto desde que lo comprás y no se
  vende; la Nafta y el Paracaídas sin usar, sí. Solo en la tienda.

  **Qué tapa el escudo y qué no.** Tapa el tiro entero: la explosión no te saca vida y, si el
  cráter de ese mismo tiro te deja sin piso, caés pero esa caída tampoco duele. No tapa la caída
  sola: si un tiro te saca el piso sin que la explosión te alcance (por ejemplo, pega al pie del
  barranco donde estás parado), caés, duele como siempre (para eso está el paracaídas) y el
  escudo no se gasta. Un tiro que se fue del mapa tampoco lo gasta. Y no apaga el fuego: la Quema
  no es una explosión, así que el escudo ni lo frena ni se gasta, y el tanque se quema igual.
  Tampoco frena el Bombazo: la explosión y la caída a su cráter te sacan vida como si no tuvieras
  escudo, el escudo queda puesto y el cartel dice el daño. La Tierra no es un golpe: la loma sube
  igual, con escudo o sin escudo, y el escudo no se gasta. Del Racimo tapa una sola cabeza, la
  primera que te iba a sacar vida: si te alcanza otra, esa duele como a cualquiera, y el cartel dice
  "bloqueado" y el daño.

  **El fuego.** Dura lo que queda de la ronda: la ronda siguiente arranca limpia. No es terreno: el
  heightmap queda igual y nadie cae. Dos fuegos encimados queman dos veces. Tu propio fuego te quema
  a vos también. Si el fuego mata al que le tocaba el turno, juega el siguiente.

  **La loma.** Es terreno de verdad: tapa tiros rasantes, el Rodillo la baja rodando y los cráteres
  la abren. Tierra sobre tierra sigue subiendo. Ningún tanque queda enterrado: el que estaba abajo
  (el tuyo también) sube con el piso y conserva la vida. No apaga un fuego: el disco sigue quemando
  arriba de la loma. Dura lo que queda de la ronda, como todo el terreno.
  **El racimo.** Se abre en el primer paso en que el tiro deja de subir. Si antes choca con un
  cerro o con un tanque, o sale rasante y nunca sube, no se abre: explota ahí como una cabeza sola.
  El dibujo es siempre el mismo, tire como tire: cuatro cabezas a 7 celdas de la del medio (menos si
  la cima queda casi contra el piso). Las cabezas que se van del mapa no abren hoyo; las demás, sí.
  Cada cabeza se resuelve entera, en el orden en que cae: su cráter, su explosión y la caída a ese
  cráter.
  **El rebote.** Pica donde el tiro toca el piso por primera vez. De ahí sale apoyado en el piso,
  con el mismo rumbo y la mitad de la velocidad, y lo que venía bajando ahora sube: no se refleja
  contra la ladera, sigue para adelante (si la subida es más empinada que el pique, vuelve a tocar
  ahí nomás). En piso llano el segundo tramo mide un cuarto del primero. El viento empuja los dos
  tramos. Pica una sola vez: el segundo golpe explota, sea piso o tanque. Si el segundo tramo se va
  del mapa, no explota nada. Para el escudo es un tiro como cualquiera.
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
  | `fire { yaw, pitch, power, weapon }` | tu turno | `weapon` es `babyMissile`, `missile`, `roller`, `napalm`, `nuke`, `dirt`, `mirv` o `leapfrog` y tenés munición. Cualquier otro campo (daño, impacto, posición) se descarta sin llegar al sim. Otra arma: el mensaje se ignora entero |
  | `move { moveTo: { x, z } }` | tu turno, antes de tirar | que tengas nafta, no te hayas movido ya en el turno, y el destino esté a ≤ 20 celdas, dentro del mapa y no pegado a otro tanque (`validateMove` del sim) |
  | `buy { item }` | tienda | que el ítem exista y te alcance la plata (`cannotBuy` del sim) |
  | `sell { item }` | tienda | que tengas ese ítem y no sea el Escudo (`cannotSell` del sim). Devuelve la mitad |
  | `ready` | tienda | — |
  | `chat { text }` | siempre | que sea texto. Lo deja en una línea, sin caracteres de control, de hasta 120 caracteres; si no queda nada, se ignora |

- El server llama a `resolveTurn` del sim. Manda a todos un mensaje `shot` con el arma, la
  trayectoria (`path`, tríos x/y/z; con el Rodillo incluye la rodada por el piso), la duración de
  la animación, el daño y `blocked` (a quién le absorbió el tiro un escudo). Con un Racimo que
  se abrió, `path` llega hasta el punto de apertura y `heads` trae el recorrido de cada cabeza
  desde ahí; el daño es el de todas sumado. Con un Rebote que picó, `path` trae los dos tramos
  seguidos y `bounce.tick` dice en qué punto tocó el piso. La munición se
  descuenta al disparar (todos ven el Misil gastado); la vida, la plata, los puntos, el cráter
  (o la loma), el fuego y los escudos gastados se aplican recién cuando termina la animación.
- Los fuegos de Quema van en el estado de Colyseus (`fires`: centro y radio de cada disco), así
  todas las pestañas dibujan la misma mancha. Cada vez que empieza un turno, el server corre
  `burnTurn3D` del sim para ese tanque; si se quemó, manda `burn { id, damage, killed }`.
- El bot compra en la tienda solo si no le queda ningún Misil: un pack de Misil o de Rodillo, a
  cara o cruz. Tira lo que tenga (Misil, si no Rodillo, si no la Chispa) apuntando igual que
  siempre. No compra Quema, Bombazo, Tierra, Racimo, Rebote, escudo, paracaídas ni nafta.
- Otros mensajes del server: `moved` (alguien usó nafta), `skip` (turno perdido por tiempo),
  `burn` (a alguien le empezó el turno en el fuego) y `roundEnd` (lo que cobró cada uno al terminar
  la ronda).
- Chat de sala: el server le pone a cada `chat` el nombre y el slot (el color del tanque) de quien
  lo mandó y lo reparte a la sala en el orden en que llegó. No lo guarda: el historial es de cada
  pestaña, dura mientras estés en la sala y se muestra como texto plano.
- El heightmap (257 × 257 float32) no va en el estado de Colyseus: viaja en mensajes binarios
  `terrain`. Entero al empezar cada ronda, y después de cada tiro solo el rectángulo que cambió
  (`apps/server/src/terrain-net.ts`). Así el cráter, o la loma de una Tierra, llega a todas las
  pestañas cuando el proyectil cae.
- El cliente dibuja: el terreno es un mesh de ese heightmap, los tanques salen del estado y el
  tiro de `path`. La cámara sigue al proyectil, se queda un momento en el impacto y vuelve al
  tanque del turno. Si el cerro tapa la vista, la cámara se sube.
- En tu turno, el cliente corre `simulateShot3D` del sim para dibujar una **trayectoria
  fantasma** punteada con un anillo donde caería (con la Quema, el anillo es el disco que quedaría
  prendido: `fireFromShot`, la misma función que usa el server; con la Tierra, el pie de la loma;
  con el Racimo, la marca de la apertura y un anillo por cabeza; con el Rebote, un punto donde
  pica y el anillo donde termina el segundo tramo). Es solo para mostrar: no se manda nada y el
  daño sigue saliendo del server. Al tirar se apaga y se anima la trayectoria que manda el server.
  El viento es el del estado, y el sim lo guarda en float32, que es como viaja: la fantasma y el
  server tiran con el mismo vector. Las posiciones también viajan en float32 y esas sí se redondean
  en el camino, así que la fantasma puede diferir del tiro real en una fracción de wu.
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
clientes del SDK y juega las 5 rondas por red, con compra de Misiles incluida, hasta que gana
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
| `weapons.ts` | Chispa, Misil, Rodillo, Quema, Baby Nuke, Bombazo, Tierra, Racimo, Rebote. Se pueden disparar todas menos la Baby Nuke (Misil, Rodillo, Quema, Bombazo, Tierra, Racimo y Rebote, si los compraste) |
| `economy.ts` | Premio por daño y por kill, interés de fin de ronda, munición |
| `turn.ts` | `resolveTurn(state, { playerId, angleDeg, power }, { recordPath })`: lo que llama el server |
| `match.ts` | Perfil: `rollWind()`, `placeTanks()`, `spreadTanks()` + `GAME_TERRAIN`. `matchOutcome()` (ganador, lo usan los dos modos) |
| `terrain.ts` | **3D.** `generateTerrain(seed)`: grilla width × depth, semiesferas, scale, smooth 5×5. `terrainHeightAt()` bilineal. `applyCraterTerrain()` (disco que baja), `applyMoundTerrain()` (disco que sube: la loma de la Tierra), `flattenTerrainUnder()` |
| `shot3d.ts` | **3D.** `simulateShot3D()`: yaw 0–360 (0 = +X, 90 = +Z), pitch 0–90, potencia; viento `{x, z}`; gravedad en Y. `flyShot3D()`: un tramo de vuelo desde un proyectil ya lanzado, que puede cortar en la cima |
| `roller.ts` | **3D.** `simulateRoll()`: la bola baja por el gradiente del terreno hasta un tanque, N celdas o quedarse sin pendiente. `simulateWeaponShot3D()`: el tiro de cualquier arma, con la rodada si es un Rodillo, la apertura si es un Racimo y el pique si es un Rebote. Lo usan el server, la fantasma del cliente y el bot |
| `mirv.ts` | **3D.** `simulateSplitShot3D()`: el tiro del Racimo, que vuela hasta la cima y ahí se abre en cabezas (`split` en el resultado). `splitDirection()`: para qué lado sale cada una. `shotImpacts()`: los golpes de un tiro en el orden en que caen (uno, o uno por cabeza) |
| `bounce.ts` | **3D.** `simulateBounceShot3D()`: el tiro del Rebote, que toca el piso, pica una vez y sigue hasta el segundo golpe (`bounce` en el resultado: dónde picó y en qué tick) |
| `napalm.ts` | **3D.** `fireFromShot()`: el fuego que deja un tiro de Quema (o null). `inFire()`: si un punto del piso está adentro del disco. Lo usan el server, la fantasma del cliente y el HUD |
| `turn3d.ts` | **3D.** `rollWind3D()` (viento con el que arranca la ronda), `driftWind3D()` (el de cada turno: el anterior, corrido a lo sumo `WIND_DRIFT_MAX`), `placeTanks3D()`, `resolveTurn3D()`. `resolveTurn()` lo usa cuando el estado tiene `terrain`. Con paracaídas, la caída no daña. Con escudo, el próximo tiro que te alcanza no daña (`blocked`), salvo el Bombazo (`piercesShield`). Una Quema no toca el terreno y agrega un fuego a `state.fires`. Una Tierra sube el terreno y, con él, al tanque que quedó debajo; no saca vida ni gasta escudos. Un Racimo abierto se resuelve cabeza por cabeza, y el escudo absorbe una sola. Un Rebote explota una vez, donde termina el segundo tramo. `burnTurn3D()`: lo que pierde un tanque al empezar su turno parado en un fuego |
| `campaign.ts` | **Partida.** `startRound3D()` (ronda nueva), `endRoundPayouts()` (premio por sobrevivir + interés), `SHOP_ITEMS`, `buyItem()` / `cannotBuy()`, `sellItem()` / `cannotSell()`, `validateMove()` / `moveTank()` (nafta), `scoreTurn()`, `standings()`, `matchWinners()` |

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
| **3D:** loma = disco que sube | `DeformLandscape.cpp` `deformLandscapeInternal()` con `down = false` (mismo `DeformLandscapeCacheItem` que el cráter) | `terrain.ts` `applyMoundTerrain()` |
| **3D:** aplanar bajo el tanque (cuadrado 5×5) | `DeformLandscape.cpp` `flattenAreaInternal()` | `terrain.ts` `flattenTerrainUnder()` |
| **3D:** dirección del tiro con dos ángulos | `TankLib.cpp` `getVelocityVector(xy, yz)` | `shot3d.ts` `aimDirection()` |
| **3D:** viento como vector `(sin a, cos a) × velocidad` | `Wind.cpp` `newLevel()`, `updateDirection()`; `PhysicsParticleObject.cpp` `setForces()` | `turn3d.ts` `rollWind3D()`, `shot3d.ts` |
| **3D:** altura interpolada | `GroundMaps::getInterpHeight` | `terrain.ts` `terrainHeightAt()` |
| **Partida:** 5 rondas | `OptionsGame.cpp` "NumberOfRounds" (default 5) | `ROUNDS_PER_MATCH` |
| **Partida:** 15 tiros por jugador por ronda | `OptionsGame.cpp` "MaxNumberOfRoundTurns" (15) | `ROUND_MAX_TURNS` |
| **Partida:** la tienda abre antes de la ronda 2 | `OptionsGame.cpp` "MoneyBuyOnRound" (2) | `FIRST_SHOP_ROUND` |
| **Partida:** premio al que sigue vivo | `OptionsGame.cpp` "MoneyWonForRound" + "MoneyWonForLives" × "PlayerLives" (1). Los montos son propios (1000 + 1000; el original, 5000 + 5000) | `SURVIVOR_BONUS` = 2000 |
| **Partida:** primero el premio, después el interés | `src/common/simactions/ShowScoreSimAction.cpp` | `endRoundPayouts()` |
| **Partida:** interés 15% | `OptionsGame.cpp` "MoneyInterest" (15) | `INTEREST_RATE` |
| **Partida:** puntos por kill; matarse resta | `OptionsGame.cpp` "ScorePerKill" (10); `TargetDamage.cpp` (kill propio: kills − 1 y score − ScorePerKill) | `SCORE_PER_KILL`, `scoreTurn()` |
| **Partida:** la plata no da puntos | `OptionsGame.cpp` "ScorePerMoney" (0) | `scoreTurn()` |
| **Tienda:** precio del Misil | `accessories.xml` Missile: `<cost>2000</cost>` por `<bundlesize>5</bundlesize>` → 400 c/u | `SHOP_ITEMS.missile` (3 × 400) |
| **Tienda:** Bombazo: radio y precio | `accessories.xml` Nuke: `<size>18</size>`, `<cost>12000</cost>` por `<bundlesize>2</bundlesize>` → 6000 c/u | `WEAPONS.nuke`, `SHOP_ITEMS.nuke` (1 × 6000) |
| **Tienda:** Tierra: radio y precio | `accessories.xml` Dirt Ball: `<deform>up</deform>`, `<size>10</size>`, `<hurtamount>0.0</hurtamount>`, `<cost>5750</cost>` por `<bundlesize>5</bundlesize>` → 1150 c/u | `WEAPONS.dirt`, `SHOP_ITEMS.dirt` (1 × 1150) |
| **Tienda:** Racimo: se abre en la cima, en 5 | `src/common/actions/ShotProjectile.cpp` (`<apexcollision>`: venía subiendo y dejó de subir); `src/common/weapons/WeaponMirv.cpp` `fireWeapon()` (una cabeza con la velocidad del tiro y `noWarheads - 1` más); `accessories.xml` MIRV: `<nowarheads>5</nowarheads>`, `<armslevel>6</armslevel>` | `shot3d.ts` `flyShot3D()`, `mirv.ts`, `WEAPONS.mirv` |
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
  - **Menos plata.** Las opciones son las del original, los montos no: se arranca con $4.000
    (`MoneyStarting` 10000), pegar paga 100 y matar 300 por armslevel (250 y 750), sobrevivir
    $2.000 (10000) y hay un fijo de $1.500 por ronda (`MoneyPerRound` 0), que le deja al que perdió
    con qué volver. Con los montos del original, el que gana la primera ronda compra la tienda entera.
  - **Vender a la mitad.** El original tiene un `<sellprice>` por accesorio; acá es siempre la
    mitad del precio y el Escudo no se vende.
  - **Misil de a 3.** El original lo vende de a 5 por $2000; acá el pack es de 3 al mismo
    precio por unidad.
  - **El paracaídas dura toda la ronda siguiente** y se compra de a uno. En el original se
    venden de a 8 y se gasta uno por caída.
  - **Rodillo propio.** El original tiene rollers (`WeaponRoller.cpp`) que ruedan como partícula
    con rebote. Acá la rodada es un descenso por el gradiente en pasos fijos de 0.12 celdas, sin
    inercia: se frena en el fondo de un valle o de un cráter aunque venga con envión. Precio,
    radio, factor de potencia (1: sale con la potencia entera) y tope de 60 celdas son números de este juego (`WEAPONS.roller`).
  - **Escudo propio.** En el original el escudo es una esfera con energía que desvía o absorbe
    proyectiles. Acá es una carga: absorbe un tiro entero y se gasta (`resolveTurn3D`).
  - **Quema propia.** El original tiene napalm (`WeaponNapalm.cpp`) que corre cuesta abajo y
    quema por tiempo real. Acá es un disco fijo donde cayó el tiro y el reloj es el turno: quema al
    que empieza su turno adentro. Precio, radio (5) y daño por turno (25) son números de este juego
    (`WEAPONS.napalm`).
  - **El Bombazo pasa el escudo** y se vende de a 1 (el original lo vende de a 2). El radio (18) y el
    precio por unidad son los del original.
  - **La Tierra no entierra** y se vende de a 1 (el original vende la Dirt Ball de a 5). En el
    original la tierra tapa al tanque ("can be used to cover them"); acá el tanque que quedó debajo
    sube con la loma y queda apoyado arriba, y el escudo ni la frena ni se gasta. El radio (10) y el
    precio por unidad son los del original.
  - **Racimo propio.** Del MIRV del original quedan la apertura en la cima, las 5 cabezas, la que
    sigue el tiro apuntado y el armslevel. Lo demás es de este juego (`WEAPONS.mirv`, `mirv.ts`):
    - *Cómo se abren.* En el original las otras cuatro salen en fila a lo largo del tiro
      (`<vspreaddist>`: distinta velocidad vertical) con un desvío de costado al azar
      (`<hspreaddist>`). Acá no hay azar y el racimo cae siempre del mismo tamaño: en X, a 7 celdas
      de la del medio. Así el server, la fantasma y los tests hacen la misma cuenta.
    - *Cabezas chicas.* En el original cada cabeza explota y abre cráter con radio 6 (un Misil cada
      una). Acá explota con radio 4.5 y el cráter es de radio 2, los números del Rodillo: con
      cráteres de 6 las cinco abrían un solo hoyo grande.
    - *Precio.* El original lo vende de a 3 por $16.000 ($5.333 c/u). Acá se vende de a 1 a $2.500,
      porque las cabezas son más chicas.
    - *Escudo.* Absorbe una sola cabeza.
  - **Rebote propio.** El original tiene un Leap Frog (`src/common/weapons/WeaponLeapFrog.cpp`). Acá
    quedó la idea, un tiro que toca el piso y sigue, y lo demás es de este juego (`WEAPONS.leapfrog`,
    `bounce.ts`): pica una sola vez, donde pica no explota, sale con la mitad de la velocidad y el
    precio y el pack de 2 son propios. Ningún número se tomó del XML del original.
  - **La loma no deja escalón.** El original le suma la altura del perfil a toda celda que esté
    por debajo de la esfera y no toca las demás: en una ladera, la celda que subió queda varios
    metros arriba de la de al lado, que no se tocó. Acá la celda que sube no pasa de la esfera
    (`applyMoundTerrain`). En piso llano las dos reglas dan la misma loma.
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
- **Ocho armas jugables** (Chispa, Misil, Rodillo, Quema, Bombazo, Tierra, Racimo y Rebote). La Baby Nuke es solo datos.
- **RNG propio** (mulberry32) en lugar del `RandomGenerator` del original: lo que importa es que
  la misma semilla dé el mismo terreno en el server y en los tests.

## Fuera de alcance por ahora

Baby Nuke, sonido nuevo, cuentas, base de datos, matchmaking, una segunda cámara y deploy. No se
portó nada de OpenGL, wxWidgets, SDL ni Lua del original: el render es Three.js escrito de cero.
El que no tiene el turno ve el cañón ajeno en el último ángulo que
disparó, no moviéndose en vivo.
