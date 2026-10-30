// El resumen de la semana del registro en vivo (worker/registro.js) y los textos de
// la tarjeta para compartir (worker/compartir.js), sin red ni D1.
// Uso: node pruebas/semana.mjs
import assert from "node:assert/strict";
import { Registro, rehacerDias, rehacerVersiones, favoritoDe, DIAS_RESUMEN } from "../worker/registro.js";
import { enterosQueSuman, textosPartido, etiquetasOg, paginaPartido } from "../worker/compartir.js";
import { Reloj } from "../worker/tiempo.js";
import { VERSION_MODELO } from "../worker/config.js";

const reloj = new Reloj("America/Lima");
let n = 0;
const ficha = (utc, pl, px, pv, extra = {}) => ({
  id: ++n, utcDate: utc, liga_codigo: "PD", liga: "La Liga", local: `Local ${n}`, visita: `Visita ${n}`,
  local_corto: null, visita_corto: null, prob_local: pl, prob_empate: px, prob_visita: pv, prob_mas_25: 50, prob_ambos: 50,
  ...extra,
});
// como liquidar: la ficha publicada, el marcador, la media de la liga y la hora de Lima
const anotar = (r, f, gl, gv) =>
  r.anotar(f, gl, gv, { avg_local: 1.5, avg_visita: 1.2 }, reloj.local(Date.parse(f.utcDate)));

// el favorito, como veredictoDe de la web: el mayor; si empatan, el primero
assert.deepEqual(favoritoDe({ prob_local: 40, prob_empate: 20, prob_visita: 40 }), ["1", 40]);
assert.deepEqual(favoritoDe({ prob_local: 30, prob_empate: 36, prob_visita: 34 }), ["X", 36]);

const r = new Registro(null);
assert.deepEqual(r.dias, {});
anotar(r, ficha("2026-10-20T19:00:00Z", 70, 20, 10), 2, 0);   // claro, acierta
anotar(r, ficha("2026-10-20T21:00:00Z", 86, 9, 5), 1, 2);     // claro, falla: la sorpresa
anotar(r, ficha("2026-10-20T23:00:00Z", 65, 20, 15), 0, 1);   // claro, falla (menos claro)
anotar(r, ficha("2026-10-21T01:00:00Z", 50, 25, 25), 1, 1);   // 20:00 en Lima: aún el 20; medio, falla
anotar(r, ficha("2026-10-21T15:00:00Z", 38, 30, 32), 1, 0);   // reñido, acierta
const d20 = r.dias["2026-10-20"];
assert.equal(d20.n, 4);
assert.equal(d20.ac, 1);
assert.equal(d20.esp, 2.71);
assert.deepEqual(d20.tramos, { claros: [3, 1, 2.21], medios: [1, 0, 0.5] });
assert.equal(d20.sorpresa.prob_local, 86);
assert.equal(d20.sorpresa.gl, 1);
assert.deepEqual(r.dias["2026-10-21"].tramos, { renidos: [1, 1, 0.38] });
// el tramo, con el entero que enseña la web: 59.6 sale como 60 y cuenta en los claros
const borde = new Registro(null);
anotar(borde, ficha("2026-10-20T19:00:00Z", 59.6, 20.2, 20.2), 1, 0);
anotar(borde, ficha("2026-10-20T21:00:00Z", 44.6, 30.2, 25.2), 0, 0);
assert.deepEqual(Object.keys(borde.dias["2026-10-20"].tramos).sort(), ["claros", "medios"]);
console.log("por día: aciertos, lo esperado, los tramos (con el entero de la web) y la sorpresa, en el día de Lima");

// solo se guardan DIAS_RESUMEN días, y publico() da los 14 últimos en orden
for (let i = 0; i < 30; i++) {
  anotar(r, ficha(new Date(Date.parse("2026-10-22T15:00:00Z") + i * 86400000).toISOString(), 60, 25, 15), 1, 0);
}
const fechas = Object.keys(r.dias).sort();
assert.equal(fechas.length, DIAS_RESUMEN);
assert.equal(fechas[fechas.length - 1], "2026-11-20");
const pub = r.publico("2026-11-20T20:00:00Z");
assert.equal(pub.semana.length, 14);
assert.equal(pub.semana[13].fecha, "2026-11-20");
assert.ok(pub.semana.every((d, i) => i === 0 || pub.semana[i - 1].fecha < d.fecha));
assert.ok(!("semana" in JSON.parse(JSON.stringify(r))) && "dias" in JSON.parse(JSON.stringify(r)));
console.log(`se guardan ${DIAS_RESUMEN} días; la web recibe los 14 últimos, en orden`);

