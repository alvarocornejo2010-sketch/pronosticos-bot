// Los avisos de Mis equipos (oct 2026): el navegador que los activa recibe uno antes de
// cada partido de los equipos que sigue (AVISO_ANTES_MIN, 2 h, con el pronóstico) y otro
// con el resultado. Van por Web Push (push.js): gratis, sin cuenta y sin correo. En el
// iPhone, solo con la web instalada (Safari no los deja de otra forma).
//
// La web se suscribe con la clave pública VAPID de GET /api/avisos y manda la
// suscripción y sus equipos a /api/avisos/alta (otra vez cada vez que cambian sus
// estrellas); /api/avisos/baja la borra. El par VAPID lo crea el Worker la primera vez
// y lo guarda en D1 (documento "vapid"): no hay que poner ningún secreto en el panel.
// Si se perdiera, las suscripciones de antes dejarían de valer y cada navegador se
// volvería a suscribir solo al abrir la web (app.js compara la clave).
//
// Los manda el cron (pasoAvisos, la tarea "avisos" del planificador) cuando lo dice el
// documento "avisos_resumen" (proximo: cuándo volver a mirar; cola: cuántos faltan por
// mandar): mira las predicciones de las próximas horas y los resultados de las últimas
// 24 h de los equipos seguidos, pone en cola (envios) los avisos que ya tocan, una sola
// vez por partido (avisos), y manda hasta MAX_ENVIOS_PASADA por minuto. De madrugada en
// Lima (de 23:00 a 6:59) no se avisa antes de un partido: el aviso va a las 22:00 de la
// noche anterior.

import { ajustes } from "./config.js";
import { Reloj, sumarDias } from "./tiempo.js";
import { cuerpoJson, limpiarEquipos, mismoSitio } from "./cuentas.js";
import { lineaReparto, queDijo } from "./compartir.js";
import { isoSinMs } from "./registro.js";
import { autorizacionVapid, cifrar, clavesValidas, clavesVapidNuevas, deB64u } from "./push.js";

const MS_MIN = 60000, MS_HORA = 60 * MS_MIN, MS_DIA = 24 * MS_HORA;
// Los servicios de avisos de los navegadores: Chrome (y los demás Chromium de Android),
// Edge en Windows, Firefox y Safari. Ningún otro: si no, cualquiera podría hacer que el
// Worker mandara peticiones a la web que quisiera.
const SERVICIOS = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\/[!-~]+$/;
const MAX_ENDPOINT = 1024;
const SILENCIO = [23, 7];                  // de 23:00 a 6:59 de Lima, nada antes de un partido:
const HORA_NOCHE = 22;                     // el aviso va a las 22:00 de antes
const ANTELACION_MAX_MS = 12 * MS_HORA;    // lo más que puede adelantarse por eso
const REVISION_MS = 30 * MS_MIN;           // aunque no toque nada, se vuelve a mirar cada media hora
const RESULTADO_DESDE_MS = 155 * MS_MIN;   // antes no hay resultado (registro.js: 2 h 30 de margen)
const RESULTADO_CADA_MS = 10 * MS_MIN;     // y luego se mira cada 10 min hasta que llega
const RESULTADO_HASTA_MS = MS_DIA;         // un día después ya no se avisa
const MAX_INTENTOS = 3;                    // un aviso que falla (red, 429, 5xx) se reintenta
const DIAS_MARCAS = 2;                     // las marcas de lo avisado, hasta 2 días después del partido
const DIAS_SUSCRIPCION = 180;              // la web la renueva cada semana que se abre
const GASTO_ALTA = 5;                      // filas que escribe un alta, por lo alto
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

export const RUTAS_AVISOS = { "/api/avisos": ["GET", "HEAD"], "/api/avisos/alta": ["POST"], "/api/avisos/baja": ["POST"] };

const sumar = (db, dia, tipo, clave, n) => db.prepare(
  `INSERT INTO visitas (dia, tipo, clave, n) VALUES (?1, ?2, ?3, ?4)
   ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + excluded.n`).bind(dia, tipo, clave, n);

// Que el cron vuelva a mirar en el próximo minuto (un alta: equipos nuevos).
const revisarYa = (db, ahora) => db.prepare(
  `INSERT INTO documentos (clave, valor, actualizado) VALUES ('avisos_resumen', json_object('proximo', ?1, 'cola', 0), ?1)
   ON CONFLICT (clave) DO UPDATE SET valor = json_set(valor, '$.proximo', ?1), actualizado = ?1`).bind(ahora);

