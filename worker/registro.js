// El registro en vivo: lo que publicó la web, contra lo que pasó. La tabla
// predicciones guarda la última predicción de cada partido y no la borra al
// empezar; cuando la pasada baja los partidos terminados de una competición
// (obtenerPromedioLiga, cada HORAS_VALIDEZ_LIGA, para la media y las fuerzas),
// cruza sus marcadores con lo publicado y suma cada partido a las mismas
// métricas que la validación (Brier, LogLoss, acierto, frente a la base "equipo
// medio"), sin ni una petición más.
//
// Solo existe aquí: el disco de Render se borra en cada despliegue, y D1 no.
//
// Para no leer cientos de fichas en cada pasada (10 ms de CPU), las cuentas se
// llevan sumadas en un documento (registro) y lo que sirve /api/registro va ya
// montado aparte (registro_publico): leerlo es una fila, la pida quien la pida.
//
// Además del total y de cada liga, cada versión del modelo lleva sus cuentas
// (versiones): cuando cambia VERSION_MODELO, las de la nueva empiezan de cero y se
// ve si acierta más o menos que la de antes.

import { COMPETICIONES, VERSION_MODELO } from "./config.js";
import { calcularPoisson, mercadosDeGoles, redondear } from "./modelo.js";
import { Acumulador, Binario, MERCADOS, resultado, resumenMercado } from "./metricas.js";
import { enterosQueSuman, favoritoDe } from "./compartir.js";

export const REGISTRO_VACIO = {
  estado: "sin_datos", partidos: 0, plataforma: "cloudflare",
  nota: "Todavía no ha terminado ningún partido con una predicción publicada.",
};

// Un partido aplazado más de esto ya no se busca: su predicción no cuenta.
export const DIAS_LIQUIDAR = 45;
// Cuánto después de empezar se da por terminado un partido (90 minutos, el
// descanso, el añadido y algo de margen para que la API lo publique).
export const MARGEN_TERMINADO_MS = 150 * 60000;
const ULTIMOS = 30;
const MIN_CALIBRACION = 20;
const MS_DIA = 86400000;
// El resumen por días (la web enseña la última semana): se guardan 21 días.
export const DIAS_RESUMEN = 21;
// Tramos de confianza del favorito: su probabilidad en el 1X2, en %, con el entero
// que enseña la web (un favorito que sale con 60 cuenta en los claros).
export const TRAMOS = [["claros", 60], ["medios", 45], ["renidos", 0]];
const tramoDe = (prob) => TRAMOS.find(([, min]) => prob >= min)[0];
const cuatro = (x) => Math.round(x * 1e4) / 1e4;
// Lo que se guarda de cada partido: lo justo para pintarlo como uno más de la web.
export const CAMPOS_PARTIDO = ["id", "liga_codigo", "liga", "local", "visita", "local_corto", "visita_corto",
  "local_sigla", "visita_sigla", "prob_local", "prob_empate", "prob_visita"];

export function entradaDe(ficha, gl, gv, local) {
  const e = { id: ficha.id, utcDate: ficha.utcDate, fecha: local.fecha, hora: local.hora };
  for (const c of CAMPOS_PARTIDO) e[c] ??= ficha[c] ?? null;
  e.gl = gl;
  e.gv = gv;
  return e;
}

// El favorito como en la web (veredictoDe), en compartir.js con los enteros de la web.
export { favoritoDe };

const NOMBRES = Object.fromEntries(Object.entries(COMPETICIONES).map(([n, c]) => [c, n]));
export const isoSinMs = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";

// Las cuentas de una liga (o de todas juntas): las del modelo y las de la base
// "equipo medio", en el 1X2 y en los mercados de goles de la validación.
class Cuenta {
  constructor(g = null) {
    this.modelo = new Acumulador(g && g.modelo);
    this.base = new Acumulador(g && g.base);
    this.mercados = Object.fromEntries(Object.keys(MERCADOS).map((k) =>
      [k, [new Binario(g && g.mercados[k][0]), new Binario(g && g.mercados[k][1])]]));
  }

  // Como el resultado de validar_liga, para que la web lo pinte igual.
  resumen(codigo) {
    const m = this.modelo.resumen(), b = this.base.resumen();
    const skill = redondear(100 * (1 - m.brier / b.brier), 1);
    return {
      liga: codigo ? NOMBRES[codigo] ?? codigo : "Todas", codigo, partidos: m.n,
      modelo: m, base_equipo_medio: b, skill_score: skill, aporta_valor: skill > 0 && m.logloss < b.logloss,
      mercados: Object.fromEntries(Object.entries(this.mercados).map(([k, [mod, base]]) => [k, resumenMercado(mod, base)])),
    };
  }

  toJSON() {
    return { modelo: this.modelo, base: this.base, mercados: this.mercados };
  }
}

