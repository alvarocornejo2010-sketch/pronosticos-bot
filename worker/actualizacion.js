// La pasada de actualización: el mismo recorrido que correr_actualizacion en
// app.py, con las mismas cachés, validez y orden. Lo que cambia es el ritmo: en
// vez de una pasada de 40 peticiones cada 5 minutos, una de 6 cada minuto (el
// cron), y lo que no da tiempo queda pendiente para la siguiente.
//
// Y cómo se guarda, porque cada ejecución tiene 10 ms de CPU: el calendario va
// en la tabla partidos, con la ficha de cada partido ya en JSON, y las
// predicciones también en JSON. Montar lo que lee la web es pegar textos que
// salen de una sola consulta, sin leer (JSON.parse) partido por partido.

import {
  CODIGOS_TORNEO, COMPETICIONES, DIAS_SEMANA, DIAS_VALIDEZ_LIGA_EQUIPO, DIAS_VALIDEZ_PRIOR, FACTOR_LIGA,
  FACTOR_OTRA_LIGA, HORAS_VALIDEZ_LIGA, HORAS_VALIDEZ_PREDICCION, K_LIGA, LIGAS, LIGAS_ANO_NATURAL,
  FORMATO_LISTAS, LIGA_DE_ARRIBA, PRIOR_AVG_LOCAL, PRIOR_AVG_VISITA, VERSION_MODELO,
} from "./config.js";
import {
  ajustarFuerzas, calcularPoisson, calcularXgChampions, calcularXgPartido, equiposDePartidos, fuerzaEquipo,
  fuerzasDesdeLiga, mercadosDeGoles, multiplicadoresHistorial, redondear, sumarHistorial,
} from "./modelo.js";
import { SinPresupuesto, UMBRAL_GRANDE } from "./api.js";
import { DIAS_LIQUIDAR, MARGEN_TERMINADO_MS, isoSinMs, liquidar } from "./registro.js";
import { diaSemana, diasEntre, sumarDias } from "./tiempo.js";

const MS_DIA = 86400000;

// Lo que en app.py son variables globales y la caché que se pasa de función en
// función: el reloj, la caché, el cliente de la API y los ajustes.
export class Contexto {
  constructor({ reloj, cache, api, ajustes, almacen }) {
    this.reloj = reloj;
    this.cache = cache;
    this.api = api;
    this.aj = ajustes;
    this.almacen = almacen;
    this.hoy = reloj.local(Date.now()).fecha;
    // fallos ya vistos en esta pasada: no se repite la misma petición fallida
    // partido tras partido (app.py la repetía, gastando cuota en lo mismo)
    this.fallos = new Map();
    // los marcadores de lo ya jugado que se bajaron en esta pasada, por
    // competición: el registro en vivo los cruza con lo publicado (registro.js)
    this.resultados = new Map();
  }

  ahoraIso() {
    return this.reloj.iso(Date.now());
  }

  vigente(iso, dias) {
    return Boolean(iso) && Date.now() - Date.parse(iso) < dias * MS_DIA;
  }
}

// ==========================================
// ANCLA POR LIGA (temporada anterior)
// ==========================================
export function temporadaActual(reloj, codigoLiga = null) {
  const { anio, mes } = reloj.local(Date.now());
  if (LIGAS_ANO_NATURAL.has(codigoLiga)) return anio;
  return mes >= 7 ? anio : anio - 1;
}

// Goles a los 90 minutos (goles_90 en app.py): con prórroga o penaltis,
// fullTime es el resultado final y manda regularTime. En liga no cambia nada.
function goles90(m) {
  const score = m.score || {};
  if (score.duration === "EXTRA_TIME" || score.duration === "PENALTY_SHOOTOUT") {
    const rt = score.regularTime || {};
    if (rt.home != null && rt.away != null) return [rt.home, rt.away];
  }
  const ft = score.fullTime || {};
  return [ft.home ?? null, ft.away ?? null];
}

const sumarGoles = (matches) => {
  let gl = 0, gv = 0, n = 0;
  for (const m of matches || []) {
    const [a, b] = goles90(m);
    if (a == null || b == null) continue;
    gl += a; gv += b; n += 1;
  }
  return { gl, gv, n };
};

// {id: [[rival, en casa (1/0), a favor, en contra], ...]}: el historial de un
// torneo, como historial_de_partidos en app.py.
function historialDePartidos(matches) {
  const hist = {};
  for (const m of matches || []) {
    const [gl, gv] = goles90(m);
    const loc = (m.homeTeam || {}).id, vis = (m.awayTeam || {}).id;
    if (gl == null || gv == null || loc == null || vis == null) continue;
    (hist[String(loc)] ||= []).push([vis, 1, gl, gv]);
    (hist[String(vis)] ||= []).push([loc, 0, gv, gl]);
  }
  return hist;
}

