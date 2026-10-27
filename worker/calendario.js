// El calendario de Mis equipos: una dirección .ics que se suscribe una vez desde Google
// Calendar, el iPhone o Outlook, con los partidos de los equipos con estrella y su
// pronóstico, y que se pone al día sola (el calendario la vuelve a pedir cada pocas
// horas). Sin cuenta: el navegador pide una clave al azar (POST /api/calendario, con su
// lista de equipos) y la dirección es /calendario/<clave>.ics. Cuando cambian las
// estrellas, la web manda la lista nueva con la misma clave y el calendario la sigue.
// La clave es el único secreto: quien la tenga ve y cambia esa lista de equipos, nada más.
//
// Cada partido es un evento de 2 h: con el pronóstico (los enteros de la web) mientras no
// ha terminado, y con el resultado y lo que dijo la web cuando lo tiene (el texto de los
// avisos, mensajeAviso). Entran los de la ventana (con predicción y sin ella) y los de los
// últimos 7 días. Leerlo cuesta una consulta, por el nombre de cada equipo con los índices
// de las predicciones (los de equipos.js), y una escritura al día como mucho (visto).

import { ajustes } from "./config.js";
import { Reloj } from "./tiempo.js";
import { cuerpoJson, frenado, limpiarEquipos, mismoSitio } from "./cuentas.js";
import { enterosQueSuman } from "./compartir.js";
import { CAMPOS_PARTIDO, isoSinMs } from "./registro.js";
import { mensajeAviso } from "./avisos.js";

const MS_HORA = 3600000, MS_DIA = 24 * MS_HORA;
const DIAS_ATRAS = 7;             // los partidos de la última semana, con su resultado
const DURACION_MS = 2 * MS_HORA;  // lo que ocupa cada partido en el calendario
export const DIAS_SIN_USO = 120;  // un calendario que nadie pide en 4 meses se borra
const GASTO_ALTA = 3;             // filas que escribe un alta, por lo alto
const CLAVE = /^[a-z2-7]{26}$/;   // 128 bits en base32, en minúsculas

export const RUTAS_CALENDARIO = { "/api/calendario": ["POST"] };

const sumar = (db, dia, tipo, n) => db.prepare(
  `INSERT INTO visitas (dia, tipo, clave, n) VALUES (?1, ?2, '', ?3)
   ON CONFLICT (dia, tipo, clave) DO UPDATE SET n = n + excluded.n`).bind(dia, tipo, n);

