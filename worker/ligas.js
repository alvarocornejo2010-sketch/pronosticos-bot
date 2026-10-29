// La página de cada liga: /liga/PD, para compartirla y para los buscadores (lo que
// alguien busca es "pronósticos de La Liga"). Como /partido/123 y /equipo/86
// (compartir.js, equipos.js), es la misma web con su tarjeta, su título y su texto ya
// escrito: sus partidos de los próximos días con el 1X2, su tabla con un enlace a cada
// equipo y lo que dijo la web de sus últimos partidos. La web, al verla, pasa a
// #/liga/PD (enlaceLiga en app.js).
//
// Se monta en cada petición con lo que ya hay en D1, sin pedir nada a la API: los
// partidos de la ventana de esa liga con su predicción, la tabla (del documento tabla:PD
// solo los equipos, sin lo que falta de temporada) y sus últimos resultados (con el
// índice resultados_por_liga). Una tanda de tres consultas y menos de 1 ms de CPU.

import { COMPETICIONES, ajustes } from "./config.js";
import { Reloj } from "./tiempo.js";
import { CAMPOS_PARTIDO, entradaDe, isoSinMs } from "./registro.js";
import { CODIGOS, cuandoCorto, cuantos, deLiga, enlaceEquipo, enlaceLiga, etiquetasOg, filaPartido, filaResultado,
  paginaConTarjeta } from "./compartir.js";

const NOMBRES = Object.fromEntries(Object.entries(COMPETICIONES).map(([n, c]) => [c, n]));
const ULTIMOS = 8;
const COLUMNAS = CAMPOS_PARTIDO.map((c) => `json_extract(p.ficha, '$.${c}') AS c_${c}`).join(", ");

// Lo que lleva la página de una liga: sus partidos por jugar (fichas, o la base si aún
// no tienen predicción), los equipos de su tabla y sus últimos partidos con resultado.
export async function datosLiga(almacen, codigo, reloj, ahora = Date.now()) {
  const db = almacen.db;
  const [prox, tabla, ultimos] = await almacen.consultar(() => db.batch([
    db.prepare(`SELECT pa.base, pr.ficha FROM partidos pa LEFT JOIN predicciones pr ON pr.id = pa.id
      WHERE pa.liga = ?1 AND pa.utc > ?2 ORDER BY pa.utc, pa.orden`).bind(codigo, isoSinMs(ahora)),
    db.prepare(`SELECT json_extract(valor, '$.equipos') AS equipos FROM documentos WHERE clave = ?1`).bind("tabla:" + codigo),
    db.prepare(`SELECT r.gl, r.gv, p.utc, ${COLUMNAS} FROM resultados r INDEXED BY resultados_por_liga
      JOIN predicciones p ON p.id = r.id WHERE r.liga = ?1 AND r.contado = 1 ORDER BY r.utc DESC LIMIT ${ULTIMOS}`).bind(codigo),
  ]));
  const fila = tabla.results[0];
  return {
    partidos: prox.results.map((f) => JSON.parse(f.ficha || f.base)),
    equipos: fila && fila.equipos ? JSON.parse(fila.equipos) : [],
    ultimos: ultimos.results.map((x) => {
      const ficha = { utcDate: x.utc };
      for (const c of CAMPOS_PARTIDO) ficha[c] = x["c_" + c];
      return entradaDe(ficha, x.gl, x.gv, reloj.local(Date.parse(x.utc)));
    }),
  };
}

// Título, descripción y texto de la página de una liga.
export function textosLiga(codigo, d, reloj) {
  const n = d.partidos.length;
  const primero = d.partidos[0];
  const conMedia = d.partidos.find((f) => typeof f.media_local === "number");
  const descripcion = (n ? `${cuantos(n, "partido", "partidos")} ${deLiga(codigo)} en los próximos días, con la probabilidad`
    + " de cada resultado y de los goles." : `Pronósticos ${deLiga(codigo)}: la tabla y lo que dijo la web de cada partido.`)
    + (primero ? ` Próximo: ${primero.local_corto || primero.local} – ${primero.visita_corto || primero.visita},`
      + ` ${cuandoCorto(primero.utcDate, reloj)} (hora de Lima).` : "");
  const p = [`<p class="meta">${n ? `${cuantos(n, "partido", "partidos")} en los próximos días` : "Sin partidos en los próximos días"}`
    + (conMedia ? ` · media de goles: ${conMedia.media_local.toFixed(2)} del local y ${conMedia.media_visita.toFixed(2)} del`
      + " visitante" : "") + "</p>",
  "<p>La probabilidad de cada resultado sale de un modelo Poisson con la fuerza de ataque y de defensa de cada equipo,"
    + " ajustada por rival y medida contra miles de partidos. Los porcentajes son los mismos que enseña la web.</p>",
  "<h2>Próximos partidos</h2>",
  n ? "<ul>" + d.partidos.map((f) => filaPartido(f, reloj)).join("") + "</ul>" : "<p>No juega nadie en los próximos días.</p>"];
  if (d.equipos.length) {
    p.push("<h2>Tabla</h2>", "<ol>" + [...d.equipos].sort((a, b) => a.pos - b.pos).map((e) =>
      `<li value="${Number(e.pos)}">${enlaceEquipo(e.id, e.corto || e.nombre)}: ${cuantos(Number(e.pts), "punto", "puntos")} en`
      + ` ${cuantos(Number(e.pj), "partido", "partidos")}, ${Number(e.gf)}-${Number(e.gc)} en goles</li>`).join("") + "</ol>");
  }
  if (d.ultimos.length) {
    p.push("<h2>Lo que dijo la web</h2>", "<ul>" + d.ultimos.map((x) => filaResultado(x, x.gl, x.gv, reloj)).join("") + "</ul>");
  }
  const otras = [...CODIGOS].filter((c) => c !== codigo).map((c) => enlaceLiga(c, NOMBRES[c])).join(" · ");
  p.push(`<p class="enlaces"><a href="/">Los partidos de toda la semana</a> · ${otras}</p>`);
  return {
    titulo: `Pronósticos ${deLiga(codigo)}`, descripcion,
    texto: { h1: `Pronósticos ${deLiga(codigo)}`, html: `<div class="escrito">${p.join("")}</div>` },
  };
}

export async function paginaLiga(request, env, almacen, codigo) {
  let og = null, texto = null;
  if (CODIGOS.has(codigo)) {
    try {
      const reloj = new Reloj(ajustes(env).tz);
      const t = textosLiga(codigo, await datosLiga(almacen, codigo, reloj), reloj);
      og = etiquetasOg(new URL(request.url).origin, `/liga/${codigo}`, t.titulo, t.descripcion,
        `${t.titulo}: probabilidades de cada partido`);
      texto = t.texto;
    } catch (e) {
      console.error(`/liga/${codigo}: ${(e && e.stack) || e}`);
    }
  }
  return paginaConTarjeta(request, env, og, texto);
}

