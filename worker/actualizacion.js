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
  CODIGOS_TORNEO, COMPETICIONES, DIAS_SEMANA, DIAS_VALIDEZ_LIGA, DIAS_VALIDEZ_LIGA_EQUIPO,
  DIAS_VALIDEZ_PRIOR, FACTOR_LIGA, FACTOR_OTRA_LIGA, HORAS_VALIDEZ_PREDICCION, K_LIGA, LIGAS,
  LIGAS_ANO_NATURAL, MAX_PARTIDOS_EQUIPO, PRIOR_AVG_LOCAL, PRIOR_AVG_VISITA, VENTANA_DIAS,
} from "./config.js";
import {
  calcularPoisson, calcularXgChampions, calcularXgPartido, fuerzasDesdeLiga, mercadosDeGoles,
  multiplicadoresHistorial, redondear, sumarHistorial,
} from "./modelo.js";
import { SinPresupuesto } from "./api.js";
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

async function obtenerPriorLiga(ctx, codigo) {
  const entry = ctx.cache.get("priors", codigo);
  const season = temporadaActual(ctx.reloj, codigo) - 1;
  // la temporada también cuenta (en julio la "anterior" pasa a ser otra), y un
  // torneo guarda además su historial por equipo
  if (entry && ctx.vigente(entry.actualizado, DIAS_VALIDEZ_PRIOR) && entry.temporada === season
      && (!CODIGOS_TORNEO.has(codigo) || "historial" in entry)) return entry;

  const respaldo = { avg_local: PRIOR_AVG_LOCAL, avg_visita: PRIOR_AVG_VISITA,
    origen: "constante de respaldo", partidos: 0, actualizado: null };
  if (ctx.fallos.has("prior:" + codigo)) return respaldo;

  const r = await ctx.api.get(`/competitions/${codigo}/matches`, { season, status: "FINISHED" }, { grande: true });
  if (r.status !== 200) {
    console.warn(`Prior ${codigo}: temporada ${season} no disponible (HTTP ${r.status}). Se usa la constante de respaldo.`);
    ctx.fallos.set("prior:" + codigo, true);
    return respaldo;
  }
  const { gl, gv, n } = sumarGoles(r.cuerpo.matches);
  // con media temporada o menos sería un ancla tan ruidosa como el problema
  if (n < 100) {
    console.warn(`Prior ${codigo}: solo ${n} partidos en ${season}, insuficiente.`);
    ctx.fallos.set("prior:" + codigo, true);
    return respaldo;
  }
  const nueva = { avg_local: gl / n, avg_visita: gv / n, origen: `temporada ${season}`, partidos: n,
    temporada: season, actualizado: ctx.ahoraIso() };
  if (CODIGOS_TORNEO.has(codigo)) nueva.historial = historialDePartidos(r.cuerpo.matches);
  ctx.cache.poner("priors", codigo, nueva);
  return nueva;
}

// ==========================================
// PROMEDIO DE GOLES POR LIGA
// ==========================================
// Si la media de una liga en caché sirve tal cual (un torneo necesita además su historial).
const ligaVigente = (ctx, codigo, e) => Boolean(e && ctx.vigente(e.actualizado, DIAS_VALIDEZ_LIGA)
  && (!CODIGOS_TORNEO.has(codigo) || "historial" in e));

export async function obtenerPromedioLiga(ctx, codigo) {
  const entry = ctx.cache.get("ligas", codigo);
  if (ligaVigente(ctx, codigo, entry)) return entry;
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
  const { gl, gv, n } = sumarGoles(r.cuerpo.matches);
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
  if (CODIGOS_TORNEO.has(codigo)) promedio.historial = historialDePartidos(r.cuerpo.matches);
  ctx.cache.poner("ligas", codigo, promedio);
  return promedio;
}

// ==========================================
// STATS POR EQUIPO (sumas crudas, sin normalizar)
// ==========================================
const STATS_VACIAS = { gf_local: 0, gc_local: 0, n_local: 0, gf_visita: 0, gc_visita: 0, n_visita: 0, actualizado: null };

const porFecha = (a, b) => {
  const x = a.utcDate || "", y = b.utcDate || "";
  return x < y ? -1 : x > y ? 1 : 0;
};

