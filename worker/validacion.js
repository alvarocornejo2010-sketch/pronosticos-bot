// Backtest walk-forward del modelo desplegado, como validacion.py: para cada
// liga, la temporada anterior hace de ancla e historial y la última se recorre
// día a día prediciendo cada partido SOLO con lo ocurrido en días anteriores.
// Usa las mismas funciones que publica la web (modelo.js), no una copia.
//
// Lo que cambia es el ritmo. Cada ejecución del cron tiene 10 ms de CPU, y una
// temporada entera no cabe: ni bajarla (~400 KB de JSON) junto a otra cosa, ni
// recorrerla. Así que va por pasos de un minuto: bajar una temporada, bajar la
// otra, y recorrer la liga de PARTIDOS_POR_PASO en PARTIDOS_POR_PASO, guardando
// en D1 por dónde iba. Las temporadas terminadas no cambian: se guardan y la
// próxima validación no las vuelve a pedir.
//
// La Champions (oct 2026) va con su propio modelo, como en validacion.py: las ligas
// apuntan, al pasar por cada día de Champions, la fuerza de sus equipos que la
// juegan (fotos), y luego se recorre la Champions de tramo en tramo. Por eso sus dos
// temporadas se bajan antes que las de las ligas.

import { EXPONENTE_FUERZA_CHAMPIONS, FACTOR_LIGA, FACTOR_OTRA_LIGA, FORMATO_VALIDACION, K_LIGA, LIGAS, LIGA_DE_ARRIBA,
  PRIOR_AVG_LOCAL, PRIOR_AVG_VISITA, TORNEOS, VERSION_MODELO } from "./config.js";
import { ajustarFuerzas, calcularPoisson, calcularXgChampions, calcularXgPartido, fuerzaEquipo, mercadosDeGoles,
  multiplicadoresHistorial, redondear, sumarHistorial } from "./modelo.js";
import { Acumulador, Binario, MERCADOS, resultado, resumenMercado } from "./metricas.js";
import { diaDe, goles90, soloLiga } from "./actualizacion.js";

// Cada día con partidos es un ajuste de fuerzas (unos 0.2 ms ya compilado, más
// en un isolate recién creado, que aún no ha compilado nada): con 15 partidos,
// que son 2 o 3 días, un paso va de 1 a 4 ms en caliente.
export const PARTIDOS_POR_PASO = 15;

// ==========================================
// ESTADO INCREMENTAL
// ==========================================
// Sabe responder "qué se sabía justo antes de este partido" (_Historial en
// validacion.py): las fuerzas de todos los equipos (ajustarFuerzas, como en
// producción) y la media de la temporada en curso anclada en la anterior. Se
// recalculan al cambiar de día, arrancando de las del día anterior.
// el día de cada fecha se recuerda: en cada paso se compactan las dos temporadas
const DIAS = new Map();
const diaDeFecha = (fecha) => {
  const k = fecha.slice(0, 10);
  let d = DIAS.get(k);
  if (d === undefined) { d = diaDe(k); DIAS.set(k, d); }
  return d;
};
const compacto = (m) => [diaDeFecha(m.fecha), m.local, m.visita, m.gl, m.gv];

class Historial {
  // al retomar, actual son los partidos ya recorridos y guardado lo demás
  constructor(previa, ancla, k, actual = [], guardado = null, codigo = null, deArriba = []) {
    this.previa = previa.map(compacto);
    this.actual = actual.map(compacto);
    this.ancla = ancla;
    this.k = k;
    this.codigo = codigo;
    this.deArriba = deArriba;
    this.gl = guardado ? guardado.gl : 0;
    this.gv = guardado ? guardado.gv : 0;
    this.n = guardado ? guardado.n : 0;
    this.dia = guardado ? guardado.dia : null;
    this.fuerzas = guardado ? guardado.fuerzas : null;
    this.media = guardado ? guardado.media : null;
  }

