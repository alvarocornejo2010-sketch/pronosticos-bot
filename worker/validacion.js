// Backtest walk-forward del modelo desplegado, como validacion.py: para cada
// liga, la temporada anterior hace de ancla e historial y la última se recorre
// partido a partido prediciendo cada uno SOLO con lo ocurrido antes. Usa las
// mismas funciones que publica la web (modelo.js), no una copia.
//
// Lo que cambia es el ritmo. Cada ejecución del cron tiene 10 ms de CPU, y una
// temporada entera no cabe: ni bajarla (~400 KB de JSON) junto a otra cosa, ni
// recorrerla. Así que va por pasos de un minuto: bajar una temporada, bajar la
// otra, y recorrer la liga de PARTIDOS_POR_PASO en PARTIDOS_POR_PASO, guardando
// en D1 por dónde iba. Las temporadas terminadas no cambian: se guardan y la
// próxima validación no las vuelve a pedir.

import { K_LIGA, LIGAS, MAX_PARTIDOS_EQUIPO, PRIOR_AVG_LOCAL, PRIOR_AVG_VISITA } from "./config.js";
import { Suma, calcularPoisson, calcularXgPartido, mercadosDeGoles, redondear } from "./modelo.js";

// Medido en frío (el primer paso en un isolate recién creado es el más caro,
// porque V8 aún no ha compilado nada): así ningún paso pasa de unos pocos ms.
export const PARTIDOS_POR_PASO = 25;

// ==========================================
// ESTADO INCREMENTAL
// ==========================================
// Sabe responder "qué se sabía justo antes de este partido": por equipo, los
// últimos MAX_PARTIDOS_EQUIPO, igual que obtenerStatsEquipo en producción.
class Historial {
  constructor(ventana, guardado = null) {
    this.ventana = ventana;
    this.equipos = new Map(guardado ? guardado.equipos : []);
    this.gl = guardado ? guardado.gl : 0;
    this.gv = guardado ? guardado.gv : 0;
    this.n = guardado ? guardado.n : 0;
  }

  stats(id) {
    const s = { gf_local: 0, gc_local: 0, n_local: 0, gf_visita: 0, gc_visita: 0, n_visita: 0 };
    for (const [enCasa, gf, gc] of this.equipos.get(id) || []) {
      if (enCasa) { s.gf_local += gf; s.gc_local += gc; s.n_local += 1; }
      else { s.gf_visita += gf; s.gc_visita += gc; s.n_visita += 1; }
    }
    return s;
  }

  mediaLiga(ancla, k) {
    return { avg_local: (this.gl + k * ancla.avg_local) / (this.n + k),
      avg_visita: (this.gv + k * ancla.avg_visita) / (this.n + k) };
  }

  apuntar(id, x) {
    let d = this.equipos.get(id);
    if (!d) this.equipos.set(id, (d = []));
    d.push(x);
    if (d.length > this.ventana) d.shift();
  }

  registrar(m) {
    this.apuntar(m.local, [true, m.gl, m.gv]);
    this.apuntar(m.visita, [false, m.gv, m.gl]);
    this.gl += m.gl; this.gv += m.gv; this.n += 1;
  }

  toJSON() {
    return { equipos: [...this.equipos], gl: this.gl, gv: this.gv, n: this.n };
  }
}

// ==========================================
// MÉTRICAS
// ==========================================
// Las sumas van con Suma (compensada, como sum() de Python): llevarlas de paso
// en paso da lo mismo que sumar la lista entera al final, y no hay que guardar
// la lista.
const resultado = (m) => (m.gl > m.gv ? 0 : m.gl === m.gv ? 1 : 2);
const tramo = (v) => Math.min(Math.trunc(v * 10), 9);

function brier(p, y) {
  const s = new Suma();
  for (let i = 0; i < 3; i++) s.add((p[i] - (i === y ? 1 : 0)) ** 2);
  return s.valor();
}

const logloss = (p, y) => -Math.log(Math.max(p[y], 1e-15));

const suma = (g) => (g ? new Suma(g[0], g[1]) : new Suma());
const guardarSuma = (s) => [s.s, s.c];

