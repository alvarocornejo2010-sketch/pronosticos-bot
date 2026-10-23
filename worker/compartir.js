// La página de un partido para compartir: /partido/123 es la misma web
// (index.html) con las etiquetas Open Graph de ese partido, para que WhatsApp,
// Telegram o X enseñen una tarjeta con los equipos y el 1X2. Las etiquetas van
// entre <!-- og --> y <!-- /og --> en index.html; aquí se cambian por las del
// partido. La web lee la ruta, abre el partido y vuelve a la dirección de
// siempre (enlacePartido en app.js).
//
// Cuesta una fila de D1 y pegar textos: index.html llega ya hecho de los
// archivos estáticos, con sus cabeceras (public/_headers).

import { Reloj } from "./tiempo.js";
import { ajustes } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const BLOQUE = /<!-- og -->[\s\S]*?<!-- \/og -->/;

// Los enteros que enseña la web (resto mayor, suman 100): enterosQueSuman de app.js.
export function enterosQueSuman(bruto) {
  const enteros = bruto.map(Math.floor);
  let faltan = 100 - enteros.reduce((a, b) => a + b, 0);
  const porResto = bruto.map((v, i) => ({ i, resto: v - Math.floor(v) })).sort((a, b) => b.resto - a.resto);
  for (let k = 0; k < porResto.length && faltan > 0; k++, faltan--) enteros[porResto[k].i]++;
  return enteros;
}

// Título y descripción de la tarjeta de un partido (ficha o, si aún no tiene
// predicción, los datos del calendario).
export function textosPartido(f, reloj) {
  const local = f.local_corto || f.local, visita = f.visita_corto || f.visita;
  const { fecha, hora } = reloj.local(Date.parse(f.utcDate));
  const dia = DIAS[new Date(fecha + "T00:00:00Z").getUTCDay()];
  const cuando = `${dia} ${+fecha.slice(8, 10)} ${MESES[+fecha.slice(5, 7) - 1]}, ${hora} (hora de Lima)`;
  const titulo = `${local} – ${visita}`;
  if (f.prob_local === undefined) {
    return { titulo, descripcion: `${f.liga} · ${cuando}. Pronóstico en cálculo.` };
  }
  const [l, x, v] = enterosQueSuman([f.prob_local, f.prob_empate, f.prob_visita]);
  const goles = f.prob_mas_25 !== undefined ? ` Más de 2.5 goles: ${Math.round(f.prob_mas_25)} %.` : "";
  return { titulo, descripcion: `${f.liga} · ${cuando}. ${local} ${l} % · empate ${x} % · ${visita} ${v} %.${goles}` };
}

export function etiquetasOg(origen, ruta, titulo, descripcion) {
  return `<!-- og -->
<title>${esc(titulo)} · Pronósticos</title>
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
  const pagina = await env.ASSETS.fetch(new Request(new URL("/", url), { method: "GET" }));
  if (!pagina.ok) return pagina;
  const html = await pagina.text();
  const db = almacen.db;
  let og = null;
  try {
    const fila = await almacen.consultar(() => db.prepare(
      `SELECT ficha AS f FROM predicciones WHERE id = ?1
       UNION ALL SELECT base AS f FROM partidos WHERE id = ?1 LIMIT 1`).bind(id).first());
    if (fila) {
      const { titulo, descripcion } = textosPartido(JSON.parse(fila.f), new Reloj(ajustes(env).tz));
      og = etiquetasOg(url.origin, `/partido/${id}`, titulo, descripcion);
    }
  } catch (e) {
    // sin base, la página sale igual (con la tarjeta de siempre): es la web
    console.error(`/partido/${id}: ${(e && e.stack) || e}`);
  }
  // sin el partido, la tarjeta de siempre (la de index.html)
  const cuerpo = og ? html.replace(BLOQUE, og) : html;
  const cabeceras = new Headers(pagina.headers);   // las de public/_headers (CSP incluida)
  cabeceras.delete("Content-Length");
  cabeceras.delete("ETag");
  return new Response(request.method === "HEAD" ? null : cuerpo, { status: 200, headers: cabeceras });
}