// Número de día (desde el 1/1/1970) de una fecha de la API (dia_de en app.py).
export const diaDe = (utcDate) => Math.floor(Date.parse(utcDate.slice(0, 10) + "T00:00:00Z") / MS_DIA);

// [[día, local, visita, gl, gv], ...] de los partidos con resultado, por fecha
// (partidos_compactos en app.py): lo que necesita ajustarFuerzas.
export function partidosCompactos(matches) {
  const out = [];
  for (const m of (matches || []).slice().sort(porFecha)) {
    const [gl, gv] = goles90(m);
    const loc = (m.homeTeam || {}).id, vis = (m.awayTeam || {}).id;
    if (gl == null || gv == null || loc == null || vis == null || !m.utcDate) continue;
    out.push([diaDe(m.utcDate), loc, vis, gl, gv]);
  }
  return out;
}

// Los partidos de la fase de liga, sin playoffs (solo_liga en app.py): los de
// ascenso de la Championship no son liga. Un partido sin stage cuenta; si el filtro
// dejara menos de la mitad, se quedan todos.
export function soloLiga(matches) {
  const todos = matches || [];
  const liga = todos.filter((m) => m.stage == null || m.stage === "REGULAR_SEASON");
  return 2 * liga.length >= todos.length ? liga : todos;
}

// La lista de partidos guardada de una liga, si es de esa temporada (y sin playoffs).
function listaVigente(ctx, clave, temporada) {
  const e = ctx.cache.get("partidos_liga", clave);
  return e && e.temporada === temporada && e.formato === FORMATO_LISTAS ? e : null;
}

async function obtenerPriorLiga(ctx, codigo) {
  const entry = ctx.cache.get("priors", codigo);
  const season = temporadaActual(ctx.reloj, codigo) - 1;
  const esTorneo = CODIGOS_TORNEO.has(codigo);
  // la temporada también cuenta (en julio la "anterior" pasa a ser otra); un
  // torneo guarda además su historial por equipo, y una liga, sus partidos
  if (entry && ctx.vigente(entry.actualizado, DIAS_VALIDEZ_PRIOR) && entry.temporada === season
      && (esTorneo ? "historial" in entry : listaVigente(ctx, codigo + ":previa", season))) return entry;

  const respaldo = { avg_local: PRIOR_AVG_LOCAL, avg_visita: PRIOR_AVG_VISITA,
    origen: "constante de respaldo", partidos: 0, actualizado: null };
  if (ctx.fallos.has("prior:" + codigo)) return respaldo;

  const r = await ctx.api.get(`/competitions/${codigo}/matches`, { season, status: "FINISHED" }, { grande: true });
  if (r.status !== 200) {
    console.warn(`Prior ${codigo}: temporada ${season} no disponible (HTTP ${r.status}). Se usa la constante de respaldo.`);
    ctx.fallos.set("prior:" + codigo, true);
    return respaldo;
  }
  const matches = esTorneo ? r.cuerpo.matches : soloLiga(r.cuerpo.matches);
  const { gl, gv, n } = sumarGoles(matches);
  // con media temporada o menos sería un ancla tan ruidosa como el problema
  if (n < 100) {
    console.warn(`Prior ${codigo}: solo ${n} partidos en ${season}, insuficiente.`);
    ctx.fallos.set("prior:" + codigo, true);
    return respaldo;
  }
  const nueva = { avg_local: gl / n, avg_visita: gv / n, origen: `temporada ${season}`, partidos: n,
    temporada: season, actualizado: ctx.ahoraIso() };
  if (esTorneo) nueva.historial = historialDePartidos(matches);
  else {
    ctx.cache.poner("partidos_liga", codigo + ":previa", { temporada: season,
      partidos: partidosCompactos(matches), actualizado: nueva.actualizado, formato: FORMATO_LISTAS });
  }
  ctx.cache.poner("priors", codigo, nueva);
  return nueva;
}

// ==========================================
// PROMEDIO DE GOLES POR LIGA
// ==========================================
// Si la media de una liga en caché sirve tal cual (un torneo necesita además su
// historial, y una liga, sus partidos de esta temporada).
const ligaVigente = (ctx, codigo, e) => Boolean(e && ctx.vigente(e.actualizado, HORAS_VALIDEZ_LIGA / 24)
  && (CODIGOS_TORNEO.has(codigo) ? "historial" in e
    : listaVigente(ctx, codigo + ":actual", temporadaActual(ctx.reloj, codigo))));

