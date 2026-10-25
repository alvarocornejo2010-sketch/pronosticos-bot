// Los avisos de Mis equipos de punta a punta (worker/avisos.js), contra el Worker local
// ya lleno y el servicio de avisos de mentira de api_falsa.py (/push/<id>): unos
// navegadores de mentira (cada uno con su par de claves) se suscriben con sus equipos;
// el cron pone en cola y manda un aviso antes de cada partido de esos equipos (aquí,
// con AVISO_ANTES_MIN de dos semanas, los de toda la semana) y otro con el resultado;
// cada aviso se descifra con la clave del navegador y se comprueba su firma VAPID, sus
// cabeceras y su texto (los mismos enteros que la web). Y: una suscripción que el
// servicio da por terminada (410) se borra; un partido no se avisa dos veces; las altas
// raras no entran; la baja pide la clave auth; el panel de visitas lo cuenta; y ninguna
// pasada de los avisos se pasa de CPU.
// Uso: node pruebas/avisos.mjs PUERTO_WORKER PUERTO_INSPECTOR PUERTO_API DIR_D1 LOG_WRANGLER TOKEN MAX_MS
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { b64u, deB64u } from "../worker/push.js";
import { enterosQueSuman } from "../worker/compartir.js";
import { favoritoDe } from "../worker/registro.js";
import { descifrar } from "./push_descifrar.mjs";
import { Perfilador } from "./cpu_isolate.mjs";

const [pW, pIns, pApi, dirD1, log, token, maxMs] = process.argv.slice(2);
const W = `http://127.0.0.1:${pW}`, API = `http://127.0.0.1:${pApi}`;
const get = async (ruta) => (await fetch(W + ruta)).json();
const post = (ruta, cuerpo, cab = {}) => fetch(W + ruta, { method: "POST",
  headers: { "Content-Type": "application/json", ...cab }, body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) });
const texto = (bytes) => new TextDecoder().decode(bytes);

// la D1 local de wrangler dev
const buscar = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? buscar(join(dir, e.name)) : [join(dir, e.name)]);
const bases = buscar(dirD1).filter((f) => f.endsWith(".sqlite") && f.includes("D1DatabaseObject") && !f.includes("metadata"));
assert.equal(bases.length, 1, String(bases));
const db = new DatabaseSync(bases[0]);
db.exec("PRAGMA busy_timeout = 5000");   // el Worker escribe en la misma base
const resumen = () => JSON.parse(db.prepare("SELECT valor FROM documentos WHERE clave = 'avisos_resumen'").get()?.valor ?? "null");

// 1. la clave pública: la crea la primera petición y luego es siempre la misma
const { disponible, clave } = await get("/api/avisos");
assert.equal(disponible, true);
assert.equal(deB64u(clave).length, 65);
assert.equal((await get("/api/avisos")).clave, clave);
console.log("clave VAPID: la crea el Worker la primera vez y la guarda");

// 2. los equipos: A, el que más juega en la ventana; B, el que más juega sin cruzarse con A.
// Así hay avisos de sobra para varias pasadas a cualquier hora (el domingo por la tarde, al
// primer equipo de la semana ya casi no le quedaban partidos)
const estado = await get("/api/estado");
const todos = estado.dias.flatMap((d) => d.partidos).filter((p) => p.prob_local !== undefined);
const porId = new Map(todos.map((p) => [p.id, p]));
const juegos = (eq) => todos.filter((p) => p.local === eq || p.visita === eq);
const masJuega = (lista) => lista.map((e) => [e, juegos(e).length]).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
const A = masJuega(todos.map((p) => p.local));
const conA = new Set(juegos(A).flatMap((p) => [p.local, p.visita]));
const B = masJuega(todos.filter((p) => !conA.has(p.local) && !conA.has(p.visita)).map((p) => p.visita));
const conB = new Set(juegos(B).flatMap((p) => [p.local, p.visita]));
const C = todos.find((p) => ![p.local, p.visita].some((e) => conA.has(e) || conB.has(e))).local;

