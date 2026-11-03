// La porra contra el modelo: con la cuenta abierta, cada uno elige 1, X o 2 en los
// partidos que aún no han empezado, y al terminar se compara su acierto con el de la web
// en esos mismos partidos (su favorito, el de la ficha publicada antes de empezar). Sin
// dinero ni premios, y sin clasificación pública: cada uno ve solo lo suyo.
//
// Se guarda en la tabla porra (cuenta, partido, signo y cuándo lo eligió). Elegir o
// cambiar es una fila, que cuenta en el tope de escrituras de las cuentas
// (MAX_ESCRITURAS_CUENTAS_DIA, cuentas.js); se puede cambiar hasta que empieza el
// partido, y no se puede elegir sin el pronóstico de la web ya publicado (si no, no hay
// con qué comparar). Lo sumado se cuenta al pedirlo, con lo que haya en resultados (el
// marcador a los 90 minutos, que ya apunta el registro en vivo): sin peticiones a la API
// y sin trabajo en el cron. Solo cuentan los partidos en que la web publicó antes de
// empezar (resultados.contado), los mismos del registro en vivo.
//
// La clasificación (nov 2026): quien quiere sale en ella con un apodo (tabla apodos), que
// no es su usuario: el usuario sirve para entrar y no se enseña a nadie. Sin apodo, no
// sale. Se ordena por aciertos (y, con los mismos, gana quien jugó menos partidos), esta
// semana, la pasada o desde siempre; la web va en su columna, en esos mismos partidos. Se
// cuenta en D1 con una consulta y se guarda unos minutos (MINUTOS_CLASIFICACION) en un
// documento: pedirla es leer una fila.

import { ajustes } from "./config.js";
import { CAMPOS_PARTIDO, entradaDe, isoSinMs } from "./registro.js";
import { favoritoDe } from "./compartir.js";
import { inicioDia, lunesDe } from "./resultados.js";
import { Reloj, sumarDias } from "./tiempo.js";

export const SIGNOS = new Set(["1", "X", "2"]);
const ULTIMOS = 30;
const COLUMNAS = CAMPOS_PARTIDO.map((c) => `json_extract(pr.ficha, '$.${c}') AS c_${c}`).join(", ");

// Lo de una cuenta: lo que eligió en los partidos por jugar ({id: signo}), lo sumado de
// los ya jugados (cuántos, en cuántos acertó y en cuántos la web) y los últimos, con su
// marcador, lo que eligió y lo que daba la web.
export async function verPorra(almacen, cuenta, reloj, ahora = Date.now()) {
  const db = almacen.db;
  const [proximas, jugadas] = await almacen.consultar(() => db.batch([
    db.prepare(`SELECT q.partido, q.signo FROM porra q JOIN partidos pa ON pa.id = q.partido
      WHERE q.cuenta = ?1 AND pa.utc > ?2`).bind(cuenta, isoSinMs(ahora)),
    db.prepare(`SELECT q.signo, r.gl, r.gv, r.utc, ${COLUMNAS} FROM porra q JOIN resultados r ON r.id = q.partido
      JOIN predicciones pr ON pr.id = q.partido WHERE q.cuenta = ?1 AND r.contado = 1 ORDER BY r.utc DESC, r.id`).bind(cuenta),
  ]));
  const resumen = { jugados: 0, aciertos: 0, web: 0 };
  const ultimos = [];
  for (const x of jugadas.results) {
    const ficha = { utcDate: x.utc };
    for (const c of CAMPOS_PARTIDO) ficha[c] = x["c_" + c];
    const paso = x.gl > x.gv ? "1" : x.gl === x.gv ? "X" : "2";
    const web = favoritoDe(ficha)[0];
    resumen.jugados++;
    if (x.signo === paso) resumen.aciertos++;
    if (web === paso) resumen.web++;
    if (ultimos.length < ULTIMOS) ultimos.push({ ...entradaDe(ficha, x.gl, x.gv, reloj.local(Date.parse(x.utc))), signo: x.signo });
  }
  const apodo = await almacen.consultar(() => db.prepare("SELECT apodo FROM apodos WHERE cuenta = ?1").bind(cuenta).first());
  return { estado: "listo", elegidos: Object.fromEntries(proximas.results.map((f) => [f.partido, f.signo])), resumen, ultimos,
    apodo: apodo ? apodo.apodo : null };
}