// La base "equipo medio" de un partido: el 1X2 y los mercados de dos equipos medios
// con la media de liga de la ficha. memo: para rehacer cientos sin repetir las cuentas
// de las mismas medias.
function baseDe(ml, mv, memo = null) {
  const k = ml + "|" + mv;
  if (memo && memo.has(k)) return memo.get(k);
  const pb = calcularPoisson(redondear(ml, 2), redondear(mv, 2));
  const b = { p: [pb.prob_local / 100, pb.prob_empate / 100, pb.prob_visita / 100],
    goles: mercadosDeGoles(ml, mv, { avg_local: ml, avg_visita: mv }) };
  if (memo) memo.set(k, b);
  return b;
}

// Un partido terminado (m: el marcador a los 90 minutos) en unas cuentas.
function sumar(cuentas, ficha, m, b) {
  const y = resultado(m);
  const p = [ficha.prob_local / 100, ficha.prob_empate / 100, ficha.prob_visita / 100];
  for (const c of cuentas) {
    c.modelo.add(p, y);
    c.base.add(b.p, y);
    for (const k in MERCADOS) {
      const [clave, ocurre] = MERCADOS[k];
      const si = ocurre(m) ? 1 : 0;
      c.mercados[k][0].add(ficha[clave] / 100, si);
      c.mercados[k][1].add(b.goles[clave] / 100, si);
    }
  }
}

export class Registro {
  constructor(g = null) {
    this.desde = g ? g.desde : null;
    this.desde_fecha = g ? g.desde_fecha : null;   // el día del primero, en hora de Lima
    this.hasta = g ? g.hasta : null;
    this.total = new Cuenta(g && g.total);
    this.ligas = Object.fromEntries(Object.entries((g && g.ligas) || {}).map(([c, x]) => [c, new Cuenta(x)]));
    this.ultimos = g ? g.ultimos : [];
    // {fecha: {n, ac, esp, tramos: {claros: [n, ac, esp]...}, sorpresa}}: cuántos
    // terminaron ese día, en cuántos acertó el favorito, cuántos aciertos
    // esperaban sus propias probabilidades, y el fallo del favorito más claro.
    // null: un registro de antes, que hay que rehacer (rehacerDias).
    this.dias = g ? (g.dias ?? null) : {};
    // {versión: {desde, desde_fecha, hasta, total}}: las cuentas de cada versión del
    // modelo. Las de un registro de antes se rehacen por partes (rehacerVersiones), y
    // mientras tanto (rehaciendo: por dónde va, [liquidado, id]) ni se publican ni
    // suman los partidos nuevos: los lee una parte siguiente.
    this.versiones = Object.fromEntries(Object.entries((g && g.versiones) || {}).map(([v, x]) =>
      [v, { desde: x.desde, desde_fecha: x.desde_fecha, hasta: x.hasta, total: new Cuenta(x.total) }]));
    this.rehaciendo = g ? (g.versiones ? g.rehaciendo ?? null : [0, 0]) : null;
  }

  // Las cuentas de la versión del modelo con que se calculó la ficha (una de antes de
  // guardarla cuenta como la 1, como en la validación).
  version(ficha, local) {
    const x = (this.versiones[String(ficha.version_modelo ?? 1)] ??=
      { desde: null, desde_fecha: null, hasta: null, total: new Cuenta() });
    const utc = ficha.utcDate;
    if (!x.desde || utc < x.desde) { x.desde = utc; x.desde_fecha = local.fecha; }
    if (!x.hasta || utc > x.hasta) x.hasta = utc;
    return x.total;
  }

  anotarDia(e) {
    const [signo, prob] = favoritoDe(e);
    const paso = e.gl > e.gv ? "1" : e.gl === e.gv ? "X" : "2";
    const acierto = signo === paso;
    const d = (this.dias[e.fecha] ??= { n: 0, ac: 0, esp: 0, tramos: {}, sorpresa: null });
    const enteros = enterosQueSuman([e.prob_local, e.prob_empate, e.prob_visita]);
    const t = (d.tramos[tramoDe(enteros["1X2".indexOf(signo)])] ??= [0, 0, 0]);
    d.n++;
    t[0]++;
    if (acierto) { d.ac++; t[1]++; }
    d.esp = cuatro(d.esp + prob / 100);
    t[2] = cuatro(t[2] + prob / 100);
    if (!acierto && (!d.sorpresa || prob > favoritoDe(d.sorpresa)[1])) d.sorpresa = e;
    const fechas = Object.keys(this.dias).sort();
    const corte = new Date(Date.parse(fechas[fechas.length - 1] + "T00:00:00Z") - DIAS_RESUMEN * MS_DIA)
      .toISOString().slice(0, 10);
    for (const f of fechas) if (f <= corte) delete this.dias[f];
  }

