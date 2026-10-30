// Lo que leen los buscadores sin JavaScript (compartir.js, equipos.js, ligas.js) y lo que
// el cron les manda por IndexNow (indexnow.js), sin Worker ni red: el texto de un
// partido, de un equipo y de una liga, con los enteros de la web, todo escapado y con sus
// enlaces; las marcas de index.html, una de cada; y las direcciones de IndexNow, todas la
// primera vez y luego solo lo nuevo, sin perder nada si la petición falla.
// Uso: node pruebas/paginas.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODIGOS, filaResultado, paginaConTarjeta, textoPartido, veredicto } from "../worker/compartir.js";
import { textoEquipo } from "../worker/equipos.js";
import { textosLiga } from "../worker/ligas.js";
import { avisarBuscadores, tocaIndexnow, HORAS_INDEXNOW } from "../worker/indexnow.js";
import { INDEXNOW_CLAVE } from "../worker/config.js";
import { Reloj } from "../worker/tiempo.js";

const reloj = new Reloj("America/Lima");
const ficha = {
  id: 7, local: "FC Internazionale Milano", local_corto: "Inter", visita: "Shakhtar <b>&", local_id: 108, visita_id: 0,
  liga: "Champions League", liga_codigo: "CL", utcDate: "2026-10-22T19:00:00Z", prob_local: 54.4, prob_empate: 23.4,
  prob_visita: 22.2, xg_local: 1.8, xg_visita: 0.95, prob_mas_25: 52.6, prob_ambos: 47.4,
  marcadores: [[1, 0, 11.6], [2, 1, 9.4], [1, 1, 9.2]],
};

// el partido: los enteros de la tabla (55, 23, 22), la doble oportunidad sumada de ellos,
// el veredicto de la web, todo escapado, y solo los enlaces que existen
const t = textoPartido(ficha, null, reloj);
assert.equal(t.h1, "Inter – Shakhtar <b>&: pronóstico");
assert.ok(t.html.includes("Quién gana: Inter 55 % · empate 23 % · Shakhtar &lt;b&gt;&amp; 22 %."), t.html);
assert.ok(t.html.includes("Doble oportunidad: 1X 78 % · X2 45 % · 12 77 %."));
assert.ok(t.html.includes("Goles esperados: Inter 1.80 · Shakhtar &lt;b&gt;&amp; 0.95."));
assert.ok(t.html.includes("Más de 2.5 goles: 53 % · ambos marcan: 47 %."));
assert.ok(t.html.includes("Marcadores más probables: 1–0 (12 %), 2–1 (9 %), 1–1 (9 %)."));
assert.ok(t.html.includes("<b>Favorito: Inter.</b> Sin ser claro. De cada 10 partidos así, gana unos 6."));
assert.ok(t.html.includes("jueves 22 de octubre de 2026, 14:00 (hora de Lima)"));
assert.ok(t.html.includes('<a href="/equipo/108">Inter</a>') && !t.html.includes("/equipo/0"));
assert.ok(t.html.includes('<a href="/liga/CL">Champions League</a>') && t.html.includes('<a href="/">'));
assert.ok(t.html.includes('<a href="/liga/CL">Todos los partidos de la Champions League</a>'));
assert.ok(!t.html.includes("<b>&") && !t.html.includes("Shakhtar <b>"));
assert.deepEqual(veredicto({ ...ficha, prob_local: 30, prob_empate: 36, prob_visita: 34 }),
  { titulo: "Partido parejo", frase: "Lo más probable es el empate, con 36 %." });
assert.deepEqual(veredicto({ ...ficha, prob_local: 70.2, prob_empate: 18, prob_visita: 11.8 }).titulo, "Favorito claro: Inter");
// con resultado: el marcador y si acertó, si lo publicado era de antes de empezar
const fin = textoPartido(ficha, { gl: 2, gv: 1, contado: 1 }, reloj).html;
assert.ok(fin.includes("<b>Final: Inter 2-1 Shakhtar &lt;b&gt;&amp;.</b> Acertó el favorito."), fin);
const sorpresa = textoPartido(ficha, { gl: 0, gv: 0, contado: 1 }, reloj).html;
assert.ok(sorpresa.includes("Sorpresa: el favorito era Inter."));
assert.ok(!textoPartido(ficha, { gl: 0, gv: 0, contado: 0 }, reloj).html.includes("Sorpresa"));
// sin predicción todavía, ni liga conocida
const sin = textoPartido({ id: 9, local: "A", visita: "B", liga: "Otra", liga_codigo: "XX", utcDate: ficha.utcDate }, null, reloj);
assert.ok(sin.html.includes("El pronóstico se está calculando") && !sin.html.includes("/liga/") && !sin.html.includes("/equipo/"));
console.log("partido: el texto de su detalle, con los enteros de la web, escapado y con sus enlaces");

