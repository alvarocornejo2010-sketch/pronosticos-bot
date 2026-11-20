// Lo que apunta el Worker para la vigilancia (/salud), sin red: desde cuándo falla el CSV
// de tiros a puerta de una liga (obtenerTirosLiga, worker/actualizacion.js). El primer
// fallo lo fecha, los reintentos que fallan no mueven esa fecha y una descarga buena la
// quita. /salud y el aviso de GitHub, de punta a punta, en pruebas/salud.py.
// Uso: node pruebas/salud.mjs
import assert from "node:assert/strict";
import { Contexto, obtenerTirosLiga } from "../worker/actualizacion.js";
import { Cache } from "../worker/almacen.js";
import { HORAS_REINTENTO_TIROS } from "../worker/config.js";
import { Reloj } from "../worker/tiempo.js";

const reloj = new Reloj("America/Lima");
const cache = new Cache();
const CSV = "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HST,AST\nE0,15/08/2026,Arsenal,Chelsea,2,1,6,3\n";
let pedidas = 0;
// cada pasada, un contexto nuevo con la misma caché, como en el cron
const pasada = (respuesta) => new Contexto({ reloj, cache, almacen: null, ajustes: { tirosBase: "http://tiros.invalid" },
  api: { bytes: 0, pesada: false, fetch: async () => { pedidas++; return respuesta; } } });
const falla = { status: 503, text: async () => "" };
const buena = { status: 200, text: async () => CSV };
const hace = (entrada, horas) => { entrada.actualizado = reloj.iso(Date.now() - horas * 3600000); };

// el primer fallo se apunta con su fecha
let e = await obtenerTirosLiga(pasada(falla), "PL", 2026, "actual");
assert.equal(e.fallo, true);
assert.equal(e.fallando_desde, e.actualizado);
const desde = "2026-11-01T10:00:00.000-05:00";
e.fallando_desde = desde;

// antes de HORAS_REINTENTO_TIROS no se vuelve a pedir
assert.equal(await obtenerTirosLiga(pasada(falla), "PL", 2026, "actual"), e);
assert.equal(pedidas, 1);

// el reintento que falla deja la fecha del primero
hace(e, HORAS_REINTENTO_TIROS + 1);
e = await obtenerTirosLiga(pasada(falla), "PL", 2026, "actual");
assert.equal(pedidas, 2);
assert.equal(e.fallo, true);
assert.equal(e.fallando_desde, desde);
assert.notEqual(e.actualizado, desde);

// y una descarga buena la quita
hace(e, HORAS_REINTENTO_TIROS + 1);
e = await obtenerTirosLiga(pasada(buena), "PL", 2026, "actual");
assert.equal(pedidas, 3);
assert.equal(e.fallo, undefined);
assert.equal(e.fallando_desde, undefined);
assert.equal(cache.get("tiros_filas", "PL:actual").length, 1);

// un fallo nuevo, tras una buena, empieza su propia cuenta
hace(e, 24 * 30);
e = await obtenerTirosLiga(pasada(falla), "PL", 2026, "actual");
assert.equal(e.fallando_desde, e.actualizado);
// y lo que se había bajado se queda
assert.equal(cache.get("tiros_filas", "PL:actual").length, 1);

console.log("vigilancia: un CSV de tiros que falla lleva la fecha del primer fallo hasta que vuelve a bajar");