// forzar: aunque la de la caché siga valiendo (lo usa el registro en vivo).
export async function obtenerPromedioLiga(ctx, codigo, forzar = false) {
  const entry = ctx.cache.get("ligas", codigo);
  if (!forzar && ligaVigente(ctx, codigo, entry)) return entry;
  const fallo = ctx.fallos.get("liga:" + codigo);
  if (fallo) return fallo;

  const prior = await obtenerPriorLiga(ctx, codigo);
  const r = await ctx.api.get(`/competitions/${codigo}/matches`, { status: "FINISHED" }, { grande: true });
  if (r.status !== 200) {
    console.warn(`Liga ${codigo}: HTTP ${r.status}, uso solo el prior.`);
    const soloPrior = { avg_local: prior.avg_local, avg_visita: prior.avg_visita, partidos: 0,
      prior: prior.origen, actualizado: null };
    ctx.fallos.set("liga:" + codigo, soloPrior);
    return soloPrior;
  }
  const esTorneo = CODIGOS_TORNEO.has(codigo);
  const matches = esTorneo ? r.cuerpo.matches : soloLiga(r.cuerpo.matches);
  const { gl, gv, n } = sumarGoles(matches);
  // se mezcla con el prior histórico, que pesa menos conforme avanza la temporada
  const promedio = {
    avg_local: (gl + K_LIGA * prior.avg_local) / (n + K_LIGA),
    avg_visita: (gv + K_LIGA * prior.avg_visita) / (n + K_LIGA),
    partidos: n,
    prior: prior.origen,
    prior_local: redondear(prior.avg_local, 3),
    prior_visita: redondear(prior.avg_visita, 3),
    actualizado: ctx.ahoraIso(),
  };
  if (esTorneo) promedio.historial = historialDePartidos(matches);
  else {
    ctx.cache.poner("partidos_liga", codigo + ":actual", { temporada: temporadaActual(ctx.reloj, codigo),
      partidos: partidosCompactos(matches), actualizado: promedio.actualizado, formato: FORMATO_LISTAS });
  }
  ctx.cache.poner("ligas", codigo, promedio);
  const goles = new Map();
  for (const m of r.cuerpo.matches || []) {
    const [a, b] = goles90(m);
    if (m.id != null && a != null && b != null) goles.set(m.id, [a, b]);
  }
  ctx.resultados.set(codigo, { goles, media: promedio });
  return promedio;
}

// ==========================================
// FUERZAS DE UNA LIGA (obtener_fuerzas_liga en app.py)
// ==========================================
const porFecha = (a, b) => {
  const x = a.utcDate || "", y = b.utcDate || "";
  return x < y ? -1 : x > y ? 1 : 0;
};

// Las de todos los equipos de una liga, con las listas que ya bajaron
// obtenerPriorLiga y obtenerPromedioLiga (y, en una liga con LIGA_DE_ARRIBA, la
// temporada anterior de la de arriba): no piden nada más, y se recalculan (y
// guardan en D1) solo cuando cambia alguna lista. Como mucho un ajuste por
// pasada y nunca en la misma que una respuesta grande (leerla ya gasta casi la
// mitad de la CPU): lo que no cabe espera al minuto siguiente. En frío, recién
// creado el isolate, un ajuste de la Championship cuesta unos 4 ms; ya
// compilado, unos 0.2.
export async function obtenerFuerzasLiga(ctx, codigo) {
  const promedio = await obtenerPromedioLiga(ctx, codigo);
  const season = temporadaActual(ctx.reloj, codigo);
  const previa = listaVigente(ctx, codigo + ":previa", season - 1) || {};
  const actual = listaVigente(ctx, codigo + ":actual", season) || {};
  let version = `${VERSION_MODELO}|${previa.actualizado ?? null}|${actual.actualizado ?? null}`
    + `|${promedio.actualizado ?? null}`;
  let arriba = {};
  if (codigo in LIGA_DE_ARRIBA) {
    const sup = LIGA_DE_ARRIBA[codigo];
    await obtenerPriorLiga(ctx, sup);
    arriba = listaVigente(ctx, sup + ":previa", temporadaActual(ctx.reloj, sup) - 1) || {};
    version += `|${arriba.actualizado ?? null}`;
  }
  const guardadas = ctx.cache.get("fuerzas", codigo);
  if (guardadas && guardadas.version === version) return guardadas;
  if (ctx.api.bytes > UMBRAL_GRANDE || ctx.api.pesada) {
    throw new SinPresupuesto("el ajuste de fuerzas va en la pasada siguiente");
  }
  ctx.api.pesada = true;
  const fuerzas = ajustarFuerzas(previa.partidos || [], actual.partidos || [], promedio, null, codigo,
    equiposDePartidos(arriba.partidos || []));
  fuerzas.version = version;
  ctx.cache.poner("fuerzas", codigo, fuerzas);
  return fuerzas;
}