class Acumulador {
  constructor(g = null) {
    this.b = suma(g && g.b); this.l = suma(g && g.l);
    this.aciertos = g ? g.aciertos : 0;
    this.n = g ? g.n : 0;
    this.bins = new Map(g ? g.bins : []);
  }

  add(p, y) {
    this.b.add(brier(p, y)); this.l.add(logloss(p, y));
    let mejor = 0;
    for (let i = 1; i < 3; i++) if (p[i] > p[mejor]) mejor = i;
    this.aciertos += mejor === y ? 1 : 0;
    this.n += 1;
    for (let i = 0; i < 3; i++) {
      const k = tramo(p[i]);
      const b = this.bins.get(k) ?? [0.0, 0, 0];
      b[0] += p[i]; b[1] += i === y ? 1 : 0; b[2] += 1;
      this.bins.set(k, b);
    }
  }

  resumen() {
    if (!this.n) return null;
    return { brier: redondear(this.b.valor() / this.n, 4), logloss: redondear(this.l.valor() / this.n, 4),
      acierto: redondear(100 * this.aciertos / this.n, 1), n: this.n };
  }

  calibracion(minimo = 25) {
    return calibracion(this.bins, minimo);
  }

  toJSON() {
    return { b: guardarSuma(this.b), l: guardarSuma(this.l), aciertos: this.aciertos, n: this.n, bins: [...this.bins] };
  }
}

// Lo mismo para un mercado de sí o no (más de 2.5, ambos marcan), con la media
// predicha y la frecuencia real.
class Binario {
  constructor(g = null) {
    this.b = suma(g && g.b); this.l = suma(g && g.l);
    this.aciertos = g ? g.aciertos : 0;
    this.n = g ? g.n : 0;
    this.sumaP = g ? g.sumaP : 0.0;
    this.si = g ? g.si : 0;
    this.bins = new Map(g ? g.bins : []);
  }

  add(p, y) {
    this.b.add((p - y) ** 2);
    this.l.add(-Math.log(Math.max(y ? p : 1 - p, 1e-15)));
    this.aciertos += (p >= 0.5) === Boolean(y) ? 1 : 0;
    this.n += 1; this.sumaP += p; this.si += y;
    const k = tramo(p);
    const b = this.bins.get(k) ?? [0.0, 0, 0];
    b[0] += p; b[1] += y; b[2] += 1;
    this.bins.set(k, b);
  }

  resumen() {
    if (!this.n) return null;
    return { brier: redondear(this.b.valor() / this.n, 4), logloss: redondear(this.l.valor() / this.n, 4),
      acierto: redondear(100 * this.aciertos / this.n, 1),
      predicho: redondear(100 * this.sumaP / this.n, 1), real: redondear(100 * this.si / this.n, 1), n: this.n };
  }

  calibracion(minimo = 25) {
    return calibracion(this.bins, minimo);
  }

  toJSON() {
    return { b: guardarSuma(this.b), l: guardarSuma(this.l), aciertos: this.aciertos, n: this.n,
      sumaP: this.sumaP, si: this.si, bins: [...this.bins] };
  }
}

function calibracion(bins, minimo) {
  const filas = [];
  for (const b of [...bins.keys()].sort((x, y) => x - y)) {
    const [total, ac, n] = bins.get(b);
    if (n < minimo) continue;
    const pred = 100 * total / n, real = 100 * ac / n;
    const se = 100 * Math.sqrt(Math.max(pred / 100 * (1 - pred / 100), 1e-9) / n);
    filas.push({ rango: `${b * 10}-${b * 10 + 10}%`, casos: n, predicho: redondear(pred, 1),
      real: redondear(real, 1), desvio: redondear(real - pred, 1), se: redondear(se, 1),
      significativo: Math.abs(real - pred) > 2 * se });
  }
  return filas;
}

// Mercados de goles que se validan además del 1X2: clave de mercadosDeGoles y
// qué cuenta como "sí" con el marcador real.
const MERCADOS = {
  mas_25: ["prob_mas_25", (m) => m.gl + m.gv > 2.5],
  ambos: ["prob_ambos", (m) => m.gl > 0 && m.gv > 0],
};

