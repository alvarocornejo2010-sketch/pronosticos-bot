// El historial de aciertos: lo que dijo la web de cada partido, contra lo que pasó,
// semana a semana (de lunes a domingo, en hora de Lima). /api/resultados da la última
// semana con resultados y /api/resultados?semana=2026-10-26 una cualquiera; la web la
// pinta en #/resultados (sección RESULTADOS de app.js). /resultados y
// /resultados/2026-10-26 son la misma web con su tarjeta y su texto ya escrito, para
// compartirla y para los buscadores (como /liga/PD en ligas.js).
//
// Solo cuenta lo publicado antes de empezar (resultados.contado), lo mismo que el
// registro en vivo. Se monta en cada petición con dos consultas, por el índice
// resultados_por_fecha: la primera y la última semana con resultados (un salto del
// índice cada una) y los partidos de la semana pedida (unos 150). Menos de 1 ms de CPU.
// Solo en Cloudflare: en Render, /api/resultados responde no_disponible.

import { COMPETICIONES, ajustes } from "./config.js";
import { CAMPOS_PARTIDO, TRAMOS, entradaDe, isoSinMs } from "./registro.js";
import { Reloj, diaSemana, sumarDias } from "./tiempo.js";
import { cuantos, enlaceLiga, enterosQueSuman, esc, etiquetasOg, favoritoDe, filaResultado,
  paginaConTarjeta } from "./compartir.js";

const NOMBRES = Object.fromEntries(Object.entries(COMPETICIONES).map(([n, c]) => [c, n]));
const ORDEN = Object.values(COMPETICIONES);
const COLUMNAS = [...CAMPOS_PARTIDO, "local_id", "visita_id"]
  .map((c) => `json_extract(p.ficha, '$.${c}') AS c_${c}`).join(", ");
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS_LARGOS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const mayuscula = (t) => t[0].toUpperCase() + t.slice(1);

export const lunesDe = (fecha) => sumarDias(fecha, -diaSemana(fecha));
// "26 oct"
const diaMes = (fecha) => `${+fecha.slice(8, 10)} ${MESES[+fecha.slice(5, 7) - 1]}`;
export const nombreSemana = (lunes) => `del ${diaMes(lunes)} al ${diaMes(sumarDias(lunes, 6))}`;

// El instante (ms UTC) en que empieza un día en la hora local.
function inicioDia(reloj, fecha) {
  const ms = Date.parse(fecha + "T00:00:00Z");
  return ms - reloj.desfase(ms) * 60000;
}

// Lo que se suma de la semana: partidos, en cuántos acertó el favorito y cuántos
// aciertos esperaban sus probabilidades, en total, por tramo de confianza (con el
// entero que enseña la web, como el registro en vivo) y por liga.
export function resumirSemana(partidos) {
  const cero = () => [0, 0, 0];
  const r = { total: cero(), tramos: Object.fromEntries(TRAMOS.map(([k]) => [k, cero()])), ligas: {} };
  for (const e of partidos) {
    const [signo, prob] = favoritoDe(e);
    const paso = e.gl > e.gv ? "1" : e.gl === e.gv ? "X" : "2";
    const n = enterosQueSuman([e.prob_local, e.prob_empate, e.prob_visita])["1X2".indexOf(signo)];
    const tramo = TRAMOS.find(([, min]) => n >= min)[0];
    for (const c of [r.total, r.tramos[tramo], (r.ligas[e.liga_codigo] ??= cero())]) {
      c[0]++;
      if (signo === paso) c[1]++;
      c[2] = Math.round((c[2] + prob / 100) * 1e4) / 1e4;
    }
  }
  return r;
}

// La primera y la última semana con resultados (sus lunes), o null si aún no hay.
async function extremos(almacen, reloj) {
  const db = almacen.db;
  const [primero, ultimo] = await almacen.consultar(() => db.batch(["", " DESC"].map((o) => db.prepare(
    `SELECT utc FROM resultados INDEXED BY resultados_por_fecha WHERE contado = 1 ORDER BY utc${o} LIMIT 1`))));
  const a = primero.results[0], b = ultimo.results[0];
  return a && b ? { primera: lunesDe(reloj.local(Date.parse(a.utc)).fecha), ultima: lunesDe(reloj.local(Date.parse(b.utc)).fecha) }
    : null;
}

// La semana pedida (o, sin ella, la última con resultados), con sus vecinas. Una fuera
// de las que tienen resultados (o mal escrita) no existe.
export async function datosResultados(almacen, reloj, semana = null) {
  const ext = await extremos(almacen, reloj);
  if (!ext) return { estado: "sin_datos", nota: "Todavía no ha terminado ningún partido con el pronóstico publicado." };
  const { primera, ultima } = ext;
  const valida = semana && FECHA.test(semana) && !Number.isNaN(Date.parse(semana));
  const lunes = valida ? lunesDe(semana) : ultima;
  if ((semana && !valida) || lunes < primera || lunes > ultima) {
    return { estado: "no_encontrado", primera, ultima, nota: "No hay resultados de esa semana." };
  }
  const db = almacen.db;
  const filas = await almacen.consultar(() => db.prepare(
    `SELECT r.gl, r.gv, r.utc, ${COLUMNAS} FROM resultados r INDEXED BY resultados_por_fecha
     JOIN predicciones p ON p.id = r.id WHERE r.utc >= ?1 AND r.utc < ?2 AND r.contado = 1 ORDER BY r.utc, r.id`)
    .bind(isoSinMs(inicioDia(reloj, lunes)), isoSinMs(inicioDia(reloj, sumarDias(lunes, 7)))).all());
  const partidos = filas.results.map((x) => {
    const ficha = { utcDate: x.utc };
    for (const c of [...CAMPOS_PARTIDO, "local_id", "visita_id"]) ficha[c] = x["c_" + c];
    const e = entradaDe(ficha, x.gl, x.gv, reloj.local(Date.parse(x.utc)));
    e.local_id = ficha.local_id;
    e.visita_id = ficha.visita_id;
    return e;
  });
  return {
    estado: "listo", plataforma: "cloudflare", semana: lunes, hasta: sumarDias(lunes, 6),
    anterior: lunes > primera ? sumarDias(lunes, -7) : null,
    siguiente: lunes < ultima ? sumarDias(lunes, 7) : null,
    primera, ultima, resumen: resumirSemana(partidos), partidos,
  };
}