// ==========================================
// CHAMPIONS: la fuerza de cada equipo, medida en su liga nacional
// ==========================================
async function ligaDomestica(ctx, teamId) {
  const clave = String(teamId);
  const entrada = ctx.cache.get("liga_equipo", clave);
  // un fallo se recuerda un día, para no reintentarlo en cada pasada
  const dias = entrada && entrada.fallo ? 1 : DIAS_VALIDEZ_LIGA_EQUIPO;
  if (entrada && ctx.vigente(entrada.actualizado, dias)) return entrada.liga;

  // primero, gratis, en los calendarios de liga ya descargados
  let liga = await ctx.almacen.ligaDeEquipo(teamId, Object.values(LIGAS));
  if (liga === null) {
    const r = await ctx.api.get(`/teams/${teamId}`);
    if (r.status !== 200) {
      console.warn(`Equipo ${teamId}: HTTP ${r.status} al buscar su liga, cuenta como otra liga.`);
      ctx.cache.poner("liga_equipo", clave, { liga: null, fallo: true, actualizado: ctx.ahoraIso() });
      return null;
    }
    const codigos = (r.cuerpo.runningCompetitions || []).map((c) => c.code);
    liga = Object.values(LIGAS).find((c) => codigos.includes(c)) ?? null;
  }
  ctx.cache.poner("liga_equipo", clave, { liga, actualizado: ctx.ahoraIso() });
  return liga;
}

// Los partidos de Champions de esta temporada y la anterior de un equipo
// (historial_champions en app.py). Los bajaron ya obtenerPromedioLiga y
// obtenerPriorLiga; solo puede costar alguna petición la liga de un rival que
// aún no esté en la caché.
const entradasHistorial = (ctx) => [ctx.cache.get("ligas", "CL"), ctx.cache.get("priors", "CL")];

async function historialChampions(ctx, teamId, factor) {
  const entradas = entradasHistorial(ctx);
  const niveles = new Map();
  for (const e of entradas) {
    for (const [rival] of ((e && e.historial) || {})[String(teamId)] || []) {
      if (!niveles.has(rival)) niveles.set(rival, FACTOR_LIGA[await ligaDomestica(ctx, rival)] ?? FACTOR_OTRA_LIGA);
    }
  }
  return sumarHistorial(entradas, teamId, factor, (rival) => niveles.get(rival));
}

async function fuerzasChampions(ctx, teamId) {
  const liga = await ligaDomestica(ctx, teamId);
  const factor = FACTOR_LIGA[liga] ?? FACTOR_OTRA_LIGA;
  const h = await historialChampions(ctx, teamId, factor);
  const [ataqueCl, defensaCl] = multiplicadoresHistorial(h);
  const historial = { partidos_cl: h.partidos, ataque_cl: ataqueCl, defensa_cl: defensaCl };
  if (liga === null) {
    return { liga: null, nombre_liga: null, factor: FACTOR_OTRA_LIGA, ataque: 1.0, defensa: 1.0, muestra: 0,
      ...historial };
  }
  const f = fuerzasDesdeLiga(fuerzaEquipo(await obtenerFuerzasLiga(ctx, liga), teamId));
  const nombre = Object.keys(LIGAS).find((k) => LIGAS[k] === liga) ?? liga;
  return { liga, nombre_liga: nombre, factor, ...f, ...historial };
}

// ==========================================
// CALENDARIO
// ==========================================
export function etiquetaDeDia(fecha, hoy) {
  const dias = diasEntre(hoy, fecha);
  if (dias === 0) return "Hoy";
  if (dias === 1) return "Mañana";
  const d = DIAS_SEMANA[diaSemana(fecha)];
  return d[0].toUpperCase() + d.slice(1);
}

// URL del escudo solo si es https: va a un <img src> en la web.
export const escudo = (equipo) => {
  const url = (equipo && equipo.crest) || "";
  return url.startsWith("https://") ? url : null;
};

// Los datos del partido que se conocen sin gastar ni una petición: nombres
// cortos, siglas y escudos vienen en la misma respuesta del calendario.
function fichaBase(m, codigo, nombreLiga, hora) {
  const local = m.homeTeam, visita = m.awayTeam;
  return {
    id: m.id,
    local: local.name,
    visita: visita.name,
    // el id de cada equipo: la web enlaza con su página (#/equipo/86, equipos.js)
    local_id: local.id,
    visita_id: visita.id,
    local_corto: local.shortName ?? null,
    visita_corto: visita.shortName ?? null,
    local_sigla: local.tla ?? null,
    visita_sigla: visita.tla ?? null,
    local_escudo: escudo(local),
    visita_escudo: escudo(visita),
    liga: nombreLiga,
    // código estable ("PD", "PL"...) para que la web agrupe sin depender del nombre
    liga_codigo: codigo,
    hora,
    utcDate: m.utcDate,
  };
}

// Orden de desempate entre partidos a la misma hora: el de app.py, que recorre
// las competiciones en orden y dentro de cada una respeta el de la API.
const ORDEN_COMPETICION = Object.fromEntries(Object.values(COMPETICIONES).map((c, i) => [c, i]));