export function endpointValido(endpoint, aj) {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) return false;
  return SERVICIOS.test(endpoint) || Boolean(aj.pushPrueba && endpoint.startsWith(aj.pushPrueba + "/"));
}

async function puntoValido(p256dh) {
  try {
    await crypto.subtle.importKey("raw", deB64u(p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch { return false; }
}

// Cuándo va el aviso de antes de un partido: AVISO_ANTES_MIN antes, o a las 22:00 de la
// noche anterior si eso cae de madrugada en Lima.
export function momentoPrevio(inicioMs, antesMin, reloj) {
  const m = inicioMs - antesMin * MS_MIN;
  const { fecha, hora } = reloj.local(m);
  const h = +hora.slice(0, 2);
  if (h < SILENCIO[0] && h >= SILENCIO[1]) return m;
  const noche = h < SILENCIO[1] ? sumarDias(fecha, -1) : fecha;
  return Date.parse(`${noche}T${String(HORA_NOCHE).padStart(2, "0")}:00:00Z`) - reloj.desfase(m) * MS_MIN;
}

// El aviso de un partido (x: la fila de la cola, con lo que hace falta de la ficha): lo
// que enseña el sistema (título y texto), adónde lleva al tocarlo y su etiqueta (la
// misma para los dos avisos de un partido: el resultado sustituye al de antes).
export function mensajeAviso(x, reloj, ahora) {
  const local = x.local_corto || x.local, visita = x.visita_corto || x.visita;
  const conNumeros = x.prob_local != null && x.prob_empate != null && x.prob_visita != null;
  const reparto = conNumeros && lineaReparto(x);
  const tag = "p" + x.partido;
  if (x.tipo === "previo") {
    const ini = reloj.local(Date.parse(x.utc)), hoy = reloj.local(ahora).fecha;
    const dia = ini.fecha === hoy ? "Hoy" : ini.fecha === sumarDias(hoy, 1) ? "Mañana"
      : `El ${DIAS[new Date(ini.fecha + "T00:00:00Z").getUTCDay()]} ${+ini.fecha.slice(8, 10)}`;
    return { titulo: `${local} – ${visita}`, cuerpo: `${dia} a las ${ini.hora} (hora de Lima) · ${x.liga}.`
      + (reparto ? ` ${reparto}.` : ""), url: `/partido/${x.partido}`, tag };
  }
  let cuerpo = `${x.liga}.`;
  if (reparto && x.contado) cuerpo = `La web daba ${reparto}. ${queDijo(x, x.gl, x.gv)}`;
  return { titulo: `Final: ${local} ${x.gl}-${x.gv} ${visita}`, cuerpo, url: "/", tag };
}

// El par VAPID de la web; con crear, si aún no lo hay, lo hace (si dos peticiones lo
// hacen a la vez, se queda el primero).
export async function clavesVapid(almacen, crear = false) {
  const doc = await almacen.leerDoc("vapid");
  if (doc || !crear) return doc;
  const nuevas = JSON.stringify(await clavesVapidNuevas());
  await almacen.consultar(() => almacen.db.prepare(
    "INSERT OR IGNORE INTO documentos (clave, valor, actualizado) VALUES ('vapid', ?1, ?2)")
    .bind(nuevas, Date.now()).run());
  return almacen.leerDoc("vapid");
}

// GET /api/avisos (la clave pública), POST /api/avisos/alta y /api/avisos/baja.
export async function atenderAvisos(request, env, almacen, cabeceras, ahora = Date.now()) {
  const url = new URL(request.url);
  const aj = ajustes(env);
  const db = almacen.db;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status,
    headers: { ...cabeceras, "Content-Type": "application/json; charset=utf-8" } });
  if (url.pathname === "/api/avisos") return json({ disponible: true, clave: (await clavesVapid(almacen, true)).publica });

  if (!mismoSitio(request, url)) return json({ error: "Solo desde la propia web." }, 403);
  const d = await cuerpoJson(request);
  if (!d || typeof d.endpoint !== "string") return json({ error: "Petición mal formada." }, 400);
  const dia = new Reloj(aj.tz).local(ahora).fecha;

  if (url.pathname === "/api/avisos/baja") {
    // con su clave auth, que solo conocen el navegador y el Worker; siempre funciona
    const auth = typeof d.auth === "string" ? d.auth : "";
    await almacen.escribir([
      db.prepare(`DELETE FROM envios WHERE suscripcion IN
        (SELECT id FROM suscripciones WHERE endpoint = ?1 AND auth = ?2)`).bind(d.endpoint, auth),
      db.prepare("DELETE FROM suscripciones WHERE endpoint = ?1 AND auth = ?2").bind(d.endpoint, auth),
    ]);
    return json({ ok: true });
  }

  if (!endpointValido(d.endpoint, aj) || !clavesValidas(d.p256dh, d.auth) || !(await puntoValido(d.p256dh))) {
    return json({ error: "Este navegador dio una suscripción que no se puede usar." }, 400);
  }
  const equipos = limpiarEquipos(d.equipos);
  const [ya, topes] = await almacen.consultar(() => db.batch([
    db.prepare("SELECT id FROM suscripciones WHERE endpoint = ?1").bind(d.endpoint),
    db.prepare(`SELECT (SELECT count(*) FROM suscripciones) AS total,
        (SELECT coalesce(sum(n), 0) FROM visitas WHERE dia = ?1 AND tipo = 'suscripciones' AND clave = '') AS hoy,
        (SELECT coalesce(sum(n), 0) FROM visitas WHERE dia = ?1 AND tipo = 'escrituras_avisos' AND clave = '') AS escritas`)
      .bind(dia),
  ]));
  const nueva = !ya.results.length;
  const t = topes.results[0];
  if (t.escritas + GASTO_ALTA > aj.maxEscriturasAvisosDia) {
    return json({ error: "Hoy ya no se pueden guardar más cambios de avisos: prueba mañana." }, 429);
  }
  if (nueva && (t.total >= aj.maxSuscripciones || t.hoy >= aj.maxSuscripcionesDia)) {
    return json({ error: "Ahora mismo no se pueden activar más avisos: prueba mañana." }, 429);
  }
  await almacen.escribir([
    db.prepare(`INSERT INTO suscripciones (endpoint, p256dh, auth, equipos, creada, vista) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, equipos = excluded.equipos,
        vista = excluded.vista`).bind(d.endpoint, d.p256dh, d.auth, JSON.stringify(equipos), ahora),
    sumar(db, dia, "escrituras_avisos", "", GASTO_ALTA),
    ...(nueva ? [sumar(db, dia, "suscripciones", "", 1)] : []),
    revisarYa(db, ahora),
  ]);
  return json({ ok: true, equipos: equipos.length });
}

// ¿Toca la tarea de los avisos? Solo si hay suscripciones (avisos_resumen existe) y hay
// cola o ya es la hora de volver a mirar.
export function tocaAvisos(r, ahora) {
  if (!r) return null;
  if (r.cola > 0) return `quedan ${r.cola} avisos por mandar`;
  return r.proximo != null && r.proximo <= ahora ? "toca mirar los partidos de los equipos seguidos" : null;
}

// Un aviso al servicio del navegador: el código HTTP, o 0 si no hubo respuesta.
async function mandar(x, mensaje, ttl, firma, fetchFn) {
  try {
    const cuerpo = await cifrar(JSON.stringify(mensaje), x.p256dh, x.auth);
    const r = await fetchFn(x.endpoint, { method: "POST", body: cuerpo, signal: AbortSignal.timeout(10000), headers: {
      Authorization: firma, TTL: String(ttl), Urgency: x.tipo === "previo" ? "high" : "normal", Topic: "p" + x.partido,
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" } });
    return r.status;
  } catch {
    return 0;
  }
}

// La tarea "avisos" del cron. versionResumen: el `actualizado` del avisos_resumen que
// leyó el planificador; si un alta lo cambió entretanto, se deja el suyo (que pide mirar
// ya) en vez de pisarlo.
export async function pasoAvisos(env, almacen, aj, versionResumen, ahora = Date.now(), fetchFn = fetch) {
  const db = almacen.db;
  const reloj = new Reloj(aj.tz);
  const dia = reloj.local(ahora).fecha;
  const [subs, filas] = await almacen.consultar(() => db.batch([
    db.prepare("SELECT DISTINCT e.value AS equipo FROM suscripciones s, json_each(s.equipos) e"),
    db.prepare(`SELECT q.id, q.utc, json_extract(q.base, '$.local') AS local, json_extract(q.base, '$.visita') AS visita,
        EXISTS (SELECT 1 FROM partidos p WHERE p.id = q.id) AS en_calendario, r.id IS NOT NULL AS terminado,
        (SELECT group_concat(a.tipo) FROM avisos a WHERE a.partido = q.id) AS hechos
      FROM predicciones q LEFT JOIN resultados r ON r.id = q.id
      WHERE q.utc > ?1 AND q.utc <= ?2`)
      .bind(isoSinMs(ahora - RESULTADO_HASTA_MS), isoSinMs(ahora + aj.avisoAntesMin * MS_MIN + ANTELACION_MAX_MS)),
  ]));

  // 1. los avisos que ya tocan, a la cola (una vez por partido); y cuándo volver a mirar
  const seguidos = new Set(subs.results.map((f) => f.equipo));
  let proximo = ahora + REVISION_MS;
  const tocan = [];
  for (const f of filas.results) {
    if (!seguidos.has(f.local) && !seguidos.has(f.visita)) continue;
    const hechos = new Set((f.hechos || "").split(","));
    const inicio = Date.parse(f.utc);
    if (!hechos.has("previo") && inicio > ahora && f.en_calendario) {
      const m = momentoPrevio(inicio, aj.avisoAntesMin, reloj);
      if (m <= ahora) tocan.push([f.id, "previo", f.local, f.visita]);
      else proximo = Math.min(proximo, m);
    }
    if (!hechos.has("final")) {
      if (f.terminado) tocan.push([f.id, "final", f.local, f.visita]);
      else proximo = Math.min(proximo, Math.max(inicio + RESULTADO_DESDE_MS, ahora + RESULTADO_CADA_MS));
    }
  }
  if (tocan.length) {
    await almacen.escribir(tocan.flatMap(([id, tipo, local, visita]) => [
      db.prepare(`INSERT OR IGNORE INTO envios (suscripcion, partido, tipo, intentos)
        SELECT s.id, ?1, ?2, 0 FROM suscripciones s
        WHERE EXISTS (SELECT 1 FROM json_each(s.equipos) e WHERE e.value IN (?3, ?4))`).bind(id, tipo, local, visita),
      db.prepare("INSERT OR IGNORE INTO avisos (partido, tipo, creado) VALUES (?1, ?2, ?3)").bind(id, tipo, ahora),
    ]));
  }

  // 2. mandar lo que haya en la cola, los partidos más cercanos primero
  const maxEnvios = Math.max(1, Math.round(aj.maxEnviosPasada * (aj.escala ?? 1)));
  const lote = (await almacen.consultar(() => db.prepare(
    `SELECT e.suscripcion, e.partido, e.tipo, e.intentos, s.endpoint, s.p256dh, s.auth, s.equipos, q.utc,
        json_extract(q.ficha, '$.local') AS local, json_extract(q.ficha, '$.visita') AS visita,
        json_extract(q.ficha, '$.local_corto') AS local_corto, json_extract(q.ficha, '$.visita_corto') AS visita_corto,
        json_extract(q.ficha, '$.liga') AS liga, json_extract(q.ficha, '$.prob_local') AS prob_local,
        json_extract(q.ficha, '$.prob_empate') AS prob_empate, json_extract(q.ficha, '$.prob_visita') AS prob_visita,
        r.gl, r.gv, r.contado
      FROM envios e LEFT JOIN suscripciones s ON s.id = e.suscripcion LEFT JOIN predicciones q ON q.id = e.partido
        LEFT JOIN resultados r ON r.id = e.partido
      ORDER BY q.utc, e.partido, e.tipo LIMIT ?1`).bind(maxEnvios).all())).results;
  const vapid = lote.length ? await clavesVapid(almacen) : null;
  const borrar = [], reintentar = [], quitar = new Set();
  const cuentas = { previo: 0, final: 0, fallo: 0, caducado: 0, baja: 0 };
  const firmas = new Map();   // una firma VAPID por servicio y pasada
  await Promise.all(lote.map(async (x) => {
    const clave = [x.suscripcion, x.partido, x.tipo];
    const sigue = x.endpoint ? JSON.parse(x.equipos) : [];
    if (!x.utc || !vapid || !(sigue.includes(x.local) || sigue.includes(x.visita))
      || (x.tipo === "final" && x.gl == null)) { borrar.push(clave); return; }
    // cuánto vale el aviso en el servicio si el aparato está apagado: el de antes, hasta
    // que empieza el partido; el del resultado, un día
    const inicio = Date.parse(x.utc);
    const ttl = Math.floor(((x.tipo === "previo" ? inicio : inicio + RESULTADO_HASTA_MS) - ahora) / 1000);
    if (ttl < 60) { borrar.push(clave); cuentas.caducado++; return; }
    const servicio = new URL(x.endpoint).origin;
    if (!firmas.has(servicio)) firmas.set(servicio, autorizacionVapid(x.endpoint, vapid, aj.urlWeb, ahora));
    const st = await mandar(x, mensajeAviso(x, reloj, ahora), ttl, await firmas.get(servicio), fetchFn);
    if (st >= 200 && st < 300) { borrar.push(clave); cuentas[x.tipo]++; }
    else if (st === 404 || st === 410) {   // el navegador ya la quitó: se borra, con lo que tuviera en cola
      if (!quitar.has(x.suscripcion)) cuentas.baja++;
      quitar.add(x.suscripcion);
    }
    else if (st === 0 || st === 429 || st >= 500) {
      if (x.intentos + 1 >= MAX_INTENTOS) { borrar.push(clave); cuentas.fallo++; } else reintentar.push(clave);
    } else {
      borrar.push(clave); cuentas.fallo++;
      console.warn(`Aviso rechazado por ${servicio}: HTTP ${st}`);
    }
  }));

  // 3. lo hecho, la limpieza y el resumen que lee el planificador
  const viejas = ahora - DIAS_SUSCRIPCION * MS_DIA;
  const fin = [
    ...borrar.map(([s, p, t]) => db.prepare("DELETE FROM envios WHERE suscripcion = ?1 AND partido = ?2 AND tipo = ?3")
      .bind(s, p, t)),
    ...reintentar.map(([s, p, t]) => db.prepare(
      "UPDATE envios SET intentos = intentos + 1 WHERE suscripcion = ?1 AND partido = ?2 AND tipo = ?3").bind(s, p, t)),
    ...[...quitar].flatMap((id) => [db.prepare("DELETE FROM envios WHERE suscripcion = ?1").bind(id),
      db.prepare("DELETE FROM suscripciones WHERE id = ?1").bind(id)]),
    ...Object.entries(cuentas).filter(([, n]) => n).map(([k, n]) => sumar(db, dia, "push", k, n)),
    // las marcas de lo ya avisado, cuando el partido ya no puede volver a avisarse
    db.prepare("DELETE FROM avisos WHERE partido NOT IN (SELECT id FROM predicciones WHERE utc > ?1)")
      .bind(isoSinMs(ahora - DIAS_MARCAS * MS_DIA)),
    db.prepare("DELETE FROM envios WHERE suscripcion IN (SELECT id FROM suscripciones WHERE vista < ?1)").bind(viejas),
    db.prepare("DELETE FROM suscripciones WHERE vista < ?1").bind(viejas),
    db.prepare("SELECT count(*) AS n, (SELECT count(*) FROM suscripciones) AS s FROM envios"),
  ];
  const r = await almacen.consultar(() => db.batch(fin));
  const { n: cola, s: quedan } = r[r.length - 1].results[0];
  const resumen = { proximo: quedan ? proximo : null, cola, revisado: ahora };   // sin suscripciones, no se mira más
  await almacen.escribir([db.prepare(
    `INSERT INTO documentos (clave, valor, actualizado) VALUES ('avisos_resumen', ?1, ?2)
     ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado
     WHERE documentos.actualizado = ?3`).bind(JSON.stringify(resumen), ahora, versionResumen ?? -1)]);
  return { encolados: tocan.length, enviados: cuentas.previo + cuentas.final, fallos: cuentas.fallo,
    bajas: cuentas.baja, caducados: cuentas.caducado, cola };
}

// Para el panel de visitas: suscripciones y avisos de la semana.
export async function resumenAvisos(almacen, desde7) {
  const db = almacen.db;
  const [s, v] = await almacen.consultar(() => db.batch([
    db.prepare("SELECT count(*) AS total, coalesce(sum(json_array_length(equipos) > 0), 0) AS con_equipos FROM suscripciones"),
    db.prepare(`SELECT tipo, clave, SUM(n) AS n FROM visitas WHERE dia >= ?1 AND tipo IN ('push', 'suscripciones')
      GROUP BY tipo, clave`).bind(desde7),
  ]));
  const out = { total: s.results[0].total, con_equipos: s.results[0].con_equipos, nuevas: 0,
    previo: 0, final: 0, fallo: 0, caducado: 0, baja: 0 };
  for (const f of v.results) {
    if (f.tipo === "suscripciones") out.nuevas += f.n;
    else if (f.clave in out) out[f.clave] += f.n;
  }
  return out;
}