const pct = (a, n) => Math.round((100 * a) / n);
const lineaCuenta = ([n, ac, esp]) => `acertó el favorito en ${ac} de ${n} (${pct(ac, n)} %); sus probabilidades`
  + ` esperaban ${Math.round(esp)}`;

// Título, descripción y texto de la página de una semana.
export function textosResultados(d, reloj, propia) {
  const cuando = nombreSemana(d.semana);
  const t = d.resumen.total;
  const descripcion = t[0]
    ? `Semana ${cuando}: ${lineaCuenta(t)}. Lo que dijo la web de cada partido, antes de empezar, contra lo que pasó.`
    : `Semana ${cuando}: sin partidos terminados con el pronóstico publicado.`;
  const p = [`<p class="meta">Semana ${esc(cuando)} · ${cuantos(t[0], "partido terminado", "partidos terminados")}</p>`];
  if (t[0]) {
    p.push(`<p><b>${esc(mayuscula(lineaCuenta(t)))}.</b> Solo cuenta lo publicado antes de`
      + " empezar. Si las probabilidades dicen la verdad, los aciertos se quedan cerca de lo que esperaban.</p>");
    const tramos = { claros: "Favoritos claros (60 % o más)", medios: "Intermedios (45 a 59 %)", renidos: "Reñidos (menos de 45 %)" };
    p.push("<ul>" + TRAMOS.filter(([k]) => d.resumen.tramos[k][0]).map(([k]) =>
      `<li>${esc(tramos[k])}: ${esc(lineaCuenta(d.resumen.tramos[k]))}.</li>`).join("") + "</ul>");
    const ligas = ORDEN.filter((c) => d.resumen.ligas[c]);
    p.push("<h2>Por liga</h2><ul>" + ligas.map((c) =>
      `<li>${enlaceLiga(c, NOMBRES[c])}: ${esc(lineaCuenta(d.resumen.ligas[c]))}.</li>`).join("") + "</ul>");
    const porDia = new Map();
    for (const e of d.partidos) { if (!porDia.has(e.fecha)) porDia.set(e.fecha, []); porDia.get(e.fecha).push(e); }
    for (const [fecha, lista] of porDia) {
      p.push(`<h2>${esc(mayuscula(DIAS_LARGOS[diaSemana(fecha)]))} ${esc(diaMes(fecha))}</h2>`,
        "<ul>" + lista.map((e) => filaResultado(e, e.gl, e.gv, reloj)).join("") + "</ul>");
    }
  }
  const nav = [d.anterior && `<a href="/resultados/${d.anterior}">Semana ${esc(nombreSemana(d.anterior))}</a>`,
    d.siguiente && `<a href="/resultados/${d.siguiente}">Semana ${esc(nombreSemana(d.siguiente))}</a>`,
    '<a href="/">Los partidos de esta semana</a>'].filter(Boolean).join(" · ");
  p.push(`<p class="enlaces">${nav}</p>`);
  return {
    titulo: propia ? `Resultados de la semana ${cuando}` : "Resultados: lo que dijo la web y lo que pasó", descripcion,
    texto: { h1: `Resultados de la semana ${cuando}`, html: `<div class="escrito">${p.join("")}</div>` },
  };
}

export async function apiResultados(almacen, env, semana) {
  return datosResultados(almacen, new Reloj(ajustes(env).tz), semana);
}

export async function paginaResultados(request, env, almacen, semana) {
  let og = null, texto = null;
  try {
    const reloj = new Reloj(ajustes(env).tz);
    const d = await datosResultados(almacen, reloj, semana);
    if (d.estado === "listo") {
      const t = textosResultados(d, reloj, Boolean(semana));
      og = etiquetasOg(new URL(request.url).origin, semana ? `/resultados/${d.semana}` : "/resultados", t.titulo,
        t.descripcion, `${t.titulo} · Pronósticos`);
      texto = t.texto;
    }
  } catch (e) {
    console.error(`/resultados: ${(e && e.stack) || e}`);
  }
  return paginaConTarjeta(request, env, og, texto);
}

// Las semanas con resultados, para el sitemap: de la primera a la última.
export async function semanasConResultados(almacen, reloj) {
  const ext = await extremos(almacen, reloj);
  const out = [];
  if (ext) for (let s = ext.primera; s <= ext.ultima; s = sumarDias(s, 7)) out.push(s);
  return out;
}