// Un partido de la respuesta de la API, como fila de la tabla partidos. null si
// es un cruce de eliminatoria aún sin decidir (equipo sin id): no se pinta.
function filaPartido(ctx, m, codigo, nombreLiga, posicion) {
  if (!(m.homeTeam || {}).id || !(m.awayTeam || {}).id || !m.utcDate) return null;
  const ms = Date.parse(m.utcDate);
  const local = ctx.reloj.local(ms);
  return {
    id: m.id,
    liga: codigo,
    utc: new Date(ms).toISOString().slice(0, 19) + "Z",
    fecha: local.fecha,
    orden: ORDEN_COMPETICION[codigo] * 100000 + posicion,
    local_id: m.homeTeam.id,
    visita_id: m.awayTeam.id,
    base: JSON.stringify(fichaBase(m, codigo, nombreLiga, local.hora)),
  };
}

// Un calendario que falló sin nada guardado del mismo rango se reintenta a los
// 5 minutos, como el tick de app.py, no a cada minuto.
const MINUTOS_REINTENTO_CALENDARIO = 5;

// Un partido por jugar que deja de venir en el calendario se quita cuando falta
// en estas descargas seguidas. football-data a veces responde 200 con la lista
// incompleta: el 21 oct 2026 dio 5 de los 11 partidos de LaLiga de la semana, y
// los otros 6 seguían programados. Uno aplazado de verdad tarda así una descarga
// más en irse (2 h).
const VECES_AUSENTE = 2;

// Baja el calendario de las competiciones que lo tengan caducado (cada
// HORAS_VALIDEZ_FIXTURES, o al cambiar el día) y lo deja en la tabla partidos.
// Usa /competitions/{codigo}/matches y NO /v4/matches: en el plan free el
// global responde 200 con la lista vacía. Devuelve el origen de cada uno.
async function refrescarCalendarios(ctx, almacen, forzar) {
  const hoy = ctx.hoy;
  const hasta = sumarDias(hoy, ctx.aj.maxDiasBusqueda);
  const rango = `${hoy}/${hasta}`;
  const ahoraMs = Date.now();
  const validezMs = ctx.aj.horasValidezFixtures * 3600000;
  const origen = {};
  const sentencias = [];

  for (const [nombreLiga, codigo] of Object.entries(COMPETICIONES)) {
    const meta = ctx.cache.get("calendario", codigo);
    const edadMs = meta && meta.actualizado ? ahoraMs - Date.parse(meta.actualizado) : Infinity;
    const vigente = meta && !forzar && meta.rango === rango
      && (meta.fallo ? edadMs < MINUTOS_REINTENTO_CALENDARIO * 60000 : edadMs < validezMs);
    if (vigente) {
      origen[codigo] = meta.fallo
        ? { origen: "API", http_status: meta.http_status, mensaje_api: null }
        : { origen: `caché (${Math.trunc(edadMs / 60000)} min)`, http_status: null };
      continue;
    }

    let r;
    try {
      r = await ctx.api.get(`/competitions/${codigo}/matches`, {
        dateFrom: hoy, dateTo: hasta, status: "SCHEDULED,TIMED",   // solo lo que aún no se ha jugado
      }, { calendario: true });
    } catch (e) {
      if (!(e instanceof SinPresupuesto)) throw e;
      r = { status: 429, cuerpo: null };
    }
    origen[codigo] = { origen: "API", http_status: r.status,
      mensaje_api: (r.status === 200 ? r.cuerpo.message : null) ?? null };
    if (r.status === 200) {
      const matches = r.cuerpo.matches || [];
      const filas = matches.map((m, i) => filaPartido(ctx, m, codigo, nombreLiga, i)).filter(Boolean);
      // los que estaban, aún no han empezado y no vienen: se quedan hasta faltar VECES_AUSENTE veces
      const llegan = new Set(filas.map((f) => f.id));
      const antes = (meta && meta.ausentes) || {};
      const ausentes = {};
      for (const p of await almacen.partidosPorJugar(codigo, isoSinMs(ahoraMs))) {
        if (llegan.has(p.id)) continue;
        const veces = (antes[p.id] || 0) + 1;
        if (veces < VECES_AUSENTE) ausentes[p.id] = veces;
      }
      const conservados = Object.keys(ausentes).map(Number);
      if (conservados.length) {
        console.warn(`Calendario ${codigo}: faltan ${conservados.length} partidos que venían antes `
          + `(${conservados.join(", ")}); se conservan hasta la próxima descarga.`);
      }
      sentencias.push(almacen.sentenciaBorrarPartidosSalvo(codigo, conservados));
      for (const fila of filas) sentencias.push(almacen.sentenciaPartido(fila));
      ctx.cache.poner("calendario", codigo, { rango, actualizado: ctx.ahoraIso(), en_lista: matches.length,
        ...(conservados.length ? { ausentes } : {}) });
    } else if (meta && meta.rango === rango && !meta.fallo) {
      // la API falló pero había algo del mismo rango: mejor eso que nada
      origen[codigo].origen = "caché (la API falló)";
    } else if (r.status !== 429) {
      // los partidos que ya había (de otro día) se quedan: siguen siendo partidos, y
      // borrarlos dejaba la liga vacía en la web hasta el reintento
      ctx.cache.poner("calendario", codigo, { ...(meta || {}), rango, actualizado: ctx.ahoraIso(), en_lista: 0,
        fallo: true, http_status: r.status });
    }
  }
  if (sentencias.length) await almacen.escribir([...sentencias, ...almacen.sentenciasCache(ctx.cache)]);
  return { origen, rango };
}

