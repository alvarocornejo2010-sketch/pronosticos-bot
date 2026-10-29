// La página de cada equipo: #/equipo/86 en la web, y /equipo/86 para compartirla y
// para Google (con su título, su descripción y su dirección canónica, como los
// partidos en compartir.js). Lleva sus próximos partidos (los pinta la web con lo de
// /api/estado), su puesto con la proyección de la temporada (la web la simula con
// /api/tabla/PD, como la tabla), su ataque y su defensa frente a los de su liga, su
// forma en la liga y lo que dijo la web de sus últimos partidos, contra lo que pasó.
//
// /api/equipo/86 se monta en cada petición con lo que ya hay en D1, sin pedir nada a
// la API: la tabla de su liga (documento tabla:PD, unos 9 KB), sus fuerzas (caché
// fuerzas), los partidos de liga de esta temporada (partidos_liga PD:actual) y sus
// predicciones con resultado (por su nombre, con los índices predicciones_por_local y
// predicciones_por_visita). Menos de 1 ms de CPU. La liga de cada equipo sale de las
// tablas: uno que no está en ninguna (de la Champions, de una liga fuera del plan) solo
// tiene sus partidos y lo que dijo la web. Solo en Cloudflare: en Render,
// /api/equipo/... responde no_disponible.

import { ajustes, FORMATO_LISTAS } from "./config.js";
import { fuerzaEquipo, redondear } from "./modelo.js";
import { CAMPOS_PARTIDO, entradaDe, isoSinMs } from "./registro.js";
import { Reloj } from "./tiempo.js";
import { cuantos, deLiga, enlaceLiga, esc, etiquetasOg, filaPartido, filaResultado, paginaConTarjeta,
  textosPartido } from "./compartir.js";

const FORMA = 5;      // los últimos partidos de liga que enseña
const ULTIMOS = 6;    // y los últimos con pronóstico de la web

// El documento de la tabla en la que está (tabla:PD...: de 'tabla:' a 'tabla;', sin
// tablas_resumen), o sus datos del calendario si no está en ninguna.
const SQL_TABLA = `SELECT substr(d.clave, 7) AS liga, d.valor FROM documentos d
  WHERE d.clave >= 'tabla:' AND d.clave < 'tabla;'
    AND EXISTS (SELECT 1 FROM json_each(d.valor, '$.equipos') e WHERE json_extract(e.value, '$.id') = ?1)
  LIMIT 1`;
const SQL_PROXIMOS = `SELECT pa.local_id, pa.base, pr.ficha FROM partidos pa LEFT JOIN predicciones pr ON pr.id = pa.id
  WHERE (pa.local_id = ?1 OR pa.visita_id = ?1) AND pa.utc > ?2 ORDER BY pa.utc, pa.orden LIMIT 4`;
const COLUMNAS = CAMPOS_PARTIDO.map((c) => `json_extract(p.ficha, '$.${c}') AS c_${c}`).join(", ");
// lo publicado antes de empezar (contado) y ya con resultado, de local y de visita
const sqlUltimos = (lado) => `SELECT r.gl, r.gv, p.utc, ${COLUMNAS}
  FROM predicciones p INDEXED BY predicciones_por_${lado} JOIN resultados r ON r.id = p.id
  WHERE json_extract(p.ficha, '$.${lado}') = ?1 AND r.contado = 1 ORDER BY p.utc DESC LIMIT ${ULTIMOS}`;

// Puesto de v entre valores (1 = el mejor): cuántos son mejores, más uno.
const puesto = (v, todos, mejor) => 1 + todos.filter((x) => (mejor === "alto" ? x > v : x < v)).length;