function resumenMercado(modelo, base) {
  const m = modelo.resumen(), b = base.resumen();
  const skill = redondear(100 * (1 - m.brier / b.brier), 1);
  return { modelo: m, base_equipo_medio: b, skill_score: skill,
    aporta_valor: skill > 0 && m.logloss < b.logloss, calibracion: modelo.calibracion() };
}

// ==========================================
// VALIDACIÓN DE UNA LIGA, POR TRAMOS
// ==========================================
export class ValidacionLiga {
  // previa hace falta solo al empezar (ancla e historial); al retomar, todo lo
  // que se sabía de ella ya está en lo guardado.
  constructor(codigo, nombre, season, previa, ultima, guardado = null) {
    this.codigo = codigo;
    this.nombre = nombre;
    this.season = season;
    this.ultima = ultima;
    const g = guardado;
    if (g) {
      this.i = g.i;
      this.ancla = g.ancla;
      this.hist = new Historial(MAX_PARTIDOS_EQUIPO, g.hist);
      this.conteo = g.conteo;
      this.error = null;
    } else {
      this.i = 0;
      this.conteo = [0, 0, 0];
      this.error = ultima.length < 100 ? `temporada ${season} no disponible (${ultima.length} partidos)` : null;
      // el ancla es la media de la temporada anterior, igual que en producción
      if (previa.length >= 100) {
        let gl = 0, gv = 0;
        for (const m of previa) { gl += m.gl; gv += m.gv; }
        this.ancla = { avg_local: gl / previa.length, avg_visita: gv / previa.length, origen: `temporada ${season - 1}` };
      } else {
        this.ancla = { avg_local: PRIOR_AVG_LOCAL, avg_visita: PRIOR_AVG_VISITA, origen: "constante de respaldo" };
      }
      this.hist = new Historial(MAX_PARTIDOS_EQUIPO);
      for (const m of previa) this.hist.registrar(m);   // historial de arranque, no se puntúa
    }
    this.modelo = new Acumulador(g && g.modelo);
    this.baseLiga = new Acumulador(g && g.baseLiga);
    this.baseFrec = new Acumulador(g && g.baseFrec);
    this.mercados = Object.fromEntries(Object.keys(MERCADOS).map((k) =>
      [k, [new Binario(g && g.mercados[k][0]), new Binario(g && g.mercados[k][1])]]));
  }

  terminada() {
    return Boolean(this.error) || this.i >= this.ultima.length;
  }

  avanzar(maximo = Infinity) {
    if (this.error) return;
    const fin = Math.min(this.ultima.length, this.i + maximo);
    for (; this.i < fin; this.i++) this.paso(this.ultima[this.i]);
  }

  paso(m) {
    const y = resultado(m);
    const media = this.hist.mediaLiga(this.ancla, K_LIGA);

    // el modelo real, el mismo que publica la web
    const [xl, xv] = calcularXgPartido(this.hist.stats(m.local), this.hist.stats(m.visita), media);
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
    this.hist.registrar(m);
  }

