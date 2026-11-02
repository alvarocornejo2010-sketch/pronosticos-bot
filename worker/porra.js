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

import { CAMPOS_PARTIDO, entradaDe, isoSinMs } from "./registro.js";
import { favoritoDe } from "./compartir.js";

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
  return { estado: "listo", elegidos: Object.fromEntries(proximas.results.map((f) => [f.partido, f.signo])), resumen, ultimos };
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
