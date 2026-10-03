// SPDX-License-Identifier: GPL-2.0-or-later
// Constantes de reglas tomadas de Scorched3D (c) 2000-2011, GPL-2.0-or-later.
// Árbol de referencia: https://github.com/bberberov/scorched3d (rama `core`).
//
// Unidades usadas en todo el paquete:
//   wu   = world unit. 1 wu = 1 celda del heightmap (eje x) y 1 unidad de altura (eje y).
//   tick = un paso de integración del proyectil. El original integra por pasos fijos,
//          no por dt: cada paso suma la fuerza a la velocidad y velocidad/100 a la posición.
//   vu   = "velocity unit" del original. Posición avanza vu * VELOCITY_TO_POSITION wu por tick.
//   $    = plata (enteros).
//   hp   = puntos de vida (0..TANK_MAX_LIFE).
//
// Lectura de los literales del original: `fixed(true, N)` vale N / 10000
// (src/common/common/fixed.cpp, FIXED_RESOLUTION = 10000). Ej.: fixed(true, 25000) = 2.5.
// Verificado contra bberberov/scorched3d@core y osgamearchive/scorched3d@master:
// los dos repos tienen las mismas líneas en PhysicsParticleObject.cpp y TankLib.cpp.

// ---------------------------------------------------------------------------
// Tiro
// ---------------------------------------------------------------------------

/** Potencia máxima del tanque estándar. data/globalmods/none/data/tanktypes.xml <power>. [adimensional] */
export const POWER_MAX = 1000;

/**
 * vu por punto de potencia.
 * src/common/tank/TankLib.cpp getVelocityVector(): vector unitario, `diff /= 20; diff *= 1.2`.
 * src/common/simactions/PlayMovesSimAction.cpp: `velocity = newVelocity * (power + 1)`.
 */
export const POWER_TO_VELOCITY = 1.2 / 20; // [vu / potencia]

/** src/common/engine/PhysicsParticleObject.cpp simulate(): `position_ += velocity_ / 100`. [wu / (vu·tick)] */
export const VELOCITY_TO_POSITION = 1 / 100;

/** OptionsGame "Gravity", default -10 (rango -25..0). src/common/common/OptionsGame.cpp. [vu·FORCE_DIVISOR / tick] */
export const GRAVITY = -10;

/** PhysicsParticleObject::setForces(): `windFactor_ /= 70` (aplica a gravedad y viento). [adimensional] */
export const FORCE_DIVISOR = 70;

/**
 * PhysicsParticleObject::setForces(): `windDirection * windSpeed / fixed(true, 25000)`;
 * fixed(true, 25000) = 2.5, o sea viento * 0.4.
 */
export const WIND_SCALE = 1 / 2.5; // [vu·FORCE_DIVISOR / (tick · unidad de viento)]

/** src/common/engine/Wind.cpp newLevel(): la velocidad del viento va de 0 a 5. [unidad de viento] */
export const WIND_MAX = 5;

/**
 * Tiempo real que representa un tick, solo para animar en el cliente.
 * src/common/weapons/WeaponProjectile.cpp `stepSize_(true, 75)` = 0.0075 s,
 * escalado por OptionsGame "WeaponSpeed" default 15000 = 1.5 (ShotProjectile::init).
 */
export const STEP_SECONDS = 0.0075 * 1.5; // [s / tick]

/** Corte de seguridad: ningún tiro legal dura tanto (un tiro a 90° y potencia máxima dura ~840 ticks). [tick] */
export const MAX_SHOT_TICKS = 20_000;

/** src/common/tank/TankLib.cpp getGunPosition(): `gunLength = 1`. [wu] */
export const GUN_LENGTH = 1;

// ---------------------------------------------------------------------------
// Terreno
// ---------------------------------------------------------------------------

/** OptionsGame "MinimumLandHeight", default 0. Un cráter no baja de acá. [wu] */
export const MIN_LAND_HEIGHT = 0;

/** DeformLandscape: el radio entero se limita a 49 (`if (49 < iradius) iradius = 49`). [wu] */
export const CRATER_MAX_RADIUS = 49;

/** src/common/landscapemap/DeformLandscape.hpp flattenArea(..., size = 2). Medio ancho aplanado bajo un tanque que cae. [wu] */
export const FLATTEN_HALF_WIDTH = 2;

// ---------------------------------------------------------------------------
// Tanque y daño
// ---------------------------------------------------------------------------

/** data/globalmods/none/data/tanktypes.xml <life>100</life>. [hp] */
export const TANK_MAX_LIFE = 100;

/** src/common/target/TargetLife.cpp `size_(2, 2, 2)`: esfera de colisión de diámetro 2. [wu] */
export const TANK_SIZE = 2;

/** Radio de colisión del tanque (TargetLife::collisionDistance usa max(size)/2). [wu] */
export const TANK_RADIUS = TANK_SIZE / 2;

/** Daño máximo de una explosión, TargetDamageCalc::explosion(): `fixed damage = 100`. [hp] */
export const EXPLOSION_MAX_DAMAGE = 100;

/** TargetDamageCalc::explosion(): daño pleno dentro de radius/3. [adimensional] */
export const EXPLOSION_FULL_DAMAGE_FRACTION = 1 / 3;

/** TargetDamageCalc::explosion(): caída lineal sobre `radius * fixed(true, 6600)` = radius * 0.66. [adimensional] */
export const EXPLOSION_FALLOFF_FRACTION = 0.66;

/** src/common/actions/TargetFalling.cpp collision(): `damage = dist * 20`. [hp / wu] */
export const FALL_DAMAGE_PER_WU = 20;

/** OptionsGame "MinFallingDistance" default 5, "value is divided by 10". Caídas menores no dañan. [wu] */
export const MIN_FALL_DISTANCE = 5 / 10;

// ---------------------------------------------------------------------------
// Economía (src/common/common/OptionsGame.cpp, bloque "money")
// ---------------------------------------------------------------------------

/** "MoneyStarting" default 10000. [$] */
export const MONEY_START = 10_000;

/** src/common/tank/TankScore.cpp `static const int maxMoney = 999999`. [$] */
export const MONEY_MAX = 999_999;

/** "MoneyWonPerHitPoint" default 250, multiplicado por el armslevel del arma. [$ / armslevel] */
export const MONEY_PER_HIT_POINT = 250;

/** "MoneyWonPerKillPoint" default 750, multiplicado por el armslevel del arma. [$ / armslevel] */
export const MONEY_PER_KILL_POINT = 750;

/** "MoneyPerHealthPoint" default true: el premio se escala por (daño / 100). [bool] */
export const MONEY_PER_HEALTH_POINT = true;

/** "MoneyInterest" default 15 (%), aplicado al efectivo al final de cada ronda. [fracción / ronda] */
export const INTEREST_RATE = 15 / 100;

/** "MoneyPerRound" default 0: plata fija extra al final de cada ronda. [$ / ronda] */
export const MONEY_PER_ROUND = 0;

/** "MoneyWonForRound" default 5000: premio al ganador de la ronda. [$] */
export const MONEY_WON_FOR_ROUND = 5_000;

/** data/.../accessories.xml `<startingnumber>-1</startingnumber>`: munición infinita. */
export const INFINITE_AMMO = -1;