  antesDe(m) {
    const dia = diaDe(m.fecha);
    if (dia !== this.dia) {
      const k = this.k;
      this.media = { avg_local: (this.gl + k * this.ancla.avg_local) / (this.n + k),
        avg_visita: (this.gv + k * this.ancla.avg_visita) / (this.n + k) };
      this.fuerzas = ajustarFuerzas(this.previa, this.actual, this.media,
        this.fuerzas ? this.fuerzas.equipos : null, this.codigo, this.deArriba);
      this.dia = dia;
    }
    return [this.fuerzas, this.media];
  }

  registrar(m) {
    this.actual.push(compacto(m));
    this.gl += m.gl; this.gv += m.gv; this.n += 1;
  }

  toJSON() {
    return { gl: this.gl, gv: this.gv, n: this.n, dia: this.dia, fuerzas: this.fuerzas, media: this.media };
  }
}

// ==========================================
// LO QUE SE MIDE (_Medidas en validacion.py)
// ==========================================
// El modelo, sus dos bases (equipo medio y frecuencia) y los mercados de goles de
// cada partido, igual en una liga que en la Champions. Se guarda a medias (toJSON).
class Medidas {
  constructor(g = null) {
    this.modelo = new Acumulador(g && g.modelo);
    this.baseLiga = new Acumulador(g && g.baseLiga);
    this.baseFrec = new Acumulador(g && g.baseFrec);
    this.conteo = g ? g.conteo : [0, 0, 0];
    this.mercados = Object.fromEntries(Object.keys(MERCADOS).map((k) =>
      [k, [new Binario(g && g.mercados[k][0]), new Binario(g && g.mercados[k][1])]]));
  }

  anotar(m, xl, xv, media) {
    const y = resultado(m);

    // el modelo real, el mismo que publica la web
    const pr = calcularPoisson(xl, xv);
    this.modelo.add([pr.prob_local / 100, pr.prob_empate / 100, pr.prob_visita / 100], y);

    // base 1: dos equipos medios, ignora quién juega
    const pb = calcularPoisson(redondear(media.avg_local, 2), redondear(media.avg_visita, 2));
    this.baseLiga.add([pb.prob_local / 100, pb.prob_empate / 100, pb.prob_visita / 100], y);

    // mercados de goles: los mismos números que publica la web
    const gm = mercadosDeGoles(xl, xv, media);
    const gb = mercadosDeGoles(media.avg_local, media.avg_visita, media);
    for (const k in MERCADOS) {
      const [clave, ocurre] = MERCADOS[k];
      const si = ocurre(m) ? 1 : 0;
      this.mercados[k][0].add(gm[clave] / 100, si);
      this.mercados[k][1].add(gb[clave] / 100, si);
    }

    // base 2: la frecuencia observada hasta ahora
    const c = this.conteo;
    const t = c[0] + c[1] + c[2];
    this.baseFrec.add(t > 30 ? [c[0] / t, c[1] / t, c[2] / t] : [0.45, 0.26, 0.29], y);
    c[y] += 1;
  }

  resultado(nombre, codigo, season, ancla) {
    const c = this.conteo;
    const t = (c[0] + c[1] + c[2]) || 1;
    const mRes = this.modelo.resumen(), bRes = this.baseLiga.resumen();
    // skill score: cuánto Brier le quita a la base. 0 = no aporta nada.
    const skill = redondear(100 * (1 - mRes.brier / bRes.brier), 1);
    return {
      liga: nombre,
      codigo,
      temporada_evaluada: season,
      ancla: ancla.origen,
      partidos: mRes.n,
      modelo: mRes,
      base_equipo_medio: bRes,
      base_frecuencia: this.baseFrec.resumen(),
      skill_score: skill,
      aporta_valor: skill > 0 && mRes.logloss < bRes.logloss,
      reparto_real: { 1: redondear(100 * c[0] / t, 1), X: redondear(100 * c[1] / t, 1), 2: redondear(100 * c[2] / t, 1) },
      calibracion: this.modelo.calibracion(),
      mercados: Object.fromEntries(Object.entries(this.mercados).map(([k, [mod, base]]) => [k, resumenMercado(mod, base)])),
    };
  }