// la página: las tres marcas cambiadas (un "$'" en un nombre no es un patrón de
// reemplazo); sin etiquetas (no existe), la de siempre y fuera de Google
const plantilla = "<head><!-- og --><title>x</title><!-- /og --></head><h1><!-- h1 -->Portada<!-- /h1 --></h1>"
  + "<div id=\"vista\"><!-- texto --><p>las ligas</p><!-- /texto --></div>";
const env = { ASSETS: { fetch: async () => new Response(plantilla, { headers: { "Content-Type": "text/html" } }) } };
const req = new Request("https://x.dev/partido/7");
const pag = await (await paginaConTarjeta(req, env, "<!-- og --><title>t</title><!-- /og -->",
  { h1: "A$'B <i>", html: "<div class=\"escrito\">C$&D</div>" })).text();
assert.equal(pag, "<head><!-- og --><title>t</title><!-- /og --></head><h1>A$&#39;B &lt;i&gt;</h1>"
  + "<div id=\"vista\"><div class=\"escrito\">C$&D</div></div>");
const nadie = await paginaConTarjeta(req, env, null, { h1: "no", html: "no" });
assert.equal(await nadie.text(), plantilla);
assert.equal(nadie.headers.get("X-Robots-Tag"), "noindex");
// index.html: cada marca una vez (una de más, en un comentario, se comería la página) y
// la portada enlaza con las páginas de todas las ligas
const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
for (const m of ["og", "/og", "h1", "/h1", "texto", "/texto"]) {
  assert.equal(index.split(`<!-- ${m} -->`).length - 1, 1, `<!-- ${m} --> tiene que salir una vez`);
}
const portada = index.slice(index.indexOf("<!-- texto -->"), index.indexOf("<!-- /texto -->"));
assert.deepEqual(new Set([...portada.matchAll(/href="\/liga\/([A-Z0-9]+)"/g)].map((m) => m[1])), CODIGOS);
console.log("página: título, h1 y texto cambiados; index.html con una marca de cada y las ligas en la portada");

// listas: un resultado con lo que dijo la web
assert.equal(filaResultado({ ...ficha, id: 7 }, 1, 1, reloj),
  '<li><a href="/partido/7">jue 22 oct · Inter 1-1 Shakhtar &lt;b&gt;&amp;</a>. La web daba Inter 55 % · empate 23 %'
  + " · Shakhtar &lt;b&gt;&amp; 22 %. Sorpresa: el favorito era Inter.</li>");

// el equipo: su puesto, su forma, su fuerza, sus partidos y lo que dijo la web
const equipo = {
  id: 108, nombre: "FC Internazionale Milano", corto: "Inter", liga: "SA", liga_nombre: "Serie A",
  tabla: { pos: 2, pj: 9, g: 6, e: 2, p: 1, gf: 18, gc: 7, pts: 20, equipos: 20 },
  fuerza: { ataque: 1.318, defensa: 0.82, partidos: 47, puesto_ataque: 3, puesto_defensa: 1, equipos: 20 },
  forma: [{ local: true, rival: "Torino <x>", rival_corto: null, gf: 2, gc: 0 }, { local: false, rival_corto: "Roma", gf: 1, gc: 1 }],
  ultimos: [{ ...ficha, gl: 3, gv: 0 }],
};
const te = textoEquipo(equipo, [ficha], reloj);
assert.equal(te.h1, "Inter: próximos partidos y pronóstico");
assert.ok(te.html.includes('<a href="/liga/SA">Serie A</a> · 2.º de 20 con 20 puntos en 9 partidos: 6 ganados, 2 empatados'
  + " y 1 perdido, 18 goles a favor y 7 en contra."), te.html);
assert.ok(te.html.includes("Últimos de liga: G 2-0 ante Torino &lt;x&gt; (en casa) · E 1-1 ante Roma (fuera)."));
assert.ok(te.html.includes("Marca un 32 % más que un equipo medio de la Serie A contra las mismas defensas (3.º de 20) y encaja"
  + " un 18 % menos contra los mismos ataques (1.º). Es lo que usa el modelo, con sus 47 partidos"));
assert.ok(te.html.includes('<li><a href="/partido/7">jue 22 oct, 14:00 · Inter – Shakhtar &lt;b&gt;&amp;</a>. Inter 55 %'));
assert.ok(te.html.includes("<h2>Lo que dijo la web</h2>") && te.html.includes("Inter 3-0 Shakhtar"));
assert.ok(te.html.includes('<a href="/liga/SA">Tabla y partidos de la Serie A</a>'));
const solo = textoEquipo({ ...equipo, tabla: null, fuerza: null, forma: [], ultimos: [], liga: null }, [], reloj);
assert.ok(solo.html.includes("No juega en los próximos días.") && !solo.html.includes("/liga/"));
console.log("equipo: puesto, forma, fuerza, próximos partidos y lo que dijo la web");

