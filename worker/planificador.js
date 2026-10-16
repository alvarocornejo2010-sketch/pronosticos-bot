// El planificador: lo que en app.py son los hilos de fondo. Aquí no hace falta
// keep-alive (un Worker no se duerme) y el reloj es el cron de Cloudflare, que
// llama a tick() cada minuto. Cada vez decide si hay algo que hacer: primero
// actualizar la web, y solo con la web al día, avanzar la validación.

import { MAX_INTENTOS_VALIDACION, ajustes } from "./config.js";
import { Almacen } from "./almacen.js";
import { ClienteAPI, SinPresupuesto } from "./api.js";
import { Reloj } from "./tiempo.js";
import { Contexto, pasada, temporadaActual } from "./actualizacion.js";
import { pasoValidacion, sentenciasError, sentenciasInicio } from "./validacion.js";

const DOCS_CONTROL = ["resumen", "validacion_resumen", "pedido_forzar", "pedido_validar"];
// Un error se reintenta a los 5 minutos, como el tick de app.py, no a cada minuto.
const MINUTOS_REINTENTO_ERROR = 5;
// Si una ejecución muere a medias (CPU, despliegue), el candado caduca solo.
// Tiene que durar más que la pasada más larga: unas 10 peticiones con su pausa
// y hasta 30 s de espera cada una.
const DURACION_CANDADO = 5 * 60000;

// Si la pasada anterior murió sin soltar el candado, lo más probable es que se
// pasara de los 10 ms de CPU del plan gratis. Entonces esta hace la mitad (y
// la mitad otra vez si vuelve a pasar, hasta un octavo), y recupera el ritmo de
// una en una cuando las pasadas vuelven a terminar bien.
function aplicarEscala(aj, muertes) {
  const escala = 1 / 2 ** Math.min(muertes, 3);
  if (escala === 1) return aj;
  return { ...aj, escala,
    presupuesto: Math.max(1, Math.round(aj.presupuesto * escala)),
    maxBytes: Math.max(64 * 1024, Math.round(aj.maxBytes * escala)),
    maxCalculos: Math.max(5, Math.round(aj.maxCalculos * escala)) };
}

export const FALTA_TOKEN = "Falta el secreto FOOTBALL_DATA_TOKEN. Añádelo en Cloudflare: "
  + "Workers & Pages → pronosticos-bot → Settings → Variables and Secrets";

// ¿Toca actualizar? Lo mismo que _toca_actualizar en app.py. "actualizando" al
// empezar un minuto quiere decir que la pasada anterior se quedó sin presupuesto
// (o se cortó): continuar no es rehacer trabajo y no espera.
export function tocaActualizar(resumen, aj, ahora) {
  const e = resumen && resumen.estado;
  if (e === "error") {
    const desde = resumen.error_hora ? (ahora - Date.parse(resumen.error_hora)) / 60000 : Infinity;
    return desde >= MINUTOS_REINTENTO_ERROR ? "reintento tras un error" : null;
  }
  if (e == null || e === "sin_datos") return "no hay datos todavía";
  if (e === "actualizando") return `quedan ${resumen.pendientes ?? "?"} partidos por calcular`;
  if (e === "parcial" && resumen.pendientes > 0) return `quedan ${resumen.pendientes} partidos por calcular`;
  const ultima = resumen.ultima_actualizacion;
  if (!ultima) return "sin marca de tiempo";
  const min = (ahora - Date.parse(ultima)) / 60000;
  return min >= aj.minMinutosActualizacion ? `última hace ${Math.trunc(min)} min` : null;
}

// ¿Toca validar? Como _toca_validar: solo con el calendario al día, porque las
// dos cosas compiten por las mismas 10 peticiones por minuto. Una validación
// empezada se sigue, y una pedida con /validar no espera a que esté "listo".
// En Render se repetía en cada despliegue porque el disco se borraba; aquí se
// guarda, así que se repite sola cuando termina una temporada nueva.
export function tocaValidar(resumen, val, pedido, aj, ultimaTerminada) {
  if (val && val.estado === "calculando") return "continuar la validación";
  if (pedido) return "pedida con /validar";
  if (!aj.autoValidar || !resumen || resumen.estado !== "listo") return null;
  if (!val || val.estado === "sin_ejecutar") return "nunca se ha ejecutado";
  if (val.estado === "listo" && val.temporada < ultimaTerminada) return `ya terminó la temporada ${ultimaTerminada}`;
  if (val.estado === "error" && (val.intentos ?? 0) < MAX_INTENTOS_VALIDACION) {
    return `reintento ${(val.intentos ?? 0) + 1} de ${MAX_INTENTOS_VALIDACION} tras un error`;
  }
  return null;
}

const leer = (d) => (d ? JSON.parse(d.texto) : null);

// Como el except de correr_actualizacion: la web sigue enseñando lo último que
// tenía, con el estado en "error" y el motivo.
async function marcarError(almacen, reloj, mensaje) {
  const ahoraIso = reloj.iso(Date.now());
  const estado = (await almacen.leerDoc("estado").catch(() => null))
    || { dias: [], total: 0, pendientes: 0, ultima_actualizacion: null };
  Object.assign(estado, { estado: "error", error: mensaje, plataforma: "cloudflare" });
  const resumen = { estado: "error", error: mensaje, error_hora: ahoraIso, total: estado.total ?? 0,
    pendientes: estado.pendientes ?? 0, ultima_actualizacion: estado.ultima_actualizacion ?? null };
  await almacen.escribir([almacen.sentenciaDoc("estado", estado), almacen.sentenciaDoc("resumen", resumen)]);
}