  toJSON() {
    return { modelo: this.modelo, baseLiga: this.baseLiga, baseFrec: this.baseFrec, conteo: this.conteo,
      mercados: this.mercados };
  }
}

// La media de la temporada anterior, igual que en producción, o la constante de
// respaldo si no da para ancla (_ancla).
function anclaDe(previa, season) {
  if (previa.length >= 100) {
    let gl = 0, gv = 0;
    for (const m of previa) { gl += m.gl; gv += m.gv; }
    return { avg_local: gl / previa.length, avg_visita: gv / previa.length, origen: `temporada ${season - 1}` };
  }
  return { avg_local: PRIOR_AVG_LOCAL, avg_visita: PRIOR_AVG_VISITA, origen: "constante de respaldo" };
}

// {equipo: [ataque, defensa]} en su liga (fuerzaEquipo), de los que juegan la Champions.
function foto(fuerzas, equipos) {
  const f = {};
  for (const t of equipos) {
    const x = fuerzaEquipo(fuerzas, t);
    f[t] = [x.ataque, x.defensa];
  }
  return f;
}

// ==========================================
// VALIDACIÓN DE UNA LIGA, POR TRAMOS
// ==========================================
export class ValidacionLiga {
  // previa hace falta siempre: entra en las fuerzas de cada día. deArriba, los
  // equipos de la temporada anterior de la liga de arriba (LIGA_DE_ARRIBA).
  // champions ({fechas: la primera de cada día con Champions, equipos: un Set con
  // los que la juegan}): apunta la fuerza de sus equipos de Champions antes de cada
  // día de Champions (fotos), como validar_liga.
  constructor(codigo, nombre, season, previa, ultima, guardado = null, deArriba = [], champions = null) {
    this.codigo = codigo;
    this.nombre = nombre;
    this.season = season;
    this.ultima = ultima;
    const g = guardado;
    this.deArriba = g ? g.de_arriba || [] : deArriba;
    this.equipos = [...new Set(ultima.flatMap((m) => [m.local, m.visita]))].sort((a, b) => a - b);
    this.deCl = champions ? this.equipos.filter((t) => champions.equipos.has(t)) : [];
    this.diasCl = this.deCl.length ? champions.fechas.map((f) => [diaDe(f), f]) : [];
    this.k = g ? g.k ?? 0 : 0;
    this.porDia = g ? g.por_dia || {} : {};
    if (g) {
      this.i = g.i;
      this.ancla = g.ancla;
      this.hist = new Historial(previa.length >= 100 ? previa : [], this.ancla, K_LIGA, ultima.slice(0, g.i), g.hist,
        codigo, this.deArriba);
      this.error = null;
    } else {
      this.i = 0;
      this.error = ultima.length < 100 ? `temporada ${season} no disponible (${ultima.length} partidos)` : null;
      this.ancla = anclaDe(previa, season);
      // la temporada anterior entra en las fuerzas, no se puntúa
      this.hist = new Historial(previa.length >= 100 ? previa : [], this.ancla, K_LIGA, [], null,
        codigo, this.deArriba);
    }
    this.medidas = new Medidas(g && g.medidas);
  }

  terminada() {
    return Boolean(this.error) || this.i >= this.ultima.length;
  }

  avanzar(maximo = Infinity) {
    if (this.error) return;
    const fin = Math.min(this.ultima.length, this.i + maximo);
    for (; this.i < fin; this.i++) this.paso(this.ultima[this.i]);
    // los días de Champions después del último de liga: con la temporada entera
    if (this.i >= this.ultima.length && this.k < this.diasCl.length) {
      const [fuerzas] = this.hist.antesDe({ fecha: this.diasCl[this.k][1] });
      const f = foto(fuerzas, this.deCl);
      for (; this.k < this.diasCl.length; this.k++) this.porDia[this.diasCl[this.k][0]] = f;
    }
  }