export async function obtenerStatsEquipo(ctx, teamId, codigo) {
  const key = `${teamId}:${codigo}`;
  const entry = ctx.cache.get("equipos", key);
  if (entry && ctx.vigente(entry.actualizado, ctx.aj.diasValidezEquipo)) return entry;
  if (ctx.fallos.has("equipo:" + key)) return { ...STATS_VACIAS };

  const hasta = ctx.hoy;
  const desde = sumarDias(hasta, -VENTANA_DIAS);
  const r = await ctx.api.get(`/teams/${teamId}/matches`, {
    status: "FINISHED",
    competitions: codigo,   // sin esto se colaban copas, Champions y amistosos
    dateFrom: desde,
    dateTo: hasta,
  });
  if (r.status !== 200) {
    console.warn(`Equipo ${teamId}: HTTP ${r.status}, se usa solo el prior de liga.`);
    ctx.fallos.set("equipo:" + key, true);
    return { ...STATS_VACIAS };
  }
  // la API no garantiza el orden: se ordena aquí y se toman los N más recientes
  const matches = (r.cuerpo.matches || []).slice().sort(porFecha).slice(-MAX_PARTIDOS_EQUIPO);
  const s = { gf_local: 0, gc_local: 0, n_local: 0, gf_visita: 0, gc_visita: 0, n_visita: 0 };
  for (const m of matches) {
    const ft = (m.score || {}).fullTime || {};
    const gl = ft.home, gv = ft.away;
    if (gl == null || gv == null) continue;
    if ((m.homeTeam || {}).id === teamId) {
      s.gf_local += gl; s.gc_local += gv; s.n_local += 1;
    } else {
      s.gf_visita += gv; s.gc_visita += gl; s.n_visita += 1;
    }
  }
  s.actualizado = ctx.ahoraIso();
  ctx.cache.poner("equipos", key, s);
  return s;
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

async function fuerzasChampions(ctx, teamId, enCasa) {
  const liga = await ligaDomestica(ctx, teamId);
  const factor = FACTOR_LIGA[liga] ?? FACTOR_OTRA_LIGA;
  const h = await historialChampions(ctx, teamId, factor);
  const [ataqueCl, defensaCl] = multiplicadoresHistorial(h);
  const historial = { partidos_cl: h.partidos, ataque_cl: ataqueCl, defensa_cl: defensaCl };
  if (liga === null) {
    return { liga: null, nombre_liga: null, factor: FACTOR_OTRA_LIGA, ataque: 1.0, defensa: 1.0, muestra: 0,
      ...historial };
  }
  const s = await obtenerStatsEquipo(ctx, teamId, liga);
  const prom = await obtenerPromedioLiga(ctx, liga);
  const f = fuerzasDesdeLiga(s, prom, enCasa);
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
const escudo = (equipo) => {
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
      sentencias.push(almacen.sentenciaBorrarPartidos(codigo));
      matches.forEach((m, i) => {
        const fila = filaPartido(ctx, m, codigo, nombreLiga, i);
        if (fila) sentencias.push(almacen.sentenciaPartido(fila));
      });
      ctx.cache.poner("calendario", codigo, { rango, actualizado: ctx.ahoraIso(), en_lista: matches.length });
    } else if (meta && meta.rango === rango && !meta.fallo) {
      // la API falló pero había algo del mismo rango: mejor eso que nada
      origen[codigo].origen = "caché (la API falló)";
    } else if (r.status !== 429) {
      sentencias.push(almacen.sentenciaBorrarPartidos(codigo));
      ctx.cache.poner("calendario", codigo, { rango, actualizado: ctx.ahoraIso(), en_lista: 0, fallo: true,
        http_status: r.status });
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
// JSON: el de su predicción si sigue fresca, o el de la ficha sin números.
async function leerVentana(ctx, almacen) {
  const ahoraUtc = new Date().toISOString().slice(0, 19) + "Z";
  const filas = await almacen.ventana(ahoraUtc);
  const reguardar = [];
  for (const f of filas) {
    if (f.ficha !== null && sigueFresca(f.calculado)) {
      f.pendiente = false;
      if (f.base_pred !== f.base) {
        // el calendario cambió la hora, un nombre o un escudo: la ficha se
        // rehace con lo nuevo sin recalcular los números (app.py seguía
        // enseñando la hora vieja hasta recalcular)
        const ficha = Object.assign(JSON.parse(f.ficha), JSON.parse(f.base));
        f.ficha = JSON.stringify(ficha);
        reguardar.push(almacen.sentenciaPrediccion(ficha, f.ficha, f.base));
      }
      f.json = f.ficha;
    } else {
      f.pendiente = true;
      f.json = f.base.slice(0, -1) + ',"pendiente":true}';
    }
  }
  return { filas, reguardar };
}

// El JSON que lee la web, montado pegando el de cada partido.
function construirEstado(ctx, filas, estadoTexto, debug) {
  let pendientes = 0;
  const trozos = [];
  let fecha = null, pj = null;
  for (const f of filas) {
    if (f.fecha !== fecha) {
      if (pj) trozos.push(cerrarDia(ctx, fecha, pj));
      fecha = f.fecha;
      pj = [];
    }
    if (f.pendiente) pendientes += 1;
    pj.push(f.json);
  }
  if (pj) trozos.push(cerrarDia(ctx, fecha, pj));
  const resumen = {
    estado: estadoTexto, total: filas.length, pendientes, requests_gastadas: ctx.api.gastadas,
    ultima_actualizacion: ctx.ahoraIso(), plataforma: "cloudflare",
  };
  const cabeza = JSON.stringify(resumen).slice(1, -1);
  const texto = `{${cabeza},"dias":[${trozos.join(",")}],"debug_busqueda":${JSON.stringify(debug)}}`;
  return { texto, resumen };
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
function todoEnCache(ctx, f) {
  const ligaLista = (c) => ligaVigente(ctx, c, ctx.cache.get("ligas", c)) || ctx.fallos.has("liga:" + c);
  const equipoListo = (id, c) => {
    const e = ctx.cache.get("equipos", `${id}:${c}`);
    return Boolean(e && ctx.vigente(e.actualizado, ctx.aj.diasValidezEquipo)) || ctx.fallos.has(`equipo:${id}:${c}`);
  };
  const ligaConocida = (id) => {
    const e = ctx.cache.get("liga_equipo", String(id));
    return Boolean(e && ctx.vigente(e.actualizado, e.fallo ? 1 : DIAS_VALIDEZ_LIGA_EQUIPO));
  };
  if (!ligaLista(f.liga)) return false;
  if (!CODIGOS_TORNEO.has(f.liga)) return equipoListo(f.local_id, f.liga) && equipoListo(f.visita_id, f.liga);
  // la liga de cada rival de su historial, que da su nivel
  const entradas = entradasHistorial(ctx);
  return [f.local_id, f.visita_id].every((id) => {
    if (!ligaConocida(id)) return false;
    const e = ctx.cache.get("liga_equipo", String(id));
    if (e.liga !== null && !(equipoListo(id, e.liga) && ligaLista(e.liga))) return false;
    return entradas.every((x) => (((x && x.historial) || {})[String(id)] || []).every(([rival]) => ligaConocida(rival)));
  });
}

async function calcularPartido(ctx, f) {
  const codigo = f.liga;
  const promedioLiga = await obtenerPromedioLiga(ctx, codigo);
  const extra = {};
  let xgLocal, xgVisita, muestraLocal, muestraVisita;
  if (CODIGOS_TORNEO.has(codigo)) {
    const fl = await fuerzasChampions(ctx, f.local_id, true);
    const fv = await fuerzasChampions(ctx, f.visita_id, false);
    [xgLocal, xgVisita] = calcularXgChampions(fl, fv, promedioLiga);
    muestraLocal = fl.muestra; muestraVisita = fv.muestra;
    // de qué liga sale cada equipo, con qué nivel y qué dice su historial en la
    // Champions: la web lo explica
    const lado = (x) => ({ liga: x.liga, nombre_liga: x.nombre_liga, factor: x.factor, partidos_cl: x.partidos_cl,
      ataque_cl: redondear(x.ataque_cl, 2), defensa_cl: redondear(x.defensa_cl, 2) });
    extra.champions = { local: lado(fl), visita: lado(fv) };
  } else {
    const sl = await obtenerStatsEquipo(ctx, f.local_id, codigo);
    const sv = await obtenerStatsEquipo(ctx, f.visita_id, codigo);
    [xgLocal, xgVisita] = calcularXgPartido(sl, sv, promedioLiga);
    muestraLocal = sl.n_local; muestraVisita = sv.n_visita;
  }
  return {
    ...JSON.parse(f.base),
    xg_local: xgLocal, xg_visita: xgVisita,
    // cuántos partidos reales hay detrás de cada lado
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
// PASADA
// ==========================================
// Devuelve el estado en que queda la web: "listo", "actualizando" (quedan
// partidos y el cron sigue en un minuto) o "sin_partidos".
export async function pasada(ctx, almacen, forzar = false) {
  const calendarios = await refrescarCalendarios(ctx, almacen, forzar);
  const { filas, reguardar } = await leerVentana(ctx, almacen);
  const debug = construirDebug(ctx, calendarios, filas);

  if (!filas.length) {
    const resumen = { estado: "sin_partidos", total: 0, pendientes: 0, requests_gastadas: ctx.api.gastadas,
      ultima_actualizacion: ctx.ahoraIso(), plataforma: "cloudflare" };
    await almacen.escribir([
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
    porGuardar.push(almacen.sentenciaPrediccion(ficha, f.json, f.base));
    // a mitad de pasada se escribe el progreso cada pocos segundos: la web va
    // rellenando los partidos al ritmo de la API, no todos de golpe al final
    if (ctx.api.gastadas > gastadasAntes && Date.now() - ultimoProgreso >= MS_ENTRE_PROGRESOS) {
      e = construirEstado(ctx, filas, "actualizando", debug);
      await almacen.escribir([...porGuardar, ...almacen.sentenciasCache(ctx.cache),
        almacen.sentenciaDoc("estado", e.texto), almacen.sentenciaDoc("resumen", e.resumen)]);
      porGuardar = [];
      ultimoProgreso = Date.now();
    }
  }

  const final = agotado ? "actualizando" : "listo";
  e = construirEstado(ctx, filas, final, debug);
  await almacen.escribir([...porGuardar, ...almacen.sentenciasCache(ctx.cache),
    almacen.sentenciaDoc("estado", e.texto), almacen.sentenciaDoc("resumen", e.resumen)]);
  return final;
}
