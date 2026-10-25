// La tabla de cada liga y lo que falta de su temporada, para la proyección que
// simula la web (app.js, sección TABLA): cuántas veces sale campeón, entra entre
// los cuatro primeros o desciende cada equipo si juega lo que le queda como dicen
// sus fuerzas de ahora.
//
// Va aparte de la pasada y es lo menos urgente: el cron lo hace en los minutos en
// que no toca actualizar ni validar, con la web al día, una liga por minuto
// (tocaTablas, pasoTablas). Por liga cuesta una petición cada 12 h (la tabla, unos
// pocos KB) y otra cada 24 h (lo que falta, una respuesta grande). Cada partido que
// falta lleva sus goles esperados, con las mismas fuerzas y la misma media de liga
// que los partidos de la semana; la web los simula con Poisson.
//
// Se guarda en D1: lo bajado, en la sección "tablas" de la caché; lo que lee la web,
// en el documento "tabla:PD" (/api/tabla/PD); y cuándo se bajó cada cosa, en el
// documento "tablas_resumen", que el planificador lee cada minuto. Solo en
// Cloudflare: en Render, /api/tabla/... responde no_disponible.

import { HORAS_VALIDEZ_RESTANTES, HORAS_VALIDEZ_TABLA, LIGAS, VERSION_MODELO, ZONAS } from "./config.js";
import { calcularXgPartido, fuerzaEquipo, redondear } from "./modelo.js";
import { SinPresupuesto } from "./api.js";
import { escudo, obtenerFuerzasLiga, obtenerPromedioLiga, soloLiga } from "./actualizacion.js";

export const CODIGOS_TABLA = Object.values(LIGAS);
const NOMBRE_LIGA = Object.fromEntries(Object.entries(LIGAS).map(([n, c]) => [c, n]));
const MS_HORA = 3600000;
// una petición que falló no se repite hasta pasada una hora
const MINUTOS_REINTENTO = 60;
// lo que empezó antes de bajar la tabla y aún no había terminado no está en ella:
// se simula. Un partido dura unas 2 h; con 2 h 30 sobra.
const MARGEN_EN_JUEGO_MS = 2.5 * MS_HORA;

const caducado = (iso, horas, ahora) => !iso || ahora - Date.parse(iso) >= horas * MS_HORA;

// Qué le falta a una liga: la tabla, lo que queda por jugar o el documento (que
// se rehace con cada tabla nueva, y con ella las fuerzas de ese momento).
function falta(x, ahora) {
  if (caducado(x.tabla, HORAS_VALIDEZ_TABLA, ahora)) return "tabla";
  if (caducado(x.restantes, HORAS_VALIDEZ_RESTANTES, ahora)) return "restantes";
  if (!x.doc || x.doc < x.tabla || x.doc < x.restantes) return "documento";
  return null;
}

// La primera liga, en el orden de LIGAS, a la que le falta algo; null si todas están
// al día o si la web no lo está (lo primero son los partidos de la semana).
export function tocaTablas(resumenWeb, resumenTablas, ahora) {
  if (!resumenWeb || (resumenWeb.estado !== "listo" && resumenWeb.estado !== "sin_partidos")) return null;
  for (const c of CODIGOS_TABLA) {
    const x = (resumenTablas && resumenTablas[c]) || {};
    if (!falta(x, ahora)) continue;
    if (x.fallo && ahora - Date.parse(x.fallo) < MINUTOS_REINTENTO * 60000) continue;
    return c;
  }
  return null;
}

// La clasificación de la API (la total, no la de casa ni la de fuera), compacta.
export function filasTabla(cuerpo) {
  const st = (cuerpo && cuerpo.standings) || [];
  const total = st.find((s) => s.type === "TOTAL") || st[0];
  return ((total && total.table) || []).filter((f) => f.team && f.team.id != null).map((f) => ({
    id: f.team.id, nombre: f.team.name, corto: f.team.shortName ?? null, sigla: f.team.tla ?? null,
    escudo: escudo(f.team), pos: f.position, pj: f.playedGames, g: f.won, e: f.draw, p: f.lost,
    gf: f.goalsFor, gc: f.goalsAgainst, pts: f.points,
  }));
}