  paso(m) {
    const [fuerzas, media] = this.hist.antesDe(m);
    const dia = diaDe(m.fecha);
    while (this.k < this.diasCl.length && this.diasCl[this.k][0] <= dia) {
      this.porDia[this.diasCl[this.k][0]] = foto(fuerzas, this.deCl);
      this.k += 1;
    }

    // el modelo real, el mismo que publica la web
    const [xl, xv] = calcularXgPartido(fuerzaEquipo(fuerzas, m.local), fuerzaEquipo(fuerzas, m.visita), media);
    this.medidas.anotar(m, xl, xv, media);
    this.hist.registrar(m);
  }

  // lo que necesita la Champions: los equipos de la liga y sus fotos
  fotos() {
    return { equipos: this.equipos, dias: this.porDia };
  }

  resultado() {
    if (this.error) return { liga: this.nombre, error: this.error };
    return this.medidas.resultado(this.nombre, this.codigo, this.season, this.ancla);
  }

  toJSON() {
    return { temporada: this.season, i: this.i, ancla: this.ancla, de_arriba: this.deArriba, hist: this.hist,
      medidas: this.medidas, k: this.k, por_dia: this.porDia };
  }
}

// La liga entera de una vez (lo que usa test_paridad.py). Con champions y fotos,
// apunta en fotos[codigo] las de sus equipos de Champions.
export function validarLiga(codigo, nombre, season, previa, ultima, deArriba = [], champions = null, fotos = null) {
  const v = new ValidacionLiga(codigo, nombre, season, previa, ultima, null, deArriba, champions);
  v.avanzar();
  if (fotos && !v.error) fotos[codigo] = v.fotos();
  return v.resultado();
}

// ==========================================
// VALIDACIÓN DE LA CHAMPIONS, POR TRAMOS
// ==========================================
// {equipo: [[rival, en casa (1/0), goles a favor, en contra], ...]} (_historial_torneo).
function historialTorneo(partidos, hist = {}) {
  for (const m of partidos) {
    (hist[m.local] ??= []).push([m.visita, 1, m.gl, m.gv]);
    (hist[m.visita] ??= []).push([m.local, 0, m.gv, m.gl]);
  }
  return hist;
}

// La Champions de una temporada, día a día, con su modelo (validar_champions): la
// media anclada en la temporada anterior, el historial de cada equipo y su fuerza en
// su liga ese día (las fotos de las ligas). Al retomar, el historial y la media se
// rehacen con lo ya recorrido.
export class ValidacionChampions {
  constructor(nombre, season, partidos, previa, fotos, guardado = null) {
    this.nombre = nombre;
    this.season = season;
    this.partidos = partidos;
    this.fotos = fotos;
    this.error = partidos.length < 100 ? `temporada ${season} no disponible (${partidos.length} partidos)` : null;
    this.ancla = anclaDe(previa, season);
    // cada equipo es de la liga en la que jugó esa temporada (la primera en el orden de LIGAS)
    this.ligaDe = new Map();
    for (const codigo of Object.values(LIGAS)) {
      for (const t of (fotos[codigo] || {}).equipos || []) if (!this.ligaDe.has(t)) this.ligaDe.set(t, codigo);
    }
    // sin una temporada anterior completa, producción no tiene su historial
    this.previo = previa.length >= 100 ? historialTorneo(previa) : null;
    const g = guardado;
    this.i = g ? g.i : 0;
    this.dia = g ? g.dia : null;
    this.media = g ? g.media : null;
    this.medidas = new Medidas(g && g.medidas);
    // lo ya recorrido: lo de días anteriores, en el historial; lo de hoy, pendiente
    this.gl = 0; this.gv = 0; this.n = 0;
    this.actual = {};
    this.pendientes = [];
    for (const m of partidos.slice(0, this.i)) {
      if (diaDe(m.fecha) === this.dia) this.pendientes.push(m);
      else historialTorneo([m], this.actual);
      this.gl += m.gl; this.gv += m.gv; this.n += 1;
    }
  }

  terminada() {
    return Boolean(this.error) || this.i >= this.partidos.length;
  }

  avanzar(maximo = Infinity) {
    if (this.error) return;
    const fin = Math.min(this.partidos.length, this.i + maximo);
    for (; this.i < fin; this.i++) this.paso(this.partidos[this.i]);
  }