// ==========================================
// FICHAS Y ESTADO
// ==========================================
const sigueFresca = (calculado) => Boolean(calculado)
  && Date.now() - Date.parse(calculado) < HORAS_VALIDEZ_PREDICCION * 3600000;

// Cada cuánto se escribe el progreso a mitad de pasada: la web lo sondea cada
// 4 s, y reescribir el JSON entero después de cada partido gastaría CPU.
const MS_ENTRE_PROGRESOS = 15000;

// Los partidos por jugar de la ventana, en el orden de la web, cada uno con su
// JSON. pendiente: hay que calcularlo, porque no tiene predicción, porque la
// suya ya pasó de HORAS_VALIDEZ_PREDICCION o porque es de otra versión del modelo
// (al cambiar VERSION_MODELO se rehacen todas en unos minutos). Si la tenía, la
// web la sigue enseñando mientras se recalcula (sinNumeros = false): como se
// calculan casi todas a la vez, caducan casi a la vez, y si no media semana salía
// sin números el rato que dura el recálculo (app.py las dejaba sin números).
async function leerVentana(ctx, almacen) {
  const ahoraUtc = new Date().toISOString().slice(0, 19) + "Z";
  const filas = await almacen.ventana(ahoraUtc);
  const reguardar = [];
  for (const f of filas) {
    if (f.ficha === null) {
      f.pendiente = true;
      f.sinNumeros = true;
      f.json = f.base.slice(0, -1) + ',"pendiente":true}';
      continue;
    }
    f.pendiente = !sigueFresca(f.calculado) || f.version !== VERSION_MODELO;
    f.sinNumeros = false;
    if (f.base_pred !== f.base) {
      // el calendario cambió la hora, un nombre o un escudo: la ficha se
      // rehace con lo nuevo sin recalcular los números (app.py seguía
      // enseñando la hora vieja hasta recalcular). Si toca recalcularla, se
      // guarda al recalcular.
      const ficha = Object.assign(JSON.parse(f.ficha), JSON.parse(f.base));
      f.ficha = JSON.stringify(ficha);
      if (!f.pendiente) reguardar.push(almacen.sentenciaPrediccion(ficha, f.ficha, f.base));
    }
    f.json = f.ficha;
  }
  return { filas, reguardar };
}

// El JSON que lee la web, montado pegando el de cada partido. pendientes son
// los que la web enseña sin números; recalculando, los que aún enseñan los de
// antes.
function construirEstado(ctx, filas, estadoTexto, debug) {
  let pendientes = 0, recalculando = 0;
  const trozos = [];
  let fecha = null, pj = null;
  for (const f of filas) {
    if (f.fecha !== fecha) {
      if (pj) trozos.push(cerrarDia(ctx, fecha, pj));
      fecha = f.fecha;
      pj = [];
    }
    if (f.sinNumeros) pendientes += 1;
    else if (f.pendiente) recalculando += 1;
    pj.push(f.json);
  }
  if (pj) trozos.push(cerrarDia(ctx, fecha, pj));
  const resumen = {
    estado: estadoTexto, total: filas.length, pendientes, requests_gastadas: ctx.api.gastadas,
    ultima_actualizacion: ctx.ahoraIso(), plataforma: "cloudflare",
  };
  const cabeza = JSON.stringify(resumen).slice(1, -1);
  const texto = `{${cabeza},"dias":[${trozos.join(",")}],"debug_busqueda":${JSON.stringify(debug)}}`;
  // recalculando va solo en el resumen (lo lee el cron): /api/estado sigue igual que en app.py
  return { texto, resumen: { ...resumen, recalculando } };
}

const cerrarDia = (ctx, fecha, pj) =>
  `{"fecha":${JSON.stringify(fecha)},"etiqueta":${JSON.stringify(etiquetaDeDia(fecha, ctx.hoy))},"partidos":[${pj.join(",")}]}`;