// Si se puede elegir en ese partido: que exista, que no haya empezado y que la web ya
// haya publicado su pronóstico. Da null si se puede, o [mensaje, status].
export async function noSePuede(almacen, id, ahora = Date.now()) {
  const f = await almacen.consultar(() => almacen.db.prepare(
    `SELECT pa.utc, pr.id IS NOT NULL AS con_ficha FROM partidos pa LEFT JOIN predicciones pr ON pr.id = pa.id
     WHERE pa.id = ?1`).bind(id).first());
  if (!f) return ["Ese partido ya no está en la web.", 404];
  if (Date.parse(f.utc) <= ahora) return ["Ese partido ya empezó: no se puede cambiar.", 409];
  if (!f.con_ficha) return ["La web aún no ha calculado ese partido: vuelve en unos minutos.", 409];
  return null;
}

// La sentencia que guarda lo elegido (o lo quita, con signo null).
export function sentenciaPorra(db, cuenta, id, signo, ahora) {
  return signo === null
    ? db.prepare("DELETE FROM porra WHERE cuenta = ?1 AND partido = ?2").bind(cuenta, id)
    : db.prepare(`INSERT INTO porra (cuenta, partido, signo, cuando) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (cuenta, partido) DO UPDATE SET signo = excluded.signo, cuando = excluded.cuando`)
      .bind(cuenta, id, signo, ahora);
}

// ---- El apodo ----

const MIN_APODO = 3, MAX_APODO = 20;
// Lo que no puede llevar un apodo (en su clave: sin tildes, mayúsculas, espacios ni signos):
// unos pocos insultos y lo que haría pasar a alguien por la web. Lo demás lo ve el dueño de
// la web, que puede borrar un apodo en D1 (DELETE FROM apodos WHERE clave = ...).
const PROHIBIDOS = ["puta", "puto", "mierda", "verga", "pinga", "maricon", "pendej", "cabron", "concha", "joder",
  "polla", "nazi", "hitler", "admin", "moderador", "pronostico", "laweb"];

// La clave de un texto: sin tildes ni mayúsculas, solo letras y números.
export const claveApodo = (texto) => String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9ñ]/g, "");

// El apodo como se enseña (espacios de más fuera) y su clave, o [null, por qué no vale].
// Letras (con tildes y ñ), números, espacios, punto, guion y guion bajo; de 3 a 20, y
// empieza por letra o número.
export function normalizarApodo(texto, usuario) {
  const apodo = String(texto ?? "").trim().replace(/\s+/g, " ");
  if (apodo.length < MIN_APODO || apodo.length > MAX_APODO || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(apodo)) {
    return [null, `El apodo lleva de ${MIN_APODO} a ${MAX_APODO} letras, números, espacios, punto o guion, y empieza por letra o número.`];
  }
  const clave = claveApodo(apodo);
  if (clave.length < MIN_APODO) return [null, `El apodo necesita al menos ${MIN_APODO} letras o números.`];
  if (PROHIBIDOS.some((p) => clave.includes(p))) return [null, "Ese apodo no se puede usar: elige otro."];
  if (usuario && clave === claveApodo(usuario)) {
    return [null, "Elige un apodo distinto de tu usuario: el usuario sirve para entrar y mejor que nadie lo vea."];
  }
  return [{ apodo, clave }, null];
}

// La sentencia que pone o cambia el apodo (o lo quita, con null).
export function sentenciaApodo(db, cuenta, a, ahora) {
  return a === null
    ? db.prepare("DELETE FROM apodos WHERE cuenta = ?1").bind(cuenta)
    : db.prepare(`INSERT INTO apodos (cuenta, clave, apodo, desde) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (cuenta) DO UPDATE SET clave = excluded.clave, apodo = excluded.apodo`)
      .bind(cuenta, a.clave, a.apodo, ahora);
}