  lado(t, dia) {
    const liga = this.ligaDe.get(t) ?? null;
    const factor = FACTOR_LIGA[liga] ?? FACTOR_OTRA_LIGA;
    const entradas = [{ avg_local: this.media.avg_local, avg_visita: this.media.avg_visita, historial: this.actual },
      { avg_local: this.ancla.avg_local, avg_visita: this.ancla.avg_visita, historial: this.previo || {} }];
    const h = sumarHistorial(entradas, t, factor, (r) => FACTOR_LIGA[this.ligaDe.get(r) ?? null] ?? FACTOR_OTRA_LIGA);
    const [ataqueCl, defensaCl] = multiplicadoresHistorial(h);
    const f = liga ? (((this.fotos[liga] || {}).dias || {})[dia] || {})[t] : undefined;
    const b = EXPONENTE_FUERZA_CHAMPIONS;
    return { factor, ataque: f ? f[0] ** b : 1.0, defensa: f ? f[1] ** b : 1.0, ataque_cl: ataqueCl, defensa_cl: defensaCl };
  }

  paso(m) {
    const d = diaDe(m.fecha);
    if (d !== this.dia) {
      // lo del día anterior entra en el historial y en la media
      historialTorneo(this.pendientes, this.actual);
      this.pendientes = [];
      this.media = { avg_local: (this.gl + K_LIGA * this.ancla.avg_local) / (this.n + K_LIGA),
        avg_visita: (this.gv + K_LIGA * this.ancla.avg_visita) / (this.n + K_LIGA) };
      this.dia = d;
    }
    const [xl, xv] = calcularXgChampions(this.lado(m.local, d), this.lado(m.visita, d), this.media);
    this.medidas.anotar(m, xl, xv, this.media);
    this.pendientes.push(m);
    this.gl += m.gl; this.gv += m.gv; this.n += 1;
  }

  resultado() {
    if (this.error) return { liga: this.nombre, error: this.error };
    return this.medidas.resultado(this.nombre, "CL", this.season, this.ancla);
  }

  toJSON() {
    return { temporada: this.season, i: this.i, dia: this.dia, media: this.media, medidas: this.medidas };
  }
}

// La Champions entera de una vez (lo que usa test_paridad.py).
export function validarChampions(nombre, season, partidos, previa, fotos) {
  const v = new ValidacionChampions(nombre, season, partidos, previa, fotos);
  v.avanzar();
  return v.resultado();
}

// La primera fecha de cada día con partidos, en orden (fechas_por_dia).
export function fechasPorDia(partidos) {
  const out = [], visto = new Set();
  for (const m of partidos) {
    const d = diaDe(m.fecha);
    if (!visto.has(d)) { visto.add(d); out.push(m.fecha); }
  }
  return out;
}