// Lo que app.py llamaba debug_busqueda: de dónde salió cada calendario.
function construirDebug(ctx, calendarios, filas) {
  const porJugar = {};
  for (const f of filas) porJugar[f.liga] = (porJugar[f.liga] || 0) + 1;
  const hora = ctx.ahoraIso();
  return Object.values(COMPETICIONES).map((codigo) => {
    const meta = ctx.cache.get("calendario", codigo) || {};
    return { liga: codigo, ...calendarios.origen[codigo], rango_consultado: calendarios.rango,
      en_lista: meta.en_lista ?? 0, por_jugar: porJugar[codigo] || 0, hora_servidor_local: hora };
  });
}

// ==========================================
// CÁLCULO DE UN PARTIDO
// ==========================================
// ¿Se puede calcular este partido sin pedir nada a la API? Mira lo mismo que
// miran las funciones de arriba antes de pedir. Solo ahorra trabajo: si se
// equivoca, calcularPartido pide, le salta SinPresupuesto y el partido espera.
// Las fuerzas no piden nada: salen de las listas de la liga.
function todoEnCache(ctx, f) {
  const ligaLista = (c) => ligaVigente(ctx, c, ctx.cache.get("ligas", c)) || ctx.fallos.has("liga:" + c);
  const ligaConocida = (id) => {
    const e = ctx.cache.get("liga_equipo", String(id));
    return Boolean(e && ctx.vigente(e.actualizado, e.fallo ? 1 : DIAS_VALIDEZ_LIGA_EQUIPO));
  };
  if (!ligaLista(f.liga)) return false;
  if (!CODIGOS_TORNEO.has(f.liga)) return true;
  // la liga de cada rival de su historial, que da su nivel
  const entradas = entradasHistorial(ctx);
  return [f.local_id, f.visita_id].every((id) => {
    if (!ligaConocida(id)) return false;
    const e = ctx.cache.get("liga_equipo", String(id));
    if (e.liga !== null && !ligaLista(e.liga)) return false;
    return entradas.every((x) => (((x && x.historial) || {})[String(id)] || []).every(([rival]) => ligaConocida(rival)));
  });
}

async function calcularPartido(ctx, f) {
  const codigo = f.liga;
  const promedioLiga = await obtenerPromedioLiga(ctx, codigo);
  const extra = {};
  let xgLocal, xgVisita, muestraLocal, muestraVisita;
  if (CODIGOS_TORNEO.has(codigo)) {
    const fl = await fuerzasChampions(ctx, f.local_id);
    const fv = await fuerzasChampions(ctx, f.visita_id);
    [xgLocal, xgVisita] = calcularXgChampions(fl, fv, promedioLiga);
    muestraLocal = fl.muestra; muestraVisita = fv.muestra;
    // de qué liga sale cada equipo, con qué nivel y qué dice su historial en la
    // Champions: la web lo explica
    const lado = (x) => ({ liga: x.liga, nombre_liga: x.nombre_liga, factor: x.factor, partidos_cl: x.partidos_cl,
      ataque_cl: redondear(x.ataque_cl, 2), defensa_cl: redondear(x.defensa_cl, 2) });
    extra.champions = { local: lado(fl), visita: lado(fv) };
  } else {
    const fuerzas = await obtenerFuerzasLiga(ctx, codigo);
    const fl = fuerzaEquipo(fuerzas, f.local_id), fv = fuerzaEquipo(fuerzas, f.visita_id);
    [xgLocal, xgVisita] = calcularXgPartido(fl, fv, promedioLiga);
    muestraLocal = fl.partidos; muestraVisita = fv.partidos;
  }
  return {
    ...JSON.parse(f.base),
    xg_local: xgLocal, xg_visita: xgVisita,
    // la media de goles de la liga con la que se calculó: la base "equipo medio"
    // del registro en vivo
    media_local: redondear(promedioLiga.avg_local, 3), media_visita: redondear(promedioLiga.avg_visita, 3),
    version_modelo: VERSION_MODELO,
    // cuántos partidos de liga (esta temporada y la anterior) hay detrás de cada equipo
    muestra_local: muestraLocal,
    muestra_visita: muestraVisita,
    calculado: ctx.ahoraIso(),
    pendiente: false,
    ...calcularPoisson(xgLocal, xgVisita),
    ...mercadosDeGoles(xgLocal, xgVisita, promedioLiga),
    ...extra,
  };
}