function claveNueva() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ABC = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, valor = 0, out = "";
  for (const x of b) {
    valor = (valor << 8) | x;
    bits += 8;
    while (bits >= 5) { out += ABC[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out + ABC[(valor << (5 - bits)) & 31];
}

// POST /api/calendario {clave?, equipos}: crea el calendario o le cambia los equipos. Con
// una clave que ya no está (borrada por no usarse), la vuelve a crear con esa misma: así
// el calendario que la persona ya tenía suscrito sigue funcionando. {clave, borrar: true}
// lo quita en el acto: la dirección deja de funcionar.
export async function atenderCalendario(request, env, almacen, cabeceras, ahora = Date.now()) {
  const url = new URL(request.url);
  const aj = ajustes(env);
  const db = almacen.db;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status,
    headers: { ...cabeceras, "Content-Type": "application/json; charset=utf-8" } });
  if (!mismoSitio(request, url)) return json({ error: "Solo desde la propia web." }, 403);
  const d = await cuerpoJson(request);
  if (!d || (d.clave != null && !CLAVE.test(d.clave))) return json({ error: "Petición mal formada." }, 400);
  // quitarlo: siempre, sin topes (la clave es lo único que hace falta)
  if (d.borrar === true) {
    if (!d.clave) return json({ error: "Petición mal formada." }, 400);
    const r = await almacen.consultar(() => db.prepare("DELETE FROM calendarios WHERE clave = ?1").bind(d.clave).run());
    return json({ ok: true, borrado: r.meta.changes > 0 });
  }
  const equipos = limpiarEquipos(d.equipos);
  // uno que ya existe puede quedarse sin equipos (se quitaron todas las estrellas)
  if (!equipos.length && !d.clave) return json({ error: "Sigue a algún equipo antes de crear el calendario." }, 400);
  if (!d.clave && await frenado(env, request, "calendario")) {
    return json({ error: "Demasiados calendarios nuevos desde tu conexión: espera un minuto." }, 429);
  }
  const dia = new Reloj(aj.tz).local(ahora).fecha;
  const clave = d.clave || claveNueva();
  const [ya, topes] = await almacen.consultar(() => db.batch([
    db.prepare("SELECT 1 FROM calendarios WHERE clave = ?1").bind(clave),
    db.prepare(`SELECT (SELECT count(*) FROM calendarios) AS total,
        (SELECT coalesce(sum(n), 0) FROM visitas WHERE dia = ?1 AND tipo = 'calendarios' AND clave = '') AS hoy,
        (SELECT coalesce(sum(n), 0) FROM visitas WHERE dia = ?1 AND tipo = 'escrituras_calendarios' AND clave = '') AS escritas`)
      .bind(dia),
  ]));
  const nuevo = !ya.results.length;
  const t = topes.results[0];
  if (t.escritas + GASTO_ALTA > aj.maxEscriturasCalendariosDia) {
    return json({ error: "Hoy ya no se pueden guardar más cambios del calendario: prueba mañana." }, 429);
  }
  if (nuevo && (t.total >= aj.maxCalendarios || t.hoy >= aj.maxCalendariosDia)) {
    return json({ error: "Ahora mismo no se pueden crear más calendarios: prueba mañana." }, 429);
  }
  await almacen.escribir([
    db.prepare(`INSERT INTO calendarios (clave, equipos, creado, visto) VALUES (?1, ?2, ?3, ?3)
      ON CONFLICT (clave) DO UPDATE SET equipos = excluded.equipos, visto = excluded.visto`)
      .bind(clave, JSON.stringify(equipos), ahora),
    sumar(db, dia, "escrituras_calendarios", GASTO_ALTA),
    ...(nuevo ? [sumar(db, dia, "calendarios", 1),
      // de paso, los que nadie ha pedido en 4 meses
      db.prepare("DELETE FROM calendarios WHERE visto < ?1").bind(ahora - DIAS_SIN_USO * MS_DIA)] : []),
  ]);
  return json({ ok: true, clave, ruta: `/calendario/${clave}.ics`, equipos: equipos.length });
}

// ---------- el .ics ----------

// RFC 5545: texto escapado, líneas de 75 octetos como mucho (las siguientes empiezan con
// un espacio), sin partir un carácter de UTF-8, y CRLF.
const escapar = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");
const COD = new TextEncoder();
function plegar(linea) {
  if (COD.encode(linea).length <= 75) return linea;
  const partes = [];
  let actual = "", octetos = 0, max = 75;
  for (const c of linea) {
    const n = COD.encode(c).length;
    if (octetos + n > max) { partes.push(actual); actual = ""; octetos = 0; max = 74; }   // el espacio cuenta
    actual += c;
    octetos += n;
  }
  partes.push(actual);
  return partes.join("\r\n ");
}
const fechaIcs = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

const COLUMNAS = [...CAMPOS_PARTIDO, "prob_mas_25", "utcDate"];
const cols = (t, json) => COLUMNAS.map((c) => `json_extract(${t}.${json}, '$.${c}') AS c_${c}`).join(", ");
// lo publicado de cada equipo desde hace una semana, con su resultado si lo hay (por su
// nombre, con los índices), y lo de la ventana que aún no tiene predicción
const sqlPredicciones = (lado) => `SELECT ${cols("p", "ficha")}, r.gl, r.gv, r.contado
  FROM json_each(?1) e JOIN predicciones p INDEXED BY predicciones_por_${lado} ON json_extract(p.ficha, '$.${lado}') = e.value
  LEFT JOIN resultados r ON r.id = p.id WHERE p.utc >= ?2`;
const SQL_SIN_PREDICCION = `SELECT ${cols("pa", "base")}, NULL AS gl, NULL AS gv, NULL AS contado FROM partidos pa
  WHERE NOT EXISTS (SELECT 1 FROM predicciones WHERE id = pa.id)
    AND EXISTS (SELECT 1 FROM json_each(?1) e WHERE e.value IN (json_extract(pa.base, '$.local'), json_extract(pa.base, '$.visita')))`;