  // Un partido terminado: la ficha que publicó la web y el marcador a los 90
  // minutos. La base usa la media de liga con la que se calculó la ficha
  // (media_local/visita); una ficha de antes de guardarla, la de ahora.
  anotar(ficha, gl, gv, media, local) {
    const ml = ficha.media_local ?? media.avg_local, mv = ficha.media_visita ?? media.avg_visita;
    const cuentas = [(this.ligas[ficha.liga_codigo] ??= new Cuenta()), this.total];
    if (!this.rehaciendo) cuentas.push(this.version(ficha, local));
    sumar(cuentas, ficha, { gl, gv }, baseDe(ml, mv));
    const utc = ficha.utcDate;
    if (!this.desde || utc < this.desde) { this.desde = utc; this.desde_fecha = local.fecha; }
    if (!this.hasta || utc > this.hasta) this.hasta = utc;
    const e = entradaDe(ficha, gl, gv, local);
    this.ultimos.push(e);
    this.anotarDia(e);
    this.ultimos.sort((a, b) => (a.utcDate < b.utcDate ? 1 : a.utcDate > b.utcDate ? -1 : a.id - b.id));
    this.ultimos.length = Math.min(this.ultimos.length, ULTIMOS);
  }

  // Lo que sirve /api/registro: la misma forma que /api/validacion (resumen y
  // ligas), más el total, la calibración y los últimos partidos.
  publico(ahoraIso) {
    const codigos = Object.keys(this.ligas);
    const ligas = Object.fromEntries(codigos.map((c) => [c, this.ligas[c].resumen(c)]));
    return {
      estado: "listo", plataforma: "cloudflare", partidos: this.total.modelo.n, desde: this.desde,
      desde_fecha: this.desde_fecha, hasta: this.hasta, actualizado: ahoraIso, total: this.total.resumen(null),
      resumen: Object.fromEntries(codigos.map((c) => {
        const r = ligas[c];
        return [c, { skill_score: r.skill_score, aporta_valor: r.aporta_valor, brier: r.modelo.brier,
          brier_base: r.base_equipo_medio.brier, partidos: r.partidos,
          mercados: Object.fromEntries(Object.entries(r.mercados).map(([k, x]) =>
            [k, { skill_score: x.skill_score, aporta_valor: x.aporta_valor }])) }];
      })),
      ligas,
      calibracion: this.total.modelo.calibracion(MIN_CALIBRACION),
      ultimos: this.ultimos.slice(0, 12),
      // los últimos 14 días, de más viejo a más nuevo: la web suma los de su semana
      semana: Object.keys(this.dias || {}).sort().slice(-14).map((fecha) => ({ fecha, ...this.dias[fecha] })),
      // cada versión del modelo, la más nueva primero (nada mientras se rehacen)
      version_actual: VERSION_MODELO,
      versiones: this.rehaciendo ? [] : Object.keys(this.versiones).sort((a, b) => b - a).map((v) => {
        const x = this.versiones[v], r = x.total.resumen(null);
        return { version: Number(v), desde: x.desde, desde_fecha: x.desde_fecha, hasta: x.hasta, partidos: r.partidos,
          skill_score: r.skill_score, aporta_valor: r.aporta_valor, acierto: r.modelo.acierto,
          mercados: Object.fromEntries(Object.entries(r.mercados).map(([k, mk]) =>
            [k, { skill_score: mk.skill_score, aporta_valor: mk.aporta_valor, acierto: mk.modelo.acierto }])) };
      }),
    };
  }

  toJSON() {
    return { desde: this.desde, desde_fecha: this.desde_fecha, hasta: this.hasta, total: this.total, ligas: this.ligas,
      ultimos: this.ultimos, dias: this.dias, versiones: this.versiones, rehaciendo: this.rehaciendo };
  }
}

// Un registro de antes del resumen por días se rehace una vez con lo ya
// liquidado (resultados y la ficha publicada). json_extract: sin leer las fichas
// enteras, que cuesta CPU.
export async function rehacerDias(registro, almacen, reloj, ahora) {
  registro.dias = {};
  const db = almacen.db;
  const cols = CAMPOS_PARTIDO.map((c) => `json_extract(p.ficha, '$.${c}') AS c_${c}`).join(", ");
  const r = await almacen.consultar(() => db.prepare(
    `SELECT r.gl, r.gv, p.utc, ${cols} FROM resultados r JOIN predicciones p ON p.id = r.id
     WHERE r.contado = 1 AND r.utc >= ?1 ORDER BY r.utc, r.id`).bind(isoSinMs(ahora - DIAS_RESUMEN * MS_DIA)).all());
  for (const f of r.results) {
    const ficha = { utcDate: f.utc };
    for (const c of CAMPOS_PARTIDO) ficha[c] = f["c_" + c];
    registro.anotarDia(entradaDe(ficha, f.gl, f.gv, reloj.local(Date.parse(f.utc))));
  }
}