// De la respuesta de la API a la lista compacta de resultados de la fase de liga
// (sin playoffs), ordenada por fecha.
export function compactarTemporada(cuerpo) {
  const limpios = [];
  for (const m of soloLiga((cuerpo && cuerpo.matches) || [])) {
    const ft = (m.score || {}).fullTime || {};
    if (ft.home == null || ft.away == null) continue;
    limpios.push([m.utcDate, m.homeTeam.id, m.awayTeam.id, ft.home, ft.away]);
  }
  return limpios.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Lo mismo de un torneo (la Champions): todos sus partidos, con los goles a los 90
// minutos (goles90: sin prórroga ni penaltis).
export function compactarTorneo(cuerpo) {
  const limpios = [];
  for (const m of (cuerpo && cuerpo.matches) || []) {
    const [gl, gv] = goles90(m);
    const local = (m.homeTeam || {}).id, visita = (m.awayTeam || {}).id;
    if (gl == null || gv == null || local == null || visita == null) continue;
    limpios.push([m.utcDate, local, visita, gl, gv]);
  }
  return limpios.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const desplegar = (filas) => filas.map(([fecha, local, visita, gl, gv]) => ({ fecha, local, visita, gl, gv }));

// Las temporadas terminadas, guardadas en D1. "liga:": desde oct 2026 sin playoffs;
// las de antes ("temporada:PD:2025") ya no se leen y se vuelven a bajar.
const claveTemporada = (codigo, s) => `temporada:liga:${codigo}:${s}`;
const claveTorneo = (codigo, s) => `temporada:torneo:${codigo}:${s}`;

// ==========================================
// ORQUESTACIÓN (un paso por ejecución del cron)
// ==========================================
export const SIN_EJECUTAR = { estado: "sin_ejecutar", nota: "Lanza /validar?token=... para calcularlo." };
const PROGRESO = "validacion_progreso:";

// El documento que sirve /api/validacion y, aparte, lo poco que necesita el
// cron para decidir: en qué estado está, qué temporadas fallaron en esta
// ejecución (para no pedirlas en cada paso), cuántas veces seguidas falló y con
// qué versión del modelo (una de otra versión no mide lo que se publica: se repite).
function escribirValidacion(almacen, doc, { fallidas = {}, intentos = 0 } = {}) {
  return [
    almacen.sentenciaDoc("validacion", doc),
    almacen.sentenciaDoc("validacion_resumen", { estado: doc.estado, temporada: doc.temporada ?? null,
      fallidas, intentos, version_modelo: VERSION_MODELO, formato: FORMATO_VALIDACION }),
  ];
}

// Los intentos se arrastran de una ejecución fallida a la siguiente: en
// validacion.py se perdían al escribir "calculando" y el tope de 3 no frenaba nada.
export function sentenciasInicio(almacen, ahoraIso, season, intentos = 0) {
  return [
    almacen.sentenciaBorrarPrefijo(PROGRESO),
    ...escribirValidacion(almacen, { estado: "calculando", iniciado: ahoraIso, temporada: season, ligas: {} },
      { intentos }),
  ];
}

// Una temporada guardada en D1 o, si falta, la petición para bajarla (una por paso:
// es la respuesta más grande de toda la app). Devuelve los partidos, [] si ya falló
// en esta ejecución, o null si este paso se gastó en bajarla.
async function temporada(ctx, almacen, doc, control, clave, ruta, s, compactar) {
  if (control.fallidas[clave]) return [];
  const texto = await almacen.leerDocTexto(clave);
  if (texto !== null) return desplegar(JSON.parse(texto));
  const r = await ctx.api.get(ruta, { season: s, status: "FINISHED" }, { grande: true });
  if (r.status === 200) {
    await almacen.escribir([almacen.sentenciaDoc(clave, compactar(r.cuerpo))]);
  } else {
    console.warn(`Validación ${clave}: HTTP ${r.status}`);
    control.fallidas[clave] = r.status;
    await almacen.escribir(escribirValidacion(almacen, doc, control));
  }
  return null;
}

// Avanza la validación en curso un paso: bajar una temporada que falte o
// recorrer un tramo de la liga (o de la Champions) que toca. Devuelve true cuando
// terminó todo.
export async function pasoValidacion(ctx, almacen, resumen, escala = 1) {
  const season = resumen.temporada;
  const doc = await almacen.leerDoc("validacion");
  const fallidas = resumen.fallidas || {};
  const resultados = doc.ligas || {};
  const ahoraIso = ctx.ahoraIso();
  const control = { fallidas, intentos: resumen.intentos ?? 0 };
  const tramo = Math.max(5, Math.round(PARTIDOS_POR_PASO * escala));
  const enCurso = () => ({ estado: "calculando", temporada: season, ligas: resultados, hora: ahoraIso,
    iniciado: doc.iniciado });

  // la Champions primero: al recorrer cada liga se apunta la fuerza de sus equipos
  // de Champions en cada día de Champions
  const torneo = {};
  for (const s of [season - 1, season]) {
    torneo[s] = await temporada(ctx, almacen, doc, control, claveTorneo("CL", s), "/competitions/CL/matches", s,
      compactarTorneo);
    if (torneo[s] === null) return false;
  }
  const cl = torneo[season];
  const champions = { fechas: fechasPorDia(cl), equipos: new Set(cl.flatMap((m) => [m.local, m.visita])) };

  for (const [nombre, codigo] of Object.entries(LIGAS)) {
    if (resultados[codigo]) continue;

    let guardado = await almacen.leerDoc(PROGRESO + codigo);
    if (guardado && guardado.temporada !== season) guardado = null;

    // las dos temporadas: la anterior entra en las fuerzas de cada día
    const temporadas = {};
    for (const s of [season - 1, season]) {
      temporadas[s] = await temporada(ctx, almacen, doc, control, claveTemporada(codigo, s),
        `/competitions/${codigo}/matches`, s, compactarTemporada);
      if (temporadas[s] === null) return false;
    }

    // los que bajan de la liga de arriba parten de su propia fuerza: su temporada
    // anterior ya la guardó la validación de esa liga, que va antes
    let deArriba = [];
    if (!guardado && codigo in LIGA_DE_ARRIBA) {
      const texto = await almacen.leerDocTexto(claveTemporada(LIGA_DE_ARRIBA[codigo], season - 1));
      if (texto !== null) deArriba = JSON.parse(texto).flatMap((f) => [f[1], f[2]]);
    }

    const fin = [almacen.sentenciaBorrar(PROGRESO + codigo)];
    try {
      const v = new ValidacionLiga(codigo, nombre, season, temporadas[season - 1], temporadas[season], guardado,
        deArriba, champions);
      v.avanzar(tramo);
      if (!v.terminada()) {
        await almacen.escribir([almacen.sentenciaDoc(PROGRESO + codigo, v)]);
        return false;
      }
      resultados[codigo] = v.resultado();
      if (!v.error) fin.push(almacen.sentenciaDoc(PROGRESO + "fotos:" + codigo, v.fotos()));
    } catch (e) {
      resultados[codigo] = { liga: nombre, error: String((e && e.message) || e) };
    }
    await almacen.escribir([...fin, ...escribirValidacion(almacen, enCurso(), control)]);
    return false;
  }

  if (!resultados.CL) {
    const nombre = Object.keys(TORNEOS).find((k) => TORNEOS[k] === "CL");
    let guardado = await almacen.leerDoc(PROGRESO + "CL");
    if (guardado && guardado.temporada !== season) guardado = null;
    const docs = await almacen.leerDocs(Object.values(LIGAS).map((c) => PROGRESO + "fotos:" + c));
    const fotos = {};
    for (const c of Object.values(LIGAS)) {
      const d = docs[PROGRESO + "fotos:" + c];
      if (d) fotos[c] = JSON.parse(d.texto);
    }
    try {
      const v = new ValidacionChampions(nombre, season, cl, torneo[season - 1], fotos, guardado);
      v.avanzar(tramo);
      if (!v.terminada()) {
        await almacen.escribir([almacen.sentenciaDoc(PROGRESO + "CL", v)]);
        return false;
      }
      resultados.CL = v.resultado();
    } catch (e) {
      resultados.CL = { liga: nombre, error: String((e && e.message) || e) };
    }
    await almacen.escribir([almacen.sentenciaBorrar(PROGRESO + "CL"), ...escribirValidacion(almacen, enCurso(), control)]);
    return false;
  }

  const ok = Object.values(resultados).filter((r) => !r.error);
  const final = {
    estado: "listo",
    temporada: season,
    version_modelo: VERSION_MODELO,
    hora: ahoraIso,
    resumen: Object.fromEntries(ok.map((r) => [r.codigo, {
      skill_score: r.skill_score,
      aporta_valor: r.aporta_valor,
      brier: r.modelo.brier,
      brier_base: r.base_equipo_medio.brier,
      mercados: Object.fromEntries(Object.entries(r.mercados).map(([k, x]) =>
        [k, { skill_score: x.skill_score, aporta_valor: x.aporta_valor }])),
    }])),
    ligas: resultados,
  };
  await almacen.escribir(escribirValidacion(almacen, final));
  return true;
}

export function sentenciasError(almacen, mensaje, intentosPrevios) {
  const intentos = intentosPrevios + 1;
  return escribirValidacion(almacen, { estado: "error", error: mensaje, intentos, version_modelo: VERSION_MODELO },
    { intentos });
}