// la liga: sus partidos, su tabla en orden con su puesto y enlaces, lo que dijo la web
// y las demás ligas
const liga = textosLiga("PD", {
  partidos: [{ ...ficha, liga: "La Liga", liga_codigo: "PD", media_local: 1.476, media_visita: 1.181 }],
  equipos: [{ id: 81, nombre: "FC Barcelona", corto: "Barça", pos: 2, pts: 19, pj: 9, gf: 20, gc: 9 },
    { id: 86, nombre: "Real Madrid CF", corto: "Real <M>", pos: 1, pts: 21, pj: 9, gf: 19, gc: 6 }],
  ultimos: [],
}, reloj);
assert.equal(liga.titulo, "Pronósticos de La Liga");
assert.equal(liga.texto.h1, "Pronósticos de La Liga");
assert.ok(liga.descripcion.startsWith("1 partido de La Liga en los próximos días") && liga.descripcion.includes("Próximo: Inter –"));
assert.ok(liga.texto.html.includes("media de goles: 1.48 del local y 1.18 del visitante"));
const h = liga.texto.html;
assert.ok(h.indexOf('<li value="1"><a href="/equipo/86">Real &lt;M&gt;</a>: 21 puntos en 9 partidos, 19-6 en goles</li>')
  < h.indexOf('<li value="2"><a href="/equipo/81">'), h);
assert.ok(h.includes('<a href="/liga/CL">Champions League</a>') && !h.includes('href="/liga/PD"') && !h.includes("Lo que dijo la web"));
assert.equal(textosLiga("BSA", { partidos: [], equipos: [], ultimos: [] }, reloj).titulo, "Pronósticos del Brasileirão");
assert.equal(textosLiga("PL", { partidos: [], equipos: [], ultimos: [] }, reloj).titulo, "Pronósticos de la Premier League");
console.log("liga: próximos partidos, tabla en orden y enlaces a las demás ligas");

// IndexNow: cuándo toca
const aj = { indexnowUrl: "https://api.indexnow.org/indexnow", urlWeb: "https://pronosticos-bot.alvarocornejo2010.workers.dev" };
const listo = { estado: "listo" }, ahora = Date.parse("2026-10-29T12:00:00Z"), H = 3600000;
assert.equal(tocaIndexnow(null, listo, aj, ahora), "nunca se ha hecho");
assert.equal(tocaIndexnow(null, { estado: "actualizando" }, aj, ahora), null);
assert.equal(tocaIndexnow(null, listo, { ...aj, indexnowUrl: "" }, ahora), null);
assert.equal(tocaIndexnow({ actualizado: ahora - (HORAS_INDEXNOW * H - 60000) }, listo, aj, ahora), null);
assert.equal(tocaIndexnow({ actualizado: ahora - HORAS_INDEXNOW * H }, listo, aj, ahora), `la última hace ${HORAS_INDEXNOW} h`);

// IndexNow: qué manda. Una base de mentira con lo justo: los partidos de la ventana con
// predicción, los resultados (con cuándo se liquidaron) y los equipos de las tablas.
const base = {
  ventana: [{ id: 11, liga: "PD", local_id: 86, visita_id: 81 }, { id: 12, liga: "CL", local_id: 5, visita_id: 6 }],
  resultados: [{ id: 3, liga: "SA", liquidado: 1000, local_id: 108, visita_id: 100 }],
  tablas: [[86, "2026-10-29"], [81, "2026-10-29"], [108, "2026-10-28"]],
};
const docs = [];
const almacen = {
  consultar: (fn) => fn(),
  escribir: async (s) => docs.push(...s),
  sentenciaDoc: (clave, valor) => ({ clave, valor: JSON.parse(JSON.stringify(valor)) }),
  db: {
    prepare: (sql) => ({ sql, bind(...a) { return { sql, a }; },
      all: async () => ({ results: base.tablas.map(([id, cuando]) => ({ id, cuando })) }) }),
    batch: async ([v, r]) => [{ results: base.ventana }, { results: base.resultados.filter((x) => x.liquidado > r.a[0]) }],
  },
};
const enviadas = [];
let respuesta = 200;
const falso = async (url, op) => { enviadas.push({ url, ...JSON.parse(op.body) }); return new Response("", { status: respuesta }); };
const ultimo = () => docs[docs.length - 1].valor;
const origen = aj.urlWeb;