// Un evento: el pronóstico, o el resultado cuando lo hay.
function evento(x, origen, reloj, ahora) {
  const local = x.local_corto || x.local, visita = x.visita_corto || x.visita;
  const ini = Date.parse(x.utcDate);
  const enlace = `${origen}/partido/${x.id}`;
  let titulo = `${local} – ${visita}`, texto;
  if (x.gl != null) {
    const m = mensajeAviso({ ...x, tipo: "final", partido: x.id, contado: x.contado === 1 }, reloj, ahora);
    titulo = m.titulo.replace(/^Final: /, "");
    texto = `Final. ${m.cuerpo}`;
  } else if (x.prob_local != null) {
    const [l, e, v] = enterosQueSuman([x.prob_local, x.prob_empate, x.prob_visita]);
    texto = `${x.liga}. Pronóstico: ${local} ${l} % · empate ${e} % · ${visita} ${v} %.`
      + (x.prob_mas_25 != null ? ` Más de 2.5 goles: ${Math.round(x.prob_mas_25)} %.` : "");
  } else {
    texto = `${x.liga}. Pronóstico en cálculo.`;
  }
  return ["BEGIN:VEVENT", `UID:partido-${x.id}@pronosticos-bot`, `DTSTAMP:${fechaIcs(ahora)}`,
    `DTSTART:${fechaIcs(ini)}`, `DTEND:${fechaIcs(ini + DURACION_MS)}`, `SUMMARY:${escapar(titulo)}`,
    `DESCRIPTION:${escapar(`${texto}\nLos números de la web, al día: ${enlace}`)}`, `URL:${enlace}`,
    "TRANSP:TRANSPARENT", "END:VEVENT"];
}

export function textoCalendario(partidos, origen, reloj, ahora) {
  const lineas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//pronosticos-bot//Mis equipos//ES", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", "X-WR-CALNAME:Mis equipos · Pronósticos",
    "X-WR-CALDESC:Los partidos de tus equipos con el pronóstico de la web", "X-WR-TIMEZONE:America/Lima",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"];
  for (const x of partidos) lineas.push(...evento(x, origen, reloj, ahora));
  lineas.push("END:VCALENDAR");
  return lineas.map(plegar).join("\r\n") + "\r\n";
}

// GET /calendario/<clave>.ics
export async function servirCalendario(request, env, almacen, clave, ahora = Date.now()) {
  const db = almacen.db;
  const cab = { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
  const fila = await almacen.consultar(() => db.prepare("SELECT equipos, visto FROM calendarios WHERE clave = ?1")
    .bind(clave).first());
  if (!fila) return new Response("Este calendario no existe.\n", { status: 404, headers: { ...cab, "Content-Type": "text/plain; charset=utf-8" } });
  const desde = isoSinMs(ahora - DIAS_ATRAS * MS_DIA);
  const [deLocal, deVisita, sinPred] = await almacen.consultar(() => db.batch([
    db.prepare(sqlPredicciones("local")).bind(fila.equipos, desde),
    db.prepare(sqlPredicciones("visita")).bind(fila.equipos, desde),
    db.prepare(SQL_SIN_PREDICCION).bind(fila.equipos),
  ]));
  // un partido entre dos equipos seguidos sale una vez
  const porId = new Map();
  for (const f of [...deLocal.results, ...deVisita.results, ...sinPred.results]) {
    const x = { gl: f.gl, gv: f.gv, contado: f.contado };
    for (const c of COLUMNAS) x[c] = f["c_" + c];
    porId.set(x.id, x);
  }
  const partidos = [...porId.values()].sort((a, b) => (a.utcDate < b.utcDate ? -1 : a.utcDate > b.utcDate ? 1 : a.id - b.id));
  // que se usa: una escritura al día como mucho
  if (fila.visto < ahora - MS_DIA) {
    await almacen.escribir([db.prepare("UPDATE calendarios SET visto = ?2 WHERE clave = ?1").bind(clave, ahora)]);
  }
  const texto = textoCalendario(partidos, new URL(request.url).origin, new Reloj(ajustes(env).tz), ahora);
  return new Response(request.method === "HEAD" ? null : texto, { headers: cab });
}

// Para el panel de visitas: cuántos hay, cuántos se crearon esta semana y cuántos pidió
// algún calendario en la última.
export async function resumenCalendarios(almacen, desde7, ahora = Date.now()) {
  const r = await almacen.consultar(() => almacen.db.prepare(
    `SELECT (SELECT count(*) FROM calendarios) AS total,
       (SELECT count(*) FROM calendarios WHERE visto >= ?2) AS usados,
       (SELECT coalesce(sum(n), 0) FROM visitas WHERE dia >= ?1 AND tipo = 'calendarios' AND clave = '') AS nuevos`)
    .bind(desde7, ahora - 8 * MS_DIA).first());
  return { total: r.total, usados: r.usados, nuevos: r.nuevos };
}