// un registro de antes (sin dias) se rehace con lo ya liquidado, una vez
const viejo = new Registro({ desde: null, desde_fecha: null, hasta: null, total: null, ligas: {}, ultimos: [] });
assert.equal(viejo.dias, null);
const f1 = ficha("2026-10-21T19:00:00Z", 75.5, 15.2, 9.3);
const filas = [{ gl: 3, gv: 1, utc: f1.utcDate, ...Object.fromEntries(Object.entries(f1).map(([k, v]) => ["c_" + k, v])) }];
let consulta = null;
const almacen = {
  db: { prepare: (sql) => ({ bind: (...a) => { consulta = { sql, a }; return { all: async () => ({ results: filas }) }; } }) },
  consultar: (fn) => fn(),
};
await rehacerDias(viejo, almacen, reloj, Date.parse("2026-10-23T12:00:00Z"));
assert.match(consulta.sql, /r\.contado = 1/);
assert.equal(consulta.a[0], "2026-10-02T12:00:00Z");
assert.deepEqual(viejo.dias["2026-10-21"].tramos, { claros: [1, 1, 0.755] });
console.log("un registro de antes se rehace con resultados y predicciones");

// cada versión del modelo con sus cuentas: las fichas llevan su versión y su media
const media = { media_local: 1.52, media_visita: 1.18 };
const fv = (utc, v, pl, px, pv) => ficha(utc, pl, px, pv, { ...media, version_modelo: v, prob_mas_25: 40 + v, prob_ambos: 55 - v });
const jugados = [
  [fv("2026-10-18T15:00:00Z", 2, 60, 25, 15), 2, 0], [fv("2026-10-19T15:00:00Z", 2, 30, 30, 40), 0, 0],
  [fv("2026-10-23T15:00:00Z", 3, 50, 25, 25), 1, 2], [fv("2026-10-24T15:00:00Z", 3, 70, 20, 10), 3, 1],
  [fv("2026-10-25T20:00:00Z", 4, 45, 28, 27), 1, 1], [fv("2026-10-26T15:00:00Z", 4, 64, 22, 14), 2, 1],
  [fv("2026-10-26T17:00:00Z", 4, 35, 30, 35), 0, 1],
];
const nuevo = new Registro(null);
for (const [f, gl, gv] of jugados) anotar(nuevo, f, gl, gv);
let pv = nuevo.publico("2026-10-27T00:00:00Z");
assert.equal(pv.version_actual, VERSION_MODELO);
assert.deepEqual(pv.versiones.map((x) => [x.version, x.partidos, x.desde_fecha]), [[4, 3, "2026-10-25"], [3, 2, "2026-10-23"], [2, 2, "2026-10-18"]]);
assert.equal(pv.versiones.reduce((s, x) => s + x.partidos, 0), pv.partidos);
assert.ok(pv.versiones.every((x) => typeof x.skill_score === "number" && "mas_25" in x.mercados && "ambos" in x.mercados));
// sin versión en la ficha: la 1, como en la validación
const sinV = new Registro(null);
anotar(sinV, ficha("2026-10-20T15:00:00Z", 50, 30, 20), 1, 0);
assert.deepEqual(Object.keys(sinV.versiones), ["1"]);
// lo guardado y vuelto a leer da lo mismo
assert.deepEqual(new Registro(JSON.parse(JSON.stringify(nuevo))).publico("x").versiones, pv.versiones);
console.log("versiones: cada una con sus partidos, su skill y desde cuándo; la de ahora primero");

// un registro de antes (sin versiones) las rehace por partes, en el orden en que se liquidó
// cada partido, y mientras tanto ni las publica ni suma ahí los nuevos: los lee una parte siguiente
const liquidados = jugados.slice(0, 6).map(([f, gl, gv], i) => ({ gl, gv, liquidado: 1000 + (i < 3 ? 0 : i), id: f.id, utc: f.utcDate,
  ...Object.fromEntries(Object.entries(f).map(([k, v]) => ["c_" + k, v])) }));
