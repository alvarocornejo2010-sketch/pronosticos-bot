// La página de un partido para compartir y para los buscadores: /partido/123 es la
// misma web (index.html) con las etiquetas Open Graph de ese partido, para que
// WhatsApp, Telegram o X enseñen una tarjeta con los equipos y el 1X2, y con su texto
// ya escrito: el pronóstico, los goles y los enlaces a sus equipos y a su liga. Google
// pinta la web, pero Bing lo hace a medias y los asistentes (ChatGPT, Perplexity...)
// no ejecutan JavaScript: sin el texto solo leerían "Pronósticos". En index.html las
// etiquetas van entre <!-- og --> y <!-- /og -->, el título de la vista entre
// <!-- h1 --> y <!-- /h1 --> y el texto entre <!-- texto --> y <!-- /texto -->; aquí se
// cambian por los del partido. La web lee la ruta, abre el partido (al pintar, el texto
// se va) y vuelve a la dirección de siempre (enlacePartido en app.js).
//
// Cuesta una fila de D1 y pegar textos: index.html llega ya hecho de los
// archivos estáticos, con sus cabeceras (public/_headers).

import { Reloj } from "./tiempo.js";
import { COMPETICIONES, ajustes } from "./config.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
  "octubre", "noviembre", "diciembre"];
const BLOQUE = /<!-- og -->[\s\S]*?<!-- \/og -->/;
const H1 = /<!-- h1 -->[\s\S]*?<!-- \/h1 -->/;
const TEXTO = /<!-- texto -->[\s\S]*?<!-- \/texto -->/;
export const CODIGOS = new Set(Object.values(COMPETICIONES));
const NOMBRES = Object.fromEntries(Object.entries(COMPETICIONES).map(([n, c]) => [c, n]));
// "de la Premier League": cada liga con su artículo (las que no se conocen, sin él).
const DE = { PD: "de La Liga", BSA: "del Brasileirão" };
export const deLiga = (codigo, nombre) => DE[codigo] || (CODIGOS.has(codigo) ? `de la ${NOMBRES[codigo]}` : `de ${nombre}`);
// "1 partido", "8 partidos".
export const cuantos = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// Los enteros que enseña la web (resto mayor, suman 100): enterosQueSuman de app.js.
export function enterosQueSuman(bruto) {
  const enteros = bruto.map(Math.floor);
  let faltan = 100 - enteros.reduce((a, b) => a + b, 0);
  const porResto = bruto.map((v, i) => ({ i, resto: v - Math.floor(v) })).sort((a, b) => b.resto - a.resto);
  for (let k = 0; k < porResto.length && faltan > 0; k++, faltan--) enteros[porResto[k].i]++;
  return enteros;
}

// El favorito como en la web (veredictoDe): el mayor; si empatan, el primero (1, X, 2).
export function favoritoDe(e) {
  return [["1", e.prob_local], ["X", e.prob_empate], ["2", e.prob_visita]].reduce((a, b) => (b[1] > a[1] ? b : a));
}

const corto = (f, lado) => f[lado + "_corto"] || f[lado] || "?";

// "sáb 24 oct", "sáb 24 oct, 20:30" y "sábado 24 de octubre de 2026, 20:30": la hora de Lima.
export function diaCorto(utc, reloj) {
  const { fecha } = reloj.local(Date.parse(utc));
  return `${DIAS[new Date(fecha + "T00:00:00Z").getUTCDay()]} ${+fecha.slice(8, 10)} ${MESES[+fecha.slice(5, 7) - 1]}`;
}
export const cuandoCorto = (utc, reloj) => `${diaCorto(utc, reloj)}, ${reloj.local(Date.parse(utc)).hora}`;
export function cuandoLargo(utc, reloj) {
  const { fecha, hora } = reloj.local(Date.parse(utc));
  return `${DIAS_LARGOS[new Date(fecha + "T00:00:00Z").getUTCDay()]} ${+fecha.slice(8, 10)} de `
    + `${MESES_LARGOS[+fecha.slice(5, 7) - 1]} de ${fecha.slice(0, 4)}, ${hora}`;
}

// "Inter 86 % · empate 9 % · Shakhtar 5 %", con los enteros de la web.
export function lineaReparto(f) {
  const [l, x, v] = enterosQueSuman([f.prob_local, f.prob_empate, f.prob_visita]);
  return `${corto(f, "local")} ${l} % · empate ${x} % · ${corto(f, "visita")} ${v} %`;
}

// Si acertó el favorito, con un marcador ya jugado.
export function queDijo(f, gl, gv) {
  const fav = favoritoDe(f)[0];
  const real = gl > gv ? "1" : gl === gv ? "X" : "2";
  return fav === real ? "Acertó el favorito."
    : fav === "X" ? "Sorpresa: lo más probable era el empate." : `Sorpresa: el favorito era ${corto(f, fav === "1" ? "local" : "visita")}.`;
}