// Lo que queda por jugar, compacto: [utcDate, local, visita, aplazado].
export function restantesDe(matches) {
  return soloLiga(matches || []).filter((m) => m.homeTeam && m.homeTeam.id != null && m.awayTeam && m.awayTeam.id != null)
    .map((m) => [m.utcDate, m.homeTeam.id, m.awayTeam.id, m.status === "POSTPONED" ? 1 : 0]);
}

// Lo que lee la web: la tabla y cada partido que falta con sus goles esperados
// ([i local, i visita, xg local, xg visita], índices en equipos). De lo que falta
// solo entra lo que no estaba terminado al bajar la tabla (y los aplazados).
export async function documentoTabla(ctx, codigo, datos, cuando) {
  const fuerzas = await obtenerFuerzasLiga(ctx, codigo);
  const promedio = await obtenerPromedioLiga(ctx, codigo);
  const equipos = datos.tabla;
  const idx = new Map(equipos.map((e, i) => [e.id, i]));
  const corte = Date.parse(cuando.tabla) - MARGEN_EN_JUEGO_MS;
  const restantes = [];
  for (const [utc, local, visita, aplazado] of datos.restantes || []) {
    if (!idx.has(local) || !idx.has(visita) || (!aplazado && Date.parse(utc) < corte)) continue;
    const [xl, xv] = calcularXgPartido(fuerzaEquipo(fuerzas, local), fuerzaEquipo(fuerzas, visita), promedio);
    restantes.push([idx.get(local), idx.get(visita), redondear(xl, 3), redondear(xv, 3)]);
  }
  return {
    estado: "listo", liga: codigo, nombre: NOMBRE_LIGA[codigo], tabla_actualizada: cuando.tabla,
    restantes_actualizados: cuando.restantes, version_modelo: VERSION_MODELO, zonas: ZONAS[codigo],
    equipos, restantes,
  };
}

// Un paso para una liga: baja lo que le falte (una cosa por minuto) y rehace su
// documento. Si las fuerzas de la liga hay que recalcularlas y ya no caben en este
// minuto (SinPresupuesto), el documento queda pendiente para el siguiente.
export async function pasoTablas(ctx, almacen, codigo, resumenTablas) {
  const ahora = Date.now();
  const resumen = { ...(resumenTablas || {}) };
  const x = { ...(resumen[codigo] || {}) };
  const datos = { ...(ctx.cache.get("tablas", codigo) || {}) };
  const que = falta(x, ahora);
  let hecho = null;
  if (que === "tabla") {
    const r = await ctx.api.get(`/competitions/${codigo}/standings`);
    const filas = r.status === 200 ? filasTabla(r.cuerpo) : [];
    if (filas.length) { datos.tabla = filas; x.tabla = ctx.ahoraIso(); hecho = "tabla"; }
    else x.fallo = ctx.ahoraIso();
  } else if (que === "restantes") {
    const r = await ctx.api.get(`/competitions/${codigo}/matches`, { status: "SCHEDULED,TIMED,POSTPONED" }, { grande: true });
    if (r.status === 200) { datos.restantes = restantesDe(r.cuerpo.matches); x.restantes = ctx.ahoraIso(); hecho = "restantes"; }
    else x.fallo = ctx.ahoraIso();
  }
  if (hecho) { ctx.cache.poner("tablas", codigo, datos); delete x.fallo; }
  const sentencias = [];
  if (datos.tabla && datos.restantes) {
    try {
      const doc = await documentoTabla(ctx, codigo, datos, x);
      sentencias.push(almacen.sentenciaDoc("tabla:" + codigo, doc));
      x.doc = ctx.ahoraIso();
      hecho = hecho ? hecho + " y documento" : "documento";
    } catch (e) {
      if (!(e instanceof SinPresupuesto)) throw e;
    }
  }
  resumen[codigo] = x;
  sentencias.push(...almacen.sentenciasCache(ctx.cache), almacen.sentenciaDoc("tablas_resumen", resumen));
  await almacen.escribir(sentencias);
  return hecho;
}
