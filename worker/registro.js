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

import { COMPETICIONES } from "./config.js";
import { calcularPoisson, mercadosDeGoles, redondear } from "./modelo.js";
import { Acumulador, Binario, MERCADOS, resultado, resumenMercado } from "./metricas.js";

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

export class Registro {
  constructor(g = null) {
    this.desde = g ? g.desde : null;
    this.desde_fecha = g ? g.desde_fecha : null;   // el día del primero, en hora de Lima
    this.hasta = g ? g.hasta : null;
    this.total = new Cuenta(g && g.total);
    this.ligas = Object.fromEntries(Object.entries((g && g.ligas) || {}).map(([c, x]) => [c, new Cuenta(x)]));
    this.ultimos = g ? g.ultimos : [];
  }

  // Un partido terminado: la ficha que publicó la web y el marcador a los 90
  // minutos. La base usa la media de liga con la que se calculó la ficha
  // (media_local/visita); una ficha de antes de guardarla, la de ahora.
  anotar(ficha, gl, gv, media, local) {
    const m = { gl, gv };
    const y = resultado(m);
    const ml = ficha.media_local ?? media.avg_local, mv = ficha.media_visita ?? media.avg_visita;
    const p = [ficha.prob_local / 100, ficha.prob_empate / 100, ficha.prob_visita / 100];
    const pb = calcularPoisson(redondear(ml, 2), redondear(mv, 2));
    const base = [pb.prob_local / 100, pb.prob_empate / 100, pb.prob_visita / 100];
    const gb = mercadosDeGoles(ml, mv, { avg_local: ml, avg_visita: mv });
    const codigo = ficha.liga_codigo;
    for (const c of [(this.ligas[codigo] ??= new Cuenta()), this.total]) {
      c.modelo.add(p, y);
      c.base.add(base, y);
      for (const k in MERCADOS) {
        const [clave, ocurre] = MERCADOS[k];
        const si = ocurre(m) ? 1 : 0;
        c.mercados[k][0].add(ficha[clave] / 100, si);
        c.mercados[k][1].add(gb[clave] / 100, si);
      }
    }
    const utc = ficha.utcDate;
    if (!this.desde || utc < this.desde) { this.desde = utc; this.desde_fecha = local.fecha; }
    if (!this.hasta || utc > this.hasta) this.hasta = utc;
    // lo justo para pintarlo como un partido más de la web
    this.ultimos.push({
      id: ficha.id, utcDate: utc, fecha: local.fecha, hora: local.hora, liga_codigo: codigo, liga: ficha.liga,
      local: ficha.local, visita: ficha.visita, local_corto: ficha.local_corto ?? null,
      visita_corto: ficha.visita_corto ?? null, local_sigla: ficha.local_sigla ?? null,
      visita_sigla: ficha.visita_sigla ?? null,
      prob_local: ficha.prob_local, prob_empate: ficha.prob_empate, prob_visita: ficha.prob_visita, gl, gv,
    });
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
    };
  }

  toJSON() {
    return { desde: this.desde, desde_fecha: this.desde_fecha, hasta: this.hasta, total: this.total, ligas: this.ligas,
      ultimos: this.ultimos };
  }
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
      registro ??= new Registro(await almacen.leerDoc("registro"));
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