// ---- La clasificación ----

export const PERIODOS = ["semana", "pasada", "siempre"];
const MAX_FILAS = 100;

// Lo que pasó y lo que daba la web (su favorito: el mayor y, si empatan, el primero, como
// favoritoDe) de cada partido elegido por quien tiene apodo, en el periodo, sumado por cuenta.
const CLASIFICACION = `WITH j AS (
    SELECT q.cuenta, a.apodo, a.desde, q.signo,
      CASE WHEN r.gl > r.gv THEN '1' WHEN r.gl = r.gv THEN 'X' ELSE '2' END AS paso,
      json_extract(p.ficha, '$.prob_local') AS pl, json_extract(p.ficha, '$.prob_empate') AS pe,
      json_extract(p.ficha, '$.prob_visita') AS pv
    FROM porra q JOIN apodos a ON a.cuenta = q.cuenta JOIN resultados r ON r.id = q.partido
    JOIN predicciones p ON p.id = q.partido
    WHERE r.contado = 1 AND r.utc >= ?1 AND r.utc < ?2)
  SELECT apodo, desde, count(*) AS jugados, sum(signo = paso) AS aciertos,
    sum(CASE WHEN pl >= pe AND pl >= pv THEN '1' WHEN pe >= pv THEN 'X' ELSE '2' END = paso) AS web
  FROM j GROUP BY cuenta ORDER BY aciertos DESC, jugados ASC, desde ASC, apodo LIMIT ?3`;

// La clasificación de un periodo, contada (sin la caché).
export async function contarClasificacion(almacen, reloj, periodo, ahora = Date.now()) {
  const lunes = lunesDe(reloj.local(ahora).fecha);
  const desde = periodo === "semana" ? lunes : periodo === "pasada" ? sumarDias(lunes, -7) : null;
  const hasta = desde ? sumarDias(desde, 7) : null;
  const r = await almacen.consultar(() => almacen.db.prepare(CLASIFICACION).bind(
    desde ? isoSinMs(inicioDia(reloj, desde)) : "", hasta ? isoSinMs(inicioDia(reloj, hasta)) : "9999",
    MAX_FILAS + 1).all());
  const filas = r.results.slice(0, MAX_FILAS);
  // el puesto: 1 más los que van por delante (más aciertos, o los mismos con menos partidos)
  let puesto = 0;
  const out = filas.map((f, i) => {
    const antes = filas[i - 1];
    if (!antes || antes.aciertos !== f.aciertos || antes.jugados !== f.jugados) puesto = i + 1;
    return { puesto, apodo: f.apodo, jugados: f.jugados, aciertos: f.aciertos, web: f.web };
  });
  return { estado: "listo", plataforma: "cloudflare", periodo, desde, hasta: hasta && sumarDias(hasta, -1),
    filas: out, mas: r.results.length > MAX_FILAS };
}

// GET /api/porra/clasificacion?periodo=semana|pasada|siempre: la guardada, si es de hace
// menos de MINUTOS_CLASIFICACION y de la misma semana; si no, se cuenta y se guarda. Cuándo
// se contó va solo en lo guardado: así, contada otra vez con lo mismo, el ETag no cambia.
export async function apiClasificacion(almacen, env, periodo, ahora = Date.now()) {
  const aj = ajustes(env), reloj = new Reloj(aj.tz);
  const p = PERIODOS.includes(periodo) ? periodo : "semana";
  const clave = "clasificacion:" + p;
  const lunes = lunesDe(reloj.local(ahora).fecha);
  const guardada = await almacen.leerDoc(clave);
  if (guardada && guardada.lunes === lunes && ahora - guardada.contada < aj.minutosClasificacion * 60000) {
    delete guardada.lunes;
    delete guardada.contada;
    return guardada;
  }
  const d = await contarClasificacion(almacen, reloj, p, ahora);
  await almacen.escribir([almacen.sentenciaDoc(clave, { ...d, lunes, contada: ahora }, ahora)]);
  return d;
}