// ==========================================
// REGISTRO EN VIVO
// ==========================================
// Lo jugado de cada competición se baja cada HORAS_VALIDEZ_LIGA, pero solo
// cuando lo pide el cálculo de uno de sus partidos. Para la última jornada de
// una temporada, o la de antes de un parón, ya no lo pide nadie, y sus
// predicciones no se medirían nunca. Así que, con la ventana al día, se mira qué
// competiciones tienen partidos ya terminados sin resultado y una lista de lo
// jugado de antes de que acabaran, y se vuelve a bajar la de una (es una
// respuesta grande). Unas pocas peticiones a la semana.
async function refrescarParaRegistro(ctx, almacen) {
  const ahora = Date.now();
  const ligas = await almacen.ligasConPendientes(isoSinMs(ahora - DIAS_LIQUIDAR * MS_DIA),
    isoSinMs(ahora - MARGEN_TERMINADO_MS));
  for (const { liga, primera } of ligas) {
    if (ctx.resultados.has(liga) || !(liga in ORDEN_COMPETICION)) continue;
    const e = ctx.cache.get("ligas", liga);
    if (e && e.actualizado && Date.parse(e.actualizado) >= Date.parse(primera) + MARGEN_TERMINADO_MS) continue;
    try {
      await obtenerPromedioLiga(ctx, liga, true);
    } catch (err) {
      if (!(err instanceof SinPresupuesto)) throw err;
    }
    return;
  }
}

// ==========================================
// PASADA
// ==========================================
// Devuelve el estado en que queda la web: "listo", "actualizando" (quedan
// partidos y el cron sigue en un minuto) o "sin_partidos".
export async function pasada(ctx, almacen, forzar = false) {
  const calendarios = await refrescarCalendarios(ctx, almacen, forzar);
  const { filas, reguardar } = await leerVentana(ctx, almacen);
  const debug = construirDebug(ctx, calendarios, filas);

  if (!filas.length) {
    // sin partidos por jugar (un parón, el final de la temporada) aún puede
    // haber partidos jugados por medir
    await refrescarParaRegistro(ctx, almacen);
    const registro = await liquidar(ctx, almacen);
    const resumen = { estado: "sin_partidos", total: 0, pendientes: 0, requests_gastadas: ctx.api.gastadas,
      ultima_actualizacion: ctx.ahoraIso(), plataforma: "cloudflare" };
    await almacen.escribir([...almacen.sentenciasCache(ctx.cache), ...registro,
      almacen.sentenciaDoc("estado", { ...resumen, dias: [], debug_busqueda: debug }),
      almacen.sentenciaDoc("resumen", resumen),
    ]);
    return "sin_partidos";
  }

  // se pinta ya el calendario entero: los partidos sin número salen como pendientes
  let e = construirEstado(ctx, filas, "actualizando", debug);
  await almacen.escribir([...reguardar, almacen.sentenciaDoc("estado", e.texto), almacen.sentenciaDoc("resumen", e.resumen)]);

  // lo más cercano primero; un partido con todo en caché no gasta peticiones y
  // se calcula aunque se haya acabado el presupuesto
  let agotado = false;
  let porGuardar = [];
  let ultimoProgreso = Date.now();
  let calculados = 0;
  for (const f of filas) {
    if (!f.pendiente) continue;
    if (calculados >= ctx.aj.maxCalculos) { agotado = true; break; }
    // sin presupuesto, solo los que no necesitan pedir nada
    if (ctx.api.agotado() && !todoEnCache(ctx, f)) { agotado = true; continue; }
    const gastadasAntes = ctx.api.gastadas;
    let ficha;
    try {
      ficha = await calcularPartido(ctx, f);
    } catch (err) {
      if (!(err instanceof SinPresupuesto)) throw err;
      agotado = true;
      continue;
    }
    calculados += 1;
    f.json = JSON.stringify(ficha);
    f.pendiente = false;
    f.sinNumeros = false;
    porGuardar.push(almacen.sentenciaPrediccion(ficha, f.json, f.base));
    // a mitad de pasada se escribe el progreso cada pocos segundos: la web va
    // rellenando los partidos al ritmo de la API, no todos de golpe al final
    if (ctx.api.gastadas > gastadasAntes && Date.now() - ultimoProgreso >= MS_ENTRE_PROGRESOS) {
      e = construirEstado(ctx, filas, "actualizando", debug);
      await almacen.escribir([...porGuardar, ...almacen.sentenciasCache(ctx.cache), ...await liquidar(ctx, almacen),
        almacen.sentenciaDoc("estado", e.texto), almacen.sentenciaDoc("resumen", e.resumen)]);
      porGuardar = [];
      ultimoProgreso = Date.now();
    }
  }

  const final = agotado ? "actualizando" : "listo";
  if (!agotado) await refrescarParaRegistro(ctx, almacen);
  e = construirEstado(ctx, filas, final, debug);
  await almacen.escribir([...porGuardar, ...almacen.sentenciasCache(ctx.cache), ...await liquidar(ctx, almacen),
    almacen.sentenciaDoc("estado", e.texto), almacen.sentenciaDoc("resumen", e.resumen)]);
  return final;
}