// Las cuentas por versión de un registro de antes se rehacen con lo ya liquidado, por
// partes: la base de cada partido cuesta CPU (~0.1 ms) y una pasada solo tiene 10 ms.
// Cada pasada que liquida suma los PARTE_VERSIONES siguientes en el orden en que se
// liquidaron, así que lo que se liquide mientras tanto lo lee una parte siguiente y
// no se cuenta dos veces. Una ficha sin la media de liga con que se calculó no tiene
// base y no entra. Las cuentas del total y de las ligas no se tocan.
export const PARTE_VERSIONES = 10;
const CAMPOS_VERSION = ["liga_codigo", "prob_local", "prob_empate", "prob_visita", "media_local", "media_visita",
  "version_modelo", ...Object.values(MERCADOS).map(([clave]) => clave)];

export async function rehacerVersiones(registro, almacen, reloj, parte = PARTE_VERSIONES) {
  const [liq, id] = registro.rehaciendo;
  const db = almacen.db;
  const cols = CAMPOS_VERSION.map((c) => `json_extract(p.ficha, '$.${c}') AS c_${c}`).join(", ");
  const r = await almacen.consultar(() => db.prepare(
    `SELECT r.gl, r.gv, r.liquidado, r.id, p.utc, ${cols} FROM resultados r JOIN predicciones p ON p.id = r.id
     WHERE r.contado = 1 AND (r.liquidado > ?1 OR (r.liquidado = ?1 AND r.id > ?2))
     ORDER BY r.liquidado, r.id LIMIT ?3`).bind(liq, id, parte).all());
  const memo = new Map();
  for (const f of r.results) {
    if (f.c_media_local == null || f.c_media_visita == null) continue;
    const ficha = { utcDate: f.utc };
    for (const c of CAMPOS_VERSION) ficha[c] = f["c_" + c];
    sumar([registro.version(ficha, reloj.local(Date.parse(f.utc)))], ficha, { gl: f.gl, gv: f.gv },
      baseDe(ficha.media_local, ficha.media_visita, memo));
  }
  const ultimo = r.results[r.results.length - 1];
  registro.rehaciendo = r.results.length < parte ? null : [ultimo.liquidado, ultimo.id];
}

// Los marcadores que bajó obtenerPromedioLiga en esta pasada ({codigo: {goles,
// media}} en ctx.resultados) contra las predicciones publicadas de esas
// competiciones que aún no tienen resultado. Devuelve las sentencias que lo
// guardan (resultados, registro y registro_publico), para ir en la misma
// escritura que el resto de la pasada: si la pasada muere, no se cuenta nada a
// medias y la siguiente lo vuelve a intentar.
export async function liquidar(ctx, almacen) {
  const nuevos = ctx.resultados;
  if (!nuevos.size) return [];
  const ahora = Date.now();
  const filas = await almacen.pendientesDeResultado([...nuevos.keys()], isoSinMs(ahora - DIAS_LIQUIDAR * MS_DIA),
    isoSinMs(ahora));
  const sentencias = [];
  let registro = null;
  for (const f of filas) {
    const r = nuevos.get(f.liga);
    const g = r && r.goles.get(f.id);
    if (!g) continue;   // aún sin terminar, o aplazado
    const ficha = JSON.parse(f.ficha);
    // solo cuenta lo publicado antes de empezar (la pasada no calcula partidos
    // empezados, pero una ficha rehecha por un cambio de hora podría quedar después)
    const cuenta = Date.parse(ficha.calculado) < Date.parse(ficha.utcDate);
    if (cuenta) {
      if (!registro) {
        registro = new Registro(await almacen.leerDoc("registro"));
        if (registro.dias === null) await rehacerDias(registro, almacen, ctx.reloj, ahora);
        // antes de los de esta pasada, que aún no están en resultados: si con esta parte
        // termina, ya entran en su versión; si no, los leerá otra parte
        if (registro.rehaciendo) {
          await rehacerVersiones(registro, almacen, ctx.reloj, Math.max(3, Math.round(PARTE_VERSIONES * (ctx.aj.escala ?? 1))));
        }
      }
      registro.anotar(ficha, g[0], g[1], r.media, ctx.reloj.local(Date.parse(ficha.utcDate)));
    }
    sentencias.push(almacen.sentenciaResultado(f.id, f.liga, f.utc, g[0], g[1], cuenta, ahora));
  }
  nuevos.clear();
  if (registro) {
    sentencias.push(almacen.sentenciaDoc("registro", registro),
      almacen.sentenciaDoc("registro_publico", registro.publico(ctx.ahoraIso())));
  }
  return sentencias;
}
