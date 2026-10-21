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

import { K_LIGA, LIGAS, LIGA_DE_ARRIBA, PRIOR_AVG_LOCAL, PRIOR_AVG_VISITA, VERSION_MODELO } from "./config.js";
import { ajustarFuerzas, calcularPoisson, calcularXgPartido, fuerzaEquipo, mercadosDeGoles, redondear } from "./modelo.js";
import { Acumulador, Binario, MERCADOS, resultado, resumenMercado } from "./metricas.js";
import { diaDe, soloLiga } from "./actualizacion.js";

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
// VALIDACIÓN DE UNA LIGA, POR TRAMOS
// ==========================================
export class ValidacionLiga {
  // previa hace falta siempre: entra en las fuerzas de cada día. deArriba, los
  // equipos de la temporada anterior de la liga de arriba (LIGA_DE_ARRIBA).
  constructor(codigo, nombre, season, previa, ultima, guardado = null, deArriba = []) {
    this.codigo = codigo;
    this.nombre = nombre;
    this.season = season;
    this.ultima = ultima;
    const g = guardado;
    this.deArriba = g ? g.de_arriba || [] : deArriba;
    if (g) {
      this.i = g.i;
      this.ancla = g.ancla;
      this.hist = new Historial(previa.length >= 100 ? previa : [], this.ancla, K_LIGA, ultima.slice(0, g.i), g.hist,
        codigo, this.deArriba);
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
      // la temporada anterior entra en las fuerzas, no se puntúa
      this.hist = new Historial(previa.length >= 100 ? previa : [], this.ancla, K_LIGA, [], null,
        codigo, this.deArriba);
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
    const [fuerzas, media] = this.hist.antesDe(m);

    // el modelo real, el mismo que publica la web
    const [xl, xv] = calcularXgPartido(fuerzaEquipo(fuerzas, m.local), fuerzaEquipo(fuerzas, m.visita), media);
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
    return { temporada: this.season, i: this.i, ancla: this.ancla, de_arriba: this.deArriba, hist: this.hist,
      conteo: this.conteo, modelo: this.modelo, baseLiga: this.baseLiga, baseFrec: this.baseFrec,
      mercados: this.mercados };
  }
}

// La liga entera de una vez (lo que usa test_paridad.py).
export function validarLiga(codigo, nombre, season, previa, ultima, deArriba = []) {
  const v = new ValidacionLiga(codigo, nombre, season, previa, ultima, null, deArriba);
  v.avanzar();
  return v.resultado();
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

const desplegar = (filas) => filas.map(([fecha, local, visita, gl, gv]) => ({ fecha, local, visita, gl, gv }));

// Las temporadas terminadas, guardadas en D1. "liga:": desde oct 2026 sin playoffs;
// las de antes ("temporada:PD:2025") ya no se leen y se vuelven a bajar.
const claveTemporada = (codigo, s) => `temporada:liga:${codigo}:${s}`;

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
      fallidas, intentos, version_modelo: VERSION_MODELO }),
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

    // las dos temporadas: la anterior entra en las fuerzas de cada día
    const temporadas = {};
    for (const s of [season - 1, season]) {
      const clave = claveTemporada(codigo, s);
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

    // los que bajan de la liga de arriba parten de su propia fuerza: su temporada
    // anterior ya la guardó la validación de esa liga, que va antes
    let deArriba = [];
    if (!guardado && codigo in LIGA_DE_ARRIBA) {
      const texto = await almacen.leerDocTexto(claveTemporada(LIGA_DE_ARRIBA[codigo], season - 1));
      if (texto !== null) deArriba = JSON.parse(texto).flatMap((f) => [f[1], f[2]]);
    }

    let v = null;
    try {
      v = new ValidacionLiga(codigo, nombre, season, temporadas[season - 1] || [], temporadas[season], guardado,
        deArriba);
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