// La frase del pronóstico, la del detalle de la web (veredictoTexto en app.js): claro
// con 60 o más, intermedio de 45 a 59 y parejo por debajo, con el entero de la tabla.
export function veredicto(f) {
  const [l, x, v] = enterosQueSuman([f.prob_local, f.prob_empate, f.prob_visita]);
  const g = favoritoDe(f)[0];
  const n = g === "1" ? l : g === "2" ? v : x;
  const quien = g === "1" ? corto(f, "local") : g === "2" ? corto(f, "visita") : null;
  const de10 = Math.round(n / 10);
  const gana = de10 >= 10 ? "De cada 10 partidos así, los gana casi todos." : `De cada 10 partidos así, gana unos ${de10}.`;
  if (!quien) return { titulo: "Partido parejo", frase: `Lo más probable es el empate, con ${n} %.` };
  if (n >= 60) return { titulo: `Favorito claro: ${quien}`, frase: gana };
  if (n >= 45) return { titulo: `Favorito: ${quien}`, frase: `Sin ser claro. ${gana}` };
  return { titulo: "Partido parejo", frase: `Nadie llega al 45 %. Lo más probable es que gane ${quien}, con ${n} %.` };
}

// Título y descripción de la tarjeta de un partido (ficha o, si aún no tiene
// predicción, los datos del calendario).
export function textosPartido(f, reloj) {
  const titulo = `${corto(f, "local")} – ${corto(f, "visita")}`;
  const cuando = `${cuandoCorto(f.utcDate, reloj)} (hora de Lima)`;
  if (f.prob_local === undefined) {
    return { titulo, descripcion: `${f.liga} · ${cuando}. Pronóstico en cálculo.` };
  }
  const goles = f.prob_mas_25 !== undefined ? ` Más de 2.5 goles: ${Math.round(f.prob_mas_25)} %.` : "";
  return { titulo, descripcion: `${f.liga} · ${cuando}. ${lineaReparto(f)}.${goles}` };
}

// Los enlaces de un partido a sus equipos y a su liga, si se sabe cuáles son.
export function enlaceEquipo(id, nombre) {
  return Number.isInteger(id) && id > 0 ? `<a href="/equipo/${id}">${esc(nombre)}</a>` : esc(nombre);
}
export const enlaceLiga = (codigo, texto) => (CODIGOS.has(codigo) ? `<a href="/liga/${codigo}">${esc(texto)}</a>` : esc(texto));

// Un partido en una lista (la de un equipo o la de una liga), con su enlace.
export function filaPartido(f, reloj) {
  const quien = `${cuandoCorto(f.utcDate, reloj)} · ${corto(f, "local")} – ${corto(f, "visita")}`;
  const num = f.prob_local === undefined ? "Pronóstico en cálculo."
    : `${lineaReparto(f)}.` + (f.prob_mas_25 !== undefined ? ` Más de 2.5 goles: ${Math.round(f.prob_mas_25)} %.` : "");
  return `<li><a href="/partido/${Number(f.id)}">${esc(quien)}</a>. ${esc(num)}</li>`;
}

// Un partido ya jugado en una lista: el marcador y lo que dijo la web antes de empezar.
export function filaResultado(e, gl, gv, reloj) {
  const marcador = `${corto(e, "local")} ${gl}-${gv} ${corto(e, "visita")}`;
  const dijo = e.prob_local == null ? "" : ` La web daba ${lineaReparto(e)}. ${queDijo(e, gl, gv)}`;
  return `<li><a href="/partido/${Number(e.id)}">${esc(diaCorto(e.utcDate, reloj))} · ${esc(marcador)}</a>.`
    + `${esc(dijo)}</li>`;
}