// Lo que lee la web de un equipo, y las fichas de sus próximos partidos (para la tarjeta
// y el texto de su página); datos null si no está en ninguna tabla ni en el calendario.
async function leerEquipo(almacen, id, reloj, ahora) {
  const db = almacen.db;
  const [enTabla, prox] = await almacen.consultar(() => db.batch([
    db.prepare(SQL_TABLA).bind(id),
    db.prepare(SQL_PROXIMOS).bind(id, isoSinMs(ahora)),
  ]));
  const filaTabla = enTabla.results[0];
  const doc = filaTabla ? JSON.parse(filaTabla.valor) : null;
  const yo = doc && doc.equipos.find((e) => e.id === id);
  const proximos = prox.results.map((p) => JSON.parse(p.ficha || p.base));
  const p = prox.results[0], proximo = proximos[0] || null;
  const lado = p ? (p.local_id === id ? "local" : "visita") : null;
  const nombre = yo ? yo.nombre : proximo && proximo[lado];
  if (!nombre) return { datos: null, proximos: [] };

  const liga = filaTabla ? filaTabla.liga : null;
  const [fuerzas, lista, deLocal, deVisita] = await almacen.consultar(() => db.batch([
    db.prepare("SELECT valor FROM cache WHERE seccion = 'fuerzas' AND clave = ?1").bind(liga ?? ""),
    db.prepare("SELECT valor FROM cache WHERE seccion = 'partidos_liga' AND clave = ?1").bind((liga ?? "") + ":actual"),
    db.prepare(sqlUltimos("local")).bind(nombre),
    db.prepare(sqlUltimos("visita")).bind(nombre),
  ]));

  const out = {
    estado: "listo", id, nombre,
    corto: yo ? yo.corto : proximo[lado + "_corto"] ?? null,
    sigla: yo ? yo.sigla : proximo[lado + "_sigla"] ?? null,
    escudo: yo ? yo.escudo : proximo[lado + "_escudo"] ?? null,
    liga, liga_nombre: doc ? doc.nombre : null,
    tabla: null, fuerza: null, forma: [], ultimos: [], proximo: proximo && proximo.id,
  };
  if (doc) {
    out.tabla = { pos: yo.pos, pj: yo.pj, g: yo.g, e: yo.e, p: yo.p, gf: yo.gf, gc: yo.gc, pts: yo.pts,
      equipos: doc.equipos.length, actualizada: doc.tabla_actualizada };
  }

  // ataque y defensa, y su puesto entre los de la tabla (la mejor defensa encaja menos)
  const f = fuerzas.results[0] ? JSON.parse(fuerzas.results[0].valor) : null;
  if (f && doc) {
    const todas = doc.equipos.map((e) => fuerzaEquipo(f, e.id));
    const suya = fuerzaEquipo(f, id);
    out.fuerza = {
      ataque: redondear(suya.ataque, 3), defensa: redondear(suya.defensa, 3), partidos: suya.partidos,
      puesto_ataque: puesto(suya.ataque, todas.map((x) => x.ataque), "alto"),
      puesto_defensa: puesto(suya.defensa, todas.map((x) => x.defensa), "bajo"),
      equipos: todas.length,
    };
  }

  // los últimos de liga de esta temporada, del más viejo al más nuevo
  const l = lista.results[0] ? JSON.parse(lista.results[0].valor) : null;
  if (l && l.formato === FORMATO_LISTAS && doc) {
    const porId = new Map(doc.equipos.map((e) => [e.id, e]));
    out.forma = l.partidos.filter((x) => x[1] === id || x[2] === id).slice(-FORMA).map(([, loc, vis, gl, gv]) => {
      const local = loc === id, rival = porId.get(local ? vis : loc) || {};
      return { local, rival: rival.nombre ?? null, rival_corto: rival.corto ?? null, rival_escudo: rival.escudo ?? null,
        gf: local ? gl : gv, gc: local ? gv : gl };
    });
  }

  // lo que dijo la web de sus últimos partidos, en todas las competiciones
  const filas = [...deLocal.results, ...deVisita.results]
    .sort((a, b) => (a.utc < b.utc ? 1 : a.utc > b.utc ? -1 : b.c_id - a.c_id)).slice(0, ULTIMOS);
  out.ultimos = filas.map((x) => {
    const ficha = { utcDate: x.utc };
    for (const c of CAMPOS_PARTIDO) ficha[c] = x["c_" + c];
    return entradaDe(ficha, x.gl, x.gv, reloj.local(Date.parse(x.utc)));
  });
  return { datos: out, proximos };
}

export async function datosEquipo(almacen, id, reloj, ahora = Date.now()) {
  return (await leerEquipo(almacen, id, reloj, ahora)).datos;
}

export async function apiEquipo(almacen, env, id) {
  return (await datosEquipo(almacen, id, new Reloj(ajustes(env).tz)))
    || { estado: "no_encontrado", id, nota: "Ese equipo no está en ninguna de las ligas ni en los partidos de la semana." };
}

// El título y la descripción de su tarjeta: la liga y el puesto, y el próximo partido.
export function textosEquipo(d, proximo, reloj) {
  const nombre = d.corto || d.nombre;
  const partes = [];
  if (d.tabla) partes.push(`${d.liga_nombre}: ${d.tabla.pos}.º con ${d.tabla.pts} puntos.`);
  if (proximo) {
    const t = textosPartido(proximo, reloj);
    partes.push(`Próximo partido: ${t.titulo}, ${t.descripcion}`);
  }
  partes.push("Su forma, su ataque y su defensa, y lo que dijo la web de sus últimos partidos.");
  return { titulo: `${nombre}: próximos partidos y pronóstico`, descripcion: partes.join(" ") };
}