const tabla = [...liquidados];
const almacenV = {
  db: { prepare: (sql) => ({ bind: (liq, id, parte) => ({ all: async () => ({ results: tabla
    .filter((x) => x.liquidado > liq || (x.liquidado === liq && x.id > id))
    .sort((a, b) => a.liquidado - b.liquidado || a.id - b.id).slice(0, parte) }) }) }) },
  consultar: (fn) => fn(),
};
const antes = new Registro({ desde: null, desde_fecha: null, hasta: null, total: null, ligas: {}, ultimos: [], dias: {} });
assert.deepEqual(antes.rehaciendo, [0, 0]);
for (const [f, gl, gv] of jugados.slice(0, 6)) anotar(antes, f, gl, gv);   // lo que ya contaba antes
assert.deepEqual(antes.versiones, {});
await rehacerVersiones(antes, almacenV, reloj, 4);
assert.deepEqual(antes.rehaciendo, [1003, liquidados[3].id]);
assert.deepEqual(antes.publico("x").versiones, []);
// un partido que se liquida a medias: no se suma a su versión ahora...
const [f7, gl7, gv7] = jugados[6];
anotar(antes, f7, gl7, gv7);
assert.equal(Object.values(antes.versiones).reduce((s, x) => s + x.total.modelo.n, 0), 4);
tabla.push({ gl: gl7, gv: gv7, liquidado: 2000, id: f7.id, utc: f7.utcDate,
  ...Object.fromEntries(Object.entries(f7).map(([k, v]) => ["c_" + k, v])) });
// ...sino en la parte siguiente (guardado y vuelto a leer, como en otra pasada), que
// termina porque trae menos de 4: las mismas cuentas que si se hubieran sumado una a una
const siguiente = new Registro(JSON.parse(JSON.stringify(antes)));
assert.deepEqual(siguiente.rehaciendo, antes.rehaciendo);
await rehacerVersiones(siguiente, almacenV, reloj, 4);
assert.equal(siguiente.rehaciendo, null);
assert.deepEqual(siguiente.publico("x").versiones, pv.versiones);
console.log("un registro de antes rehace sus versiones por partes y no cuenta nada dos veces");

// la tarjeta: los mismos enteros que la web, y todo escapado
assert.deepEqual(enterosQueSuman([54.4, 23.4, 22.2]), [55, 23, 22]);
const t = textosPartido({ local: "FC Internazionale Milano", local_corto: "Inter", visita: "Shakhtar <b>", liga: "Champions League",
  utcDate: "2026-10-22T19:00:00Z", prob_local: 86.04, prob_empate: 8.93, prob_visita: 5.03, prob_mas_25: 73.2 }, reloj);
assert.equal(t.titulo, "Inter – Shakhtar <b>");
assert.equal(t.descripcion, "Champions League · jue 22 oct, 14:00 (hora de Lima). Inter 86 % · empate 9 % · Shakhtar <b> 5 %."
  + " Más de 2.5 goles: 73 %.");
const og = etiquetasOg("https://x.workers.dev", "/partido/7", t.titulo, t.descripcion);
// la página de un partido: un "$'" en un nombre no es un patrón de reemplazo, y uno
// que no existe sale con la tarjeta de siempre y fuera de Google
const env = { ASSETS: { fetch: async () => new Response("<head><!-- og --><title>x</title><!-- /og --></head><body>cola</body>",
  { headers: { "Content-Type": "text/html", ETag: "1" } }) } };
const conFila = (fila) => ({ db: { prepare: () => ({ bind: () => ({ first: async () => fila }) }) }, consultar: (fn) => fn() });
const raro = JSON.stringify({ local: "A$'B", visita: "C$&D", liga: "L", utcDate: "2026-10-22T19:00:00Z" });
const pag = await paginaPartido(new Request("https://x.dev/partido/1"), env, conFila({ f: raro }), 1);
const cuerpo = await pag.text();
assert.ok(cuerpo.includes("<title>A$&#39;B – C$&amp;D: pronóstico y probabilidades</title>") && cuerpo.endsWith("</head><body>cola</body>"), cuerpo);
assert.ok(!pag.headers.has("X-Robots-Tag") && !pag.headers.has("ETag"));
const nadie = await paginaPartido(new Request("https://x.dev/partido/2"), env, conFila(null), 2);
assert.ok((await nadie.text()).includes("<title>x</title>") && nadie.headers.get("X-Robots-Tag") === "noindex");
assert.ok(og.includes("Shakhtar &lt;b&gt;") && !og.includes("<b>"));
assert.ok(og.includes('content="https://x.workers.dev/og.png"') && og.includes('content="https://x.workers.dev/partido/7"'));
assert.ok(og.startsWith("<!-- og -->") && og.endsWith("<!-- /og -->"));
assert.ok(og.includes('<meta name="description" content="Champions League · jue 22 oct')
  && og.includes('<link rel="canonical" href="https://x.workers.dev/partido/7">'));
const sin = textosPartido({ local: "A", visita: "B", liga: "La Liga", utcDate: "2026-10-25T01:30:00Z" }, reloj);
assert.equal(sin.descripcion, "La Liga · sáb 24 oct, 20:30 (hora de Lima). Pronóstico en cálculo.");
console.log("tarjeta: 1X2 como en la web, hora de Lima y nombres escapados");
console.log("semana: OK");