const EC = { name: "ECDH", namedCurve: "P-256" };
async function navegador(id, equipos) {
  const par = await crypto.subtle.generateKey(EC, true, ["deriveBits"]);
  return { id, endpoint: `${API}/push/${id}`, equipos, privada: par.privateKey,
    p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey))),
    auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}
const datosAlta = (n) => ({ endpoint: n.endpoint, p256dh: n.p256dh, auth: n.auth, equipos: n.equipos });
const s1 = await navegador("s1", [A]);
const s2 = await navegador("s2", [B, "Un equipo que no existe"]);
const s3 = await navegador("gone-s3", [A]);   // el servicio responde 410: el navegador ya la quitó
const s4 = await navegador("s4", []);
const navs = [s1, s2, s3, s4];

// 3. las altas raras no entran
const malas = [
  [{ ...datosAlta(s1), endpoint: "https://evil.example/push/x" }, 400, "un servicio que no es de un navegador"],
  [{ ...datosAlta(s1), endpoint: "http://127.0.0.1:1/push/x" }, 400, "otro servicio local"],
  [{ ...datosAlta(s1), p256dh: b64u(Uint8Array.of(4, ...new Uint8Array(64))) }, 400, "una clave que no es un punto de la curva"],
  [{ ...datosAlta(s1), auth: "corta" }, 400, "un auth que no son 16 bytes"],
  ["no es json", 400, "un cuerpo que no es JSON"],
];
for (const [cuerpo, st, que] of malas) assert.equal((await post("/api/avisos/alta", cuerpo)).status, st, que);
assert.equal((await post("/api/avisos/alta", datosAlta(s1), { Origin: "https://otra.web" })).status, 403);
assert.equal((await fetch(W + "/api/avisos/alta")).status, 405);
assert.equal((await post("/api/avisos", datosAlta(s1))).status, 405);
for (const n of navs) assert.equal((await post("/api/avisos/alta", datosAlta(n))).status, 200, n.id);
assert.equal(db.prepare("SELECT count(*) AS n FROM suscripciones").get().n, 4);
assert.ok(resumen().proximo <= Date.now());   // el alta pide mirar en el próximo minuto
console.log("altas: 4 navegadores; otra web, otro servicio, claves malas o un cuerpo raro, no");