  resultado() {
    if (this.error) return { liga: this.nombre, error: this.error };
    const c = this.conteo;
    const t = (c[0] + c[1] + c[2]) || 1;
    const mRes = this.modelo.resumen(), bRes = this.baseLiga.resumen();
    // skill score: cuánto Brier le quita a la base. 0 = no aporta nada.
    const skill = redondear(100 * (1 - mRes.brier / bRes.brier), 1);
    return {
      liga: this.nombre,
      codigo: this.codigo,
      temporada_evaluada: this.season,
      ancla: this.ancla.origen,
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
    return { temporada: this.season, i: this.i, ancla: this.ancla, hist: this.hist, conteo: this.conteo,
      modelo: this.modelo, baseLiga: this.baseLiga, baseFrec: this.baseFrec, mercados: this.mercados };
  }
}

// La liga entera de una vez (lo que usa test_paridad.py).
export function validarLiga(codigo, nombre, season, previa, ultima) {
  const v = new ValidacionLiga(codigo, nombre, season, previa, ultima);
  v.avanzar();
  return v.resultado();
}

// De la respuesta de la API a la lista compacta de resultados, ordenada por fecha.
export function compactarTemporada(cuerpo) {
  const limpios = [];
  for (const m of (cuerpo && cuerpo.matches) || []) {
    const ft = (m.score || {}).fullTime || {};
    if (ft.home == null || ft.away == null) continue;
    limpios.push([m.utcDate, m.homeTeam.id, m.awayTeam.id, ft.home, ft.away]);
  }
  return limpios.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const desplegar = (filas) => filas.map(([fecha, local, visita, gl, gv]) => ({ fecha, local, visita, gl, gv }));

// ==========================================
// ORQUESTACIÓN (un paso por ejecución del cron)
// ==========================================
export const SIN_EJECUTAR = { estado: "sin_ejecutar", nota: "Lanza /validar?token=... para calcularlo." };
const PROGRESO = "validacion_progreso:";

// El documento que sirve /api/validacion y, aparte, lo poco que necesita el
// cron para decidir: en qué estado está, qué temporadas fallaron en esta
// ejecución (para no pedirlas en cada paso) y cuántas veces seguidas falló.
function escribirValidacion(almacen, doc, { fallidas = {}, intentos = 0 } = {}) {
  return [
    almacen.sentenciaDoc("validacion", doc),
    almacen.sentenciaDoc("validacion_resumen", { estado: doc.estado, temporada: doc.temporada ?? null,
      fallidas, intentos }),
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

// Avanza la validación en curso un paso: bajar una temporada que falte o
// recorrer un tramo de la liga que toca. Devuelve true cuando terminó todo.
export async function pasoValidacion(ctx, almacen, resumen, escala = 1) {
  const season = resumen.temporada;
  const doc = await almacen.leerDoc("validacion");
  const fallidas = resumen.fallidas || {};
  const resultados = doc.ligas || {};
  const ahoraIso = ctx.ahoraIso();
  const control = { fallidas, intentos: resumen.intentos ?? 0 };

  for (const [nombre, codigo] of Object.entries(LIGAS)) {
    if (resultados[codigo]) continue;

    let guardado = await almacen.leerDoc(PROGRESO + codigo);
    if (guardado && guardado.temporada !== season) guardado = null;

    // al retomar solo hace falta la temporada evaluada; al empezar, también la anterior
    const temporadas = {};
    for (const s of guardado ? [season] : [season - 1, season]) {
      const clave = `temporada:${codigo}:${s}`;
      if (fallidas[clave]) { temporadas[s] = []; continue; }
      const texto = await almacen.leerDocTexto(clave);
      if (texto !== null) { temporadas[s] = desplegar(JSON.parse(texto)); continue; }
      // una temporada por paso: es la respuesta más grande de toda la app
      const r = await ctx.api.get(`/competitions/${codigo}/matches`, { season: s, status: "FINISHED" }, { grande: true });
      if (r.status === 200) {
        await almacen.escribir([almacen.sentenciaDoc(clave, compactarTemporada(r.cuerpo))]);
      } else {
        console.warn(`Validación ${codigo} ${s}: HTTP ${r.status}`);
        fallidas[clave] = r.status;
        await almacen.escribir(escribirValidacion(almacen, doc, control));
      }
      return false;
    }

    let v = null;
    try {
      v = new ValidacionLiga(codigo, nombre, season, temporadas[season - 1] || [], temporadas[season], guardado);
      v.avanzar(Math.max(5, Math.round(PARTIDOS_POR_PASO * escala)));
      if (!v.terminada()) {
        await almacen.escribir([almacen.sentenciaDoc(PROGRESO + codigo, v)]);
        return false;
      }
      resultados[codigo] = v.resultado();
    } catch (e) {
      resultados[codigo] = { liga: nombre, error: String((e && e.message) || e) };
    }
    const enCurso = { estado: "calculando", temporada: season, ligas: resultados, hora: ahoraIso,
      iniciado: doc.iniciado };
    await almacen.escribir([almacen.sentenciaBorrar(PROGRESO + codigo), ...escribirValidacion(almacen, enCurso, control)]);
    return false;
  }

  const ok = Object.values(resultados).filter((r) => !r.error);
  const final = {
    estado: "listo",
    temporada: season,
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
  return escribirValidacion(almacen, { estado: "error", error: mensaje, intentos }, { intentos });
}