export async function tick(env, { fetchFn = null } = {}) {
  const aj = ajustes(env);
  const almacen = new Almacen(env.DB);
  const ahora = Date.now();
  // un minuto sin nada que hacer cuesta una sola consulta y ninguna escritura
  const docs = await almacen.leerDocs(DOCS_CONTROL);
  const resumen = leer(docs.resumen) || { estado: "sin_datos" };
  const valResumen = leer(docs.validacion_resumen);
  const pedidoForzar = docs.pedido_forzar || null;
  const pedidoValidar = docs.pedido_validar || null;

  const reloj = new Reloj(aj.tz);
  let tarea = null;
  // si el error era que faltaba el token y ya está puesto, no se esperan los 5 minutos
  const yaHayToken = resumen.estado === "error" && resumen.error === FALTA_TOKEN && env.FOOTBALL_DATA_TOKEN;
  let motivo = pedidoForzar ? "forzada con /actualizar"
    : yaHayToken ? "ya está el token" : tocaActualizar(resumen, aj, ahora);
  if (motivo) tarea = "actualizar";
  else if ((motivo = tocaValidar(resumen, valResumen, pedidoValidar, aj, temporadaActual(reloj) - 1))) tarea = "validar";
  if (!tarea) return { tarea: null };

  if (!env.FOOTBALL_DATA_TOKEN) {
    await marcarError(almacen, reloj, FALTA_TOKEN);
    return { tarea, error: FALTA_TOKEN };
  }

  const candados = await almacen.leerCandados();
  if (candados.pasada > ahora) return { tarea, ocupado: true };
  const dueno = crypto.randomUUID();
  if (!(await almacen.tomarCandado(dueno, DURACION_CANDADO, ahora))) return { tarea, ocupado: true };
  let muertes = candados.muertes;
  if (candados.pasada > 0) {
    muertes += 1;
    console.warn(`La pasada anterior murió sin terminar (${muertes} seguidas): esta hace menos.`);
    await almacen.escribir([almacen.sentenciaMuertes(muertes)]);
  }
  const ajp = aplicarEscala(aj, muertes);

  const api = new ClienteAPI({
    token: env.FOOTBALL_DATA_TOKEN, base: ajp.apiBase, presupuesto: ajp.presupuesto, pausaMs: ajp.pausaMs,
    maxBytes: ajp.maxBytes, ultimaPeticion: candados.api, fetchFn,
  });
  let terminoBien = false;
  let val = valResumen;
  try {
    const ctx = new Contexto({ reloj, cache: await almacen.cargarCache(), api, ajustes: ajp, almacen });

    if (tarea === "actualizar") {
      if (pedidoForzar) await almacen.escribir([almacen.sentenciaBorrarDoc("pedido_forzar", pedidoForzar.actualizado)]);
      console.log(`Planificador: actualizando (${motivo})`);
      const final = await pasada(ctx, almacen, Boolean(pedidoForzar));
      terminoBien = true;
      return { tarea, motivo, estado: final, peticiones: api.gastadas, kb: Math.round(api.bytes / 1024), muertes };
    }

    if (!val || val.estado !== "calculando") {
      // la temporada evaluada por defecto es la última terminada, como en validacion.py
      const pedido = leer(pedidoValidar) || {};
      const season = Number.isInteger(pedido.temporada) ? pedido.temporada : temporadaActual(reloj) - 1;
      const intentos = !pedidoValidar && val && val.estado === "error" ? val.intentos ?? 0 : 0;
      const inicio = sentenciasInicio(almacen, ctx.ahoraIso(), season, intentos);
      if (pedidoValidar) inicio.push(almacen.sentenciaBorrarDoc("pedido_validar", pedidoValidar.actualizado));
      await almacen.escribir(inicio);
      val = { estado: "calculando", temporada: season, fallidas: {}, intentos };
    }
    console.log(`Planificador: validando el modelo (${motivo})`);
    const terminada = await pasoValidacion(ctx, almacen, val, ajp.escala ?? 1);
    terminoBien = true;
    return { tarea, motivo, terminada, peticiones: api.gastadas, kb: Math.round(api.bytes / 1024), muertes };
  } catch (e) {
    // sin presupuesto o con un 429: se sigue en el minuto siguiente, no es un error
    if (e instanceof SinPresupuesto) {
      terminoBien = true;
      return { tarea, motivo, esperando: e.message, peticiones: api.gastadas };
    }
    const mensaje = String((e && e.message) || e);
    console.error(`Error en la ${tarea === "actualizar" ? "actualización" : "validación"}: ${mensaje}`);
    if (tarea === "actualizar") await marcarError(almacen, reloj, mensaje);
    else await almacen.escribir(sentenciasError(almacen, mensaje, (val && val.intentos) || 0));
    return { tarea, motivo, error: mensaje };
  } finally {
    const fin = [almacen.sentenciaSoltarCandado(dueno)];
    if (api.gastadas) fin.push(almacen.sentenciaUltimaPeticion(api.ultima));
    if (terminoBien && muertes > 0) fin.push(almacen.sentenciaMuertes(muertes - 1));
    await almacen.escribir(fin);
  }
}