// 4. el cron: pone en cola y manda, de MAX_ENVIOS_PASADA en MAX_ENVIOS_PASADA
const perf = await Perfilador.conectar(pIns);
let vistas = readFileSync(log, "utf8").length;
const ticks = [];
async function tick() {
  const { ms } = await perf.medir(W + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*");
  let r = null;
  for (let i = 0; i < 20 && !r; i++) {   // la línea del log puede llegar un poco después
    const nuevo = readFileSync(log, "utf8").slice(vistas);
    const m = nuevo.match(/\{"tarea":"[^\n]*\}/);
    if (m) { r = JSON.parse(m[0]); vistas += nuevo.indexOf(m[0]) + m[0].length; }
    else await new Promise((ok) => setTimeout(ok, 50));
  }
  ticks.push({ tarea: r && r.tarea, ms });
  return r;
}
const recibidos = async () => (await fetch(API + "/__push")).json();
const esperados = new Map();   // "s1|123|previo"
for (const n of navs) for (const eq of n.equipos) for (const p of juegos(eq)) esperados.set(`${n.id}|${p.id}|previo`, p);
for (let i = 0; i < 40; i++) {
  await tick();
  const r = resumen();
  if (r.cola === 0 && r.proximo > Date.now() && (await recibidos()).length >= esperados.size) break;
}
const avisosTicks = ticks.filter((t) => t.tarea === "avisos");
// de 3 en 3 (MAX_ENVIOS_PASADA en e2e.sh): hacen falta varias pasadas
assert.ok(esperados.size > 3, `solo ${esperados.size} avisos: no se prueba el reparto en pasadas`);
assert.ok(avisosTicks.length >= Math.ceil(esperados.size / 3), JSON.stringify(ticks));

// 5. lo que llegó: cada aviso descifrado, con su firma, sus cabeceras y su texto
async function abrir(a) {
  const n = navs.find((x) => x.id === a.id);
  const msg = JSON.parse(await descifrar(deB64u(a.cuerpo), n.privada, n.p256dh, n.auth));
  const c = a.cabeceras;
  const m = c.Authorization.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, c.Authorization);
  assert.equal(m[4], clave);
  const jwt = JSON.parse(texto(deB64u(m[2])));
  assert.equal(jwt.aud, API);
  assert.ok(jwt.exp > Date.now() / 1000 && jwt.exp <= Date.now() / 1000 + 24 * 3600, String(jwt.exp));
  assert.match(jwt.sub, /^https:\/\//);
  const pub = await crypto.subtle.importKey("raw", deB64u(clave), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, deB64u(m[3]),
    new TextEncoder().encode(m[1] + "." + m[2])), "firma VAPID");
  assert.equal(c["Content-Encoding"], "aes128gcm");
  assert.equal(c.Topic, msg.tag);
  return { n, msg, c, p: porId.get(Number(msg.tag.slice(1))) };
}
const nombres = (p) => [p.local_corto || p.local, p.visita_corto || p.visita];
const reparto = (p) => {
  const [l, x, v] = enterosQueSuman([p.prob_local, p.prob_empate, p.prob_visita]);
  const [nl, nv] = nombres(p);
  return `${nl} ${l} % · empate ${x} % · ${nv} ${v} %`;
};
const llegados = new Set();
for (const a of (await recibidos()).filter((x) => !x.id.startsWith("gone"))) {
  const { n, msg, c, p } = await abrir(a);
  const [nl, nv] = nombres(p);
  assert.equal(msg.titulo, `${nl} – ${nv}`);
  assert.ok(msg.cuerpo.includes(`a las ${p.hora} (hora de Lima) · ${p.liga}. ${reparto(p)}.`), msg.cuerpo);
  assert.equal(msg.url, `/partido/${p.id}`);
  assert.equal(c.Urgency, "high");
  const ttl = Number(c.TTL);
  assert.ok(ttl > 0 && ttl <= (Date.parse(p.utcDate) - Date.now()) / 1000 + 120, `TTL ${ttl}`);
  const k = `${n.id}|${p.id}|previo`;
  assert.ok(esperados.has(k) && !llegados.has(k), k);   // ni de más ni dos veces
  llegados.add(k);
}
const faltan = [...esperados.keys()].filter((k) => !k.startsWith("gone") && !llegados.has(k));
assert.deepEqual(faltan, []);
assert.equal(db.prepare("SELECT count(*) AS n FROM suscripciones WHERE endpoint LIKE '%gone%'").get().n, 0);
assert.equal(db.prepare("SELECT count(*) AS n FROM envios").get().n, 0);
console.log(`antes del partido: ${llegados.size} avisos (${juegos(A).length} partidos de ${A}, ${juegos(B).length} de ${B}),`
  + ` cifrados para cada navegador y firmados; con el texto y los enteros de la web; ${avisosTicks.length} pasadas`);
console.log("410: la suscripción que el navegador ya quitó se borra, con lo que tenía en cola");

// 6. más estrellas: solo los partidos nuevos; los ya avisados no se repiten
const antes = (await recibidos()).length;
s1.equipos = [A, C];
assert.equal((await post("/api/avisos/alta", datosAlta(s1))).status, 200);
for (let i = 0; i < 10; i++) { await tick(); if (resumen().cola === 0 && resumen().proximo > Date.now()) break; }
const nuevos = (await recibidos()).slice(antes);
const deC = new Set(juegos(C).map((p) => p.id));
assert.equal(nuevos.length, deC.size, JSON.stringify(nuevos.map((x) => x.id)));
for (const a of nuevos) assert.ok(deC.has(Number((await abrir(a)).msg.tag.slice(1))));
console.log(`otra estrella: llegan los ${deC.size} partidos de ${C}, y ninguno de los ya avisados`);

// 7. el resultado: el del primer partido de A, para s1
const p1 = juegos(A)[0];
db.prepare("INSERT INTO resultados (id, liga, utc, gl, gv, contado, liquidado) VALUES (?, ?, ?, 2, 1, 1, ?)")
  .run(p1.id, p1.liga_codigo, p1.utcDate, Date.now());
db.prepare("UPDATE documentos SET valor = json_set(valor, '$.proximo', 0) WHERE clave = 'avisos_resumen'").run();
const antesFinal = (await recibidos()).length;
for (let i = 0; i < 10; i++) { await tick(); if ((await recibidos()).length > antesFinal && resumen().cola === 0) break; }
const finales = (await recibidos()).slice(antesFinal);
assert.equal(finales.length, 1, JSON.stringify(finales.map((x) => x.id)));
const f = await abrir(finales[0]);
const [nl, nv] = nombres(p1);
assert.equal(f.n.id, "s1");
assert.equal(f.msg.titulo, `Final: ${nl} 2-1 ${nv}`);
const fav = favoritoDe(p1)[0];
const veredicto = fav === "1" ? "Acertó el favorito." : fav === "X" ? "Sorpresa: lo más probable era el empate."
  : `Sorpresa: el favorito era ${nv}.`;
assert.equal(f.msg.cuerpo, `La web daba ${reparto(p1)}. ${veredicto}`);
assert.equal(f.msg.tag, `p${p1.id}`);   // sustituye al de antes del partido
assert.equal(f.c.Urgency, "normal");
console.log(`resultado: «${f.msg.titulo}», ${veredicto[0].toLowerCase() + veredicto.slice(1)}`);
for (let i = 0; i < 3; i++) await tick();
assert.equal((await recibidos()).length, antesFinal + 1);   // ni el resultado ni nada se repite
db.prepare("DELETE FROM resultados WHERE id = ?").run(p1.id);

// 8. la baja: con su auth; con otra, no
assert.equal((await post("/api/avisos/baja", { endpoint: s2.endpoint, auth: s1.auth })).status, 200);
assert.equal(db.prepare("SELECT count(*) AS n FROM suscripciones WHERE endpoint = ?").get(s2.endpoint).n, 1);
assert.equal((await post("/api/avisos/baja", { endpoint: s2.endpoint, auth: s2.auth })).status, 200);
assert.equal(db.prepare("SELECT count(*) AS n FROM suscripciones WHERE endpoint = ?").get(s2.endpoint).n, 0);
assert.equal((await post("/api/avisos/baja", { endpoint: s2.endpoint, auth: s2.auth }, { Origin: "https://otra.web" })).status, 403);
console.log("baja: solo con la clave auth del navegador, y no desde otra web");

// 9. el panel de visitas lo cuenta
const v = await get(`/api/visitas?token=${token}`);
const total = llegados.size + deC.size;
assert.deepEqual({ ...v.avisos }, { total: 2, con_equipos: 1, nuevas: 4, previo: total, final: 1, fallo: 0,
  caducado: 0, baja: 1 });
console.log(`panel: 2 suscripciones que quedan, 4 altas, ${total} avisos antes del partido, 1 con el resultado, 1 baja por 410`);

// 10. la CPU de cada pasada de los avisos, como la cuenta Cloudflare
const ms = avisosTicks.map((t) => t.ms);
console.log(`CPU de las pasadas de avisos: máx ${Math.max(...ms)} ms, media ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)}`);
assert.ok(Math.max(...ms) <= Number(maxMs), JSON.stringify(ticks));
perf.cerrar();
db.close();
console.log("avisos: OK");
process.exit(0);   // la conexión con el inspector no deja salir sola a node
