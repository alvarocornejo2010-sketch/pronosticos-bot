// Avisar a los buscadores de las páginas nuevas (IndexNow). Lo aceptan Bing, Yandex,
// Seznam, Naver y Yep, y de Bing beben también DuckDuckGo, Yahoo, Ecosia y la búsqueda de
// ChatGPT; Google no (para él están el sitemap y Search Console). Gratis y sin cuenta:
// basta con publicar la clave en /<clave>.txt (public/) y mandar las direcciones a
// api.indexnow.org, que las reparte entre todos.
//
// Lo hace el cron en un minuto libre (planificador.js) cada HORAS_INDEXNOW, con la web al
// día y sin la API ni el candado, como la limpieza, con lo que cambió desde la vez
// anterior: los partidos que entraron en la ventana con su predicción, los que
// terminaron (su página enseña ya el marcador), los equipos de unos y otros, sus ligas y
// la portada. La primera vez van además todas las ligas y los equipos de las tablas. Lo
// que mandó y la respuesta quedan en el documento indexnow; si falla, la vez siguiente
// lo vuelve a mandar todo.

import { INDEXNOW_CLAVE } from "./config.js";
import { CODIGOS } from "./compartir.js";
import { equiposDeTablas } from "./equipos.js";
import { isoSinMs } from "./registro.js";

const MS_HORA = 3600000;
export const HORAS_INDEXNOW = 3;
const MAX_URLS = 10000;   // lo más que admite una petición

// doc: el documento indexnow tal como lo lee el planificador ({texto, actualizado}).
export function tocaIndexnow(doc, resumen, aj, ahora) {
  if (!aj.indexnowUrl || !resumen || resumen.estado !== "listo") return null;
  if (!doc) return "nunca se ha hecho";
  const horas = (ahora - doc.actualizado) / MS_HORA;
  return horas >= HORAS_INDEXNOW ? `la última hace ${Math.trunc(horas)} h` : null;
}

// Las direcciones que cambiaron desde la vez anterior (previo: el documento indexnow, o
// null si nunca se hizo; hasta que una llega, al_dia es false y se manda todo), y lo que
// hay que guardar si llegan: hasta dónde se leyeron los resultados (liquidado) y qué
// partidos de la ventana ya se mandaron.
export async function cambios(almacen, previo, ahora) {
  const db = almacen.db;
  const primera = !(previo && previo.al_dia);
  const desde = primera ? 0 : previo.desde;
  const yaEnviados = new Set(primera ? [] : previo.enviados);
  const [ventana, terminados] = await almacen.consultar(() => db.batch([
    db.prepare(`SELECT pa.id, pa.liga, pa.local_id, pa.visita_id FROM partidos pa JOIN predicciones pr ON pr.id = pa.id
      WHERE pa.utc > ?1`).bind(isoSinMs(ahora)),
    db.prepare(`SELECT r.id, r.liga, r.liquidado, json_extract(p.ficha, '$.local_id') AS local_id,
      json_extract(p.ficha, '$.visita_id') AS visita_id FROM resultados r JOIN predicciones p ON p.id = r.id
      WHERE r.liquidado > ?1`).bind(desde),
  ]));
  const partidos = new Set(), equipos = new Set(), ligas = new Set();
  const apuntar = (f) => {
    partidos.add(Number(f.id));
    for (const e of [f.local_id, f.visita_id]) if (Number.isInteger(e) && e > 0) equipos.add(e);
    if (CODIGOS.has(f.liga)) ligas.add(f.liga);
  };
  for (const f of ventana.results) if (!yaEnviados.has(Number(f.id))) apuntar(f);
  let hasta = desde;
  for (const f of terminados.results) { apuntar(f); hasta = Math.max(hasta, f.liquidado); }
  if (primera) {
    for (const c of CODIGOS) ligas.add(c);
    for (const [id] of await equiposDeTablas(almacen)) equipos.add(id);
  }
  const rutas = partidos.size || primera ? ["/"] : [];
  for (const c of ligas) rutas.push(`/liga/${c}`);
  for (const id of partidos) rutas.push(`/partido/${id}`);
  for (const id of equipos) rutas.push(`/equipo/${id}`);
  return { rutas: rutas.slice(0, MAX_URLS), desde: hasta, enviados: ventana.results.map((f) => Number(f.id)) };
}

// Si no responde 200 o 202, se apunta igual (para no repetirlo cada minuto) sin mover lo
// ya mandado: la vez siguiente va otra vez.
export async function avisarBuscadores(almacen, aj, previo, ahora, fetchFn = fetch) {
  const c = await cambios(almacen, previo, ahora);
  const doc = { hecha: new Date(ahora).toISOString(), urls: c.rutas.length, al_dia: true, desde: c.desde, enviados: c.enviados };
  if (c.rutas.length) {
    const origen = aj.urlWeb.replace(/\/+$/, "");
    try {
      const r = await fetchFn(aj.indexnowUrl, {
        method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: new URL(origen).host, key: INDEXNOW_CLAVE, keyLocation: `${origen}/${INDEXNOW_CLAVE}.txt`,
          urlList: c.rutas.map((ruta) => origen + ruta) }),
      });
      doc.estado = r.status;
      if (r.status !== 200 && r.status !== 202) doc.error = (await r.text()).slice(0, 300);
    } catch (e) {
      doc.estado = 0;
      doc.error = String((e && e.message) || e).slice(0, 300);
    }
    if (doc.error !== undefined) {
      console.error(`IndexNow: ${doc.estado} ${doc.error}`);
      Object.assign(doc, { al_dia: Boolean(previo && previo.al_dia), desde: previo ? previo.desde : 0,
        enviados: previo ? previo.enviados : [] });
    }
  }
  await almacen.escribir([almacen.sentenciaDoc("indexnow", doc, ahora)]);
  return { urls: doc.urls, estado: doc.estado ?? null };
}