// la primera vez: la portada, todas las ligas, los partidos y todos los equipos
let r = await avisarBuscadores(almacen, aj, null, ahora, falso);
assert.deepEqual(r, { urls: 1 + CODIGOS.size + 3 + 6, estado: 200 });
let e = enviadas.at(-1);
assert.equal(e.url, aj.indexnowUrl);
assert.equal(e.host, "pronosticos-bot.alvarocornejo2010.workers.dev");
assert.equal(e.key, INDEXNOW_CLAVE);
assert.equal(e.keyLocation, `${origen}/${INDEXNOW_CLAVE}.txt`);
assert.equal(e.urlList[0], origen + "/");
for (const c of CODIGOS) assert.ok(e.urlList.includes(`${origen}/liga/${c}`), c);
for (const x of ["/partido/11", "/partido/12", "/partido/3", "/equipo/86", "/equipo/81", "/equipo/108", "/equipo/100",
  "/equipo/5", "/equipo/6"]) assert.ok(e.urlList.includes(origen + x), x);
assert.equal(new Set(e.urlList).size, e.urlList.length);
assert.deepEqual(ultimo(), { hecha: "2026-10-29T12:00:00.000Z", urls: r.urls, al_dia: true, desde: 1000, enviados: [11, 12],
  estado: 200 });
// la clave que se manda es la del archivo que se publica
assert.equal(readFileSync(new URL(`../public/${INDEXNOW_CLAVE}.txt`, import.meta.url), "utf8").trim(), INDEXNOW_CLAVE);

// sin cambios: no se manda nada
r = await avisarBuscadores(almacen, aj, ultimo(), ahora + 3 * H, falso);
assert.deepEqual(r, { urls: 0, estado: null });
assert.equal(enviadas.length, 1);
assert.deepEqual(ultimo().enviados, [11, 12]);

// un partido nuevo en la ventana y otro que terminó: solo ellos, sus equipos, sus ligas y la portada
base.ventana.push({ id: 13, liga: "PL", local_id: 61, visita_id: 62 });
base.resultados.push({ id: 4, liga: "PD", liquidado: 2000, local_id: 86, visita_id: 90 });
r = await avisarBuscadores(almacen, aj, ultimo(), ahora + 6 * H, falso);
e = enviadas.at(-1);
assert.deepEqual(e.urlList.map((u) => u.slice(origen.length)).sort(), ["/", "/equipo/61", "/equipo/62", "/equipo/86",
  "/equipo/90", "/liga/PD", "/liga/PL", "/partido/13", "/partido/4"]);
assert.equal(ultimo().desde, 2000);
assert.deepEqual(ultimo().enviados, [11, 12, 13]);

// si falla, se apunta sin mover lo mandado: la vez siguiente va otra vez
base.resultados.push({ id: 5, liga: "BL1", liquidado: 3000, local_id: 1, visita_id: 2 });
respuesta = 500;
r = await avisarBuscadores(almacen, aj, ultimo(), ahora + 9 * H, falso);
assert.equal(r.estado, 500);
assert.equal(ultimo().desde, 2000);
assert.ok(ultimo().al_dia && "error" in ultimo());
respuesta = 202;   // aceptado, la clave aún sin comprobar: vale igual
r = await avisarBuscadores(almacen, aj, ultimo(), ahora + 12 * H, falso);
assert.ok(enviadas.at(-1).urlList.includes(origen + "/partido/5") && r.estado === 202 && ultimo().desde === 3000);

// la primera vez que falla, la siguiente sigue siendo la primera: van todas las ligas
docs.length = 0;
respuesta = 403;
await avisarBuscadores(almacen, aj, null, ahora, falso);
assert.equal(ultimo().al_dia, false);
respuesta = 200;
await avisarBuscadores(almacen, aj, ultimo(), ahora + 3 * H, falso);
assert.ok(enviadas.at(-1).urlList.includes(origen + "/liga/BSA") && enviadas.at(-1).urlList.includes(origen + "/equipo/108"));
// y si falla la red, también
base.resultados.push({ id: 6, liga: "FL1", liquidado: 4000, local_id: 3, visita_id: 4 });
const antes = ultimo();
const sinRed = async () => { throw new TypeError("fetch failed"); };
r = await avisarBuscadores(almacen, aj, antes, ahora + 6 * H, sinRed);
assert.deepEqual(r, { urls: 5, estado: 0 });
assert.ok(ultimo().desde === antes.desde && ultimo().error === "fetch failed");
console.log("IndexNow: la primera vez todo, luego solo lo nuevo, y lo que falla se vuelve a mandar");
console.log("paginas: OK");