// "32 % más", "lo mismo": su fuerza frente a la de un equipo medio (htmlFuerza en app.js).
function cuanto(v) {
  const n = Math.round((v - 1) * 100);
  return n === 0 ? "lo mismo" : `un ${Math.abs(n)} % ${n > 0 ? "más" : "menos"}`;
}

// El texto de su página para quien no ejecuta JavaScript: su puesto, su forma, cómo
// juega, sus próximos partidos y lo que dijo la web de los últimos, con sus enlaces.
export function textoEquipo(d, proximos, reloj) {
  const nombre = d.corto || d.nombre;
  const deSuLiga = d.liga ? deLiga(d.liga, d.liga_nombre) : "de su liga";
  const p = [];
  if (d.tabla) {
    const t = d.tabla;
    p.push(`<p class="meta">${enlaceLiga(d.liga, d.liga_nombre)} · ${t.pos}.º de ${t.equipos} con ${cuantos(t.pts, "punto", "puntos")}`
      + ` en ${cuantos(t.pj, "partido", "partidos")}: ${cuantos(t.g, "ganado", "ganados")}, ${cuantos(t.e, "empatado", "empatados")}`
      + ` y ${cuantos(t.p, "perdido", "perdidos")}, ${cuantos(t.gf, "gol", "goles")} a favor y ${t.gc} en contra.</p>`);
  }
  if (d.forma.length) {
    const letra = (x) => (x.gf > x.gc ? "G" : x.gf === x.gc ? "E" : "P");
    p.push(`<p>Últimos de liga: ${esc(d.forma.map((x) => `${letra(x)} ${x.gf}-${x.gc} ante ${x.rival_corto || x.rival || "?"}`
      + ` (${x.local ? "en casa" : "fuera"})`).join(" · "))}.</p>`);
  }
  if (d.fuerza) {
    const f = d.fuerza;
    p.push(`<p>Marca ${cuanto(f.ataque)} que un equipo medio ${esc(deSuLiga)} contra las mismas defensas (${f.puesto_ataque}.º`
      + ` de ${f.equipos}) y encaja ${cuanto(f.defensa)} contra los mismos ataques (${f.puesto_defensa}.º). `
      + (f.partidos ? `Es lo que usa el modelo, con sus ${f.partidos} partidos de liga de esta temporada y la anterior.`
        : "Recién llegado a la liga: parte de lo que suelen rendir los que llegan, hasta que juegue.") + "</p>");
  }
  p.push("<h2>Próximos partidos</h2>", proximos.length
    ? "<ul>" + proximos.map((x) => filaPartido(x, reloj)).join("") + "</ul>"
    : "<p>No juega en los próximos días.</p>");
  if (d.ultimos.length) {
    p.push("<h2>Lo que dijo la web</h2>", "<ul>" + d.ultimos.map((x) => filaResultado(x, x.gl, x.gv, reloj)).join("") + "</ul>");
  }
  p.push(`<p class="enlaces">${d.liga ? enlaceLiga(d.liga, `Tabla y partidos ${deSuLiga}`) + " · " : ""}`
    + '<a href="/">Los partidos de toda la semana</a></p>');
  return { h1: `${nombre}: próximos partidos y pronóstico`, html: `<div class="escrito">${p.join("")}</div>` };
}

export async function paginaEquipo(request, env, almacen, id) {
  let og = null, texto = null;
  try {
    const reloj = new Reloj(ajustes(env).tz);
    const { datos: d, proximos } = await leerEquipo(almacen, id, reloj, Date.now());
    if (d) {
      const { titulo, descripcion } = textosEquipo(d, proximos[0] || null, reloj);
      og = etiquetasOg(new URL(request.url).origin, `/equipo/${id}`, titulo, descripcion);
      texto = textoEquipo(d, proximos, reloj);
    }
  } catch (e) {
    console.error(`/equipo/${id}: ${(e && e.stack) || e}`);
  }
  return paginaConTarjeta(request, env, og, texto);
}

// Los equipos de todas las tablas, para el sitemap: [id, fecha de la tabla].
export async function equiposDeTablas(almacen) {
  const r = await almacen.consultar(() => almacen.db.prepare(
    `SELECT json_extract(e.value, '$.id') AS id, json_extract(d.valor, '$.tabla_actualizada') AS cuando
     FROM documentos d, json_each(d.valor, '$.equipos') e WHERE d.clave >= 'tabla:' AND d.clave < 'tabla;'
     ORDER BY d.clave, json_extract(e.value, '$.pos')`).all());
  return r.results.map((f) => [Number(f.id), f.cuando]);
}