// El texto de un partido para quien no ejecuta JavaScript: lo que dice su detalle en
// la web (el veredicto, el 1X2, la doble oportunidad, los goles y los marcadores), con
// los mismos enteros, y los enlaces a sus equipos y a su liga. Con resultado, primero
// el marcador y si acertó el favorito.
export function textoPartido(f, res, reloj) {
  const local = corto(f, "local"), visita = corto(f, "visita");
  const p = [`<p class="meta">${enlaceLiga(f.liga_codigo, f.liga)} · ${esc(cuandoLargo(f.utcDate, reloj))} (hora de Lima)</p>`];
  const numeros = f.prob_local !== undefined;
  if (res) {
    p.push(`<p><b>Final: ${esc(`${local} ${res.gl}-${res.gv} ${visita}`)}.</b>`
      + (numeros && res.contado ? ` ${esc(queDijo(f, res.gl, res.gv))} Esto es lo que dijo la web antes de empezar:` : "") + "</p>");
  }
  if (numeros) {
    const v = veredicto(f);
    const [l, x, vi] = enterosQueSuman([f.prob_local, f.prob_empate, f.prob_visita]);
    const li = [`Quién gana: ${lineaReparto(f)}.`, `Doble oportunidad: 1X ${l + x} % · X2 ${x + vi} % · 12 ${l + vi} %.`];
    if (typeof f.xg_local === "number" && typeof f.xg_visita === "number") {
      li.push(`Goles esperados: ${local} ${f.xg_local.toFixed(2)} · ${visita} ${f.xg_visita.toFixed(2)}.`);
    }
    if (f.prob_mas_25 !== undefined && f.prob_ambos !== undefined) {
      li.push(`Más de 2.5 goles: ${Math.round(f.prob_mas_25)} % · ambos marcan: ${Math.round(f.prob_ambos)} %.`);
    }
    if ((f.marcadores || []).length) {
      li.push("Marcadores más probables: " + f.marcadores.map(([a, b, q]) => `${a}–${b} (${Math.round(q)} %)`).join(", ") + ".");
    }
    p.push(`<p><b>${esc(v.titulo)}.</b> ${esc(v.frase)}</p>`, "<ul>" + li.map((t) => `<li>${esc(t)}</li>`).join("") + "</ul>");
  } else if (!res) {
    p.push("<p>El pronóstico se está calculando: sale en unos minutos.</p>");
  }
  p.push(`<p class="enlaces">${enlaceEquipo(f.local_id, local)} · ${enlaceEquipo(f.visita_id, visita)} · `
    + `${enlaceLiga(f.liga_codigo, `Todos los partidos ${deLiga(f.liga_codigo, f.liga)}`)} · <a href="/">Los de toda la semana</a></p>`);
  return { h1: `${local} – ${visita}: pronóstico`, html: `<div class="escrito">${p.join("")}</div>` };
}

export function etiquetasOg(origen, ruta, titulo, descripcion, pagina = `${titulo} · Pronósticos`) {
  return `<!-- og -->
<title>${esc(pagina)}</title>
<meta name="description" content="${esc(descripcion)}">
<link rel="canonical" href="${esc(origen + ruta)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pronósticos">
<meta property="og:locale" content="es_ES">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(descripcion)}">
<meta property="og:url" content="${esc(origen + ruta)}">
<meta property="og:image" content="${esc(origen)}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Pronósticos: probabilidades 1 X 2 de fútbol">
<meta name="twitter:card" content="summary_large_image">
<!-- /og -->`;
}

export async function paginaPartido(request, env, almacen, id) {
  const url = new URL(request.url);
  const db = almacen.db;
  let og = null, texto = null;
  try {
    const fila = await almacen.consultar(() => db.prepare(
      `SELECT p.f, r.gl, r.gv, r.contado FROM (
         SELECT ficha AS f FROM predicciones WHERE id = ?1
         UNION ALL SELECT base AS f FROM partidos WHERE id = ?1 LIMIT 1) p
       LEFT JOIN resultados r ON r.id = ?1`).bind(id).first());
    if (fila) {
      const reloj = new Reloj(ajustes(env).tz);
      const f = JSON.parse(fila.f);
      const { titulo, descripcion } = textosPartido(f, reloj);
      og = etiquetasOg(url.origin, `/partido/${id}`, titulo, descripcion, `${titulo}: pronóstico y probabilidades`);
      texto = textoPartido(f, fila.gl === null || fila.gl === undefined ? null : fila, reloj);
    }
  } catch (e) {
    // sin base, la página sale igual (con la tarjeta de siempre): es la web
    console.error(`/partido/${id}: ${(e && e.stack) || e}`);
  }
  return paginaConTarjeta(request, env, og, texto);
}

// index.html con las etiquetas og (las de un partido, un equipo o una liga) en vez de
// las de siempre, y su título y su texto ({h1, html}) en vez de los de la portada. Sin
// etiquetas (no existe), la página de siempre, fuera de Google.
export async function paginaConTarjeta(request, env, og, texto = null) {
  const pagina = await env.ASSETS.fetch(new Request(new URL("/", request.url), { method: "GET" }));
  if (!pagina.ok) return pagina;
  const html = await pagina.text();
  // Con función: un "$'" en un nombre sería un patrón de reemplazo.
  let cuerpo = og ? html.replace(BLOQUE, () => og) : html;
  if (og && texto) cuerpo = cuerpo.replace(H1, () => esc(texto.h1)).replace(TEXTO, () => texto.html);
  const cabeceras = new Headers(pagina.headers);   // las de public/_headers (CSP incluida)
  cabeceras.delete("Content-Length");
  cabeceras.delete("ETag");
  if (!og) cabeceras.set("X-Robots-Tag", "noindex");
  return new Response(request.method === "HEAD" ? null : cuerpo, { status: 200, headers: cabeceras });
}
