// Avisar a los buscadores de las páginas nuevas (IndexNow). Lo aceptan Bing, Yandex,
// Seznam, Naver y Yep, y de Bing beben también DuckDuckGo, Yahoo, Ecosia y la búsqueda de
// ChatGPT; Google no (para él están el sitemap y Search Console). Gratis y sin cuenta:
// basta con publicar la clave en /<clave>.txt (public/) y mandar las direcciones a uno de
// ellos, que las reparte entre todos: a Bing (www.bing.com/indexnow). Al principio iban a
// api.indexnow.org, que el 30 oct 2026 respondió 429 ("demasiadas peticiones") las tres
// veces, seguramente por las IP de salida de Cloudflare, que comparten muchas webs.
//
// Lo hace el cron en un minuto libre (planificador.js) cada HORAS_INDEXNOW, con la web al
// día y sin la API ni el candado, como la limpieza, con lo que cambió desde la vez
// anterior: los partidos que entraron en la ventana con su predicción, los que
// terminaron (su página enseña ya el marcador), los equipos de unos y otros, sus ligas,
// la portada y el historial de aciertos (/resultados y la semana de cada uno). La primera
// vez van además todas las ligas, los equipos de las tablas y todas las semanas. Lo
// que mandó y la respuesta quedan en el documento indexnow; si falla, la vez siguiente
// lo vuelve a mandar todo, cada vez más tarde (6, 12 y 24 h, o lo que diga Retry-After).

import { INDEXNOW_CLAVE, ajustes } from "./config.js";
import { CODIGOS } from "./compartir.js";
import { equiposDeTablas } from "./equipos.js";
import { isoSinMs } from "./registro.js";
import { lunesDe, semanasConResultados } from "./resultados.js";
import { Reloj } from "./tiempo.js";

const MS_HORA = 3600000;
export const HORAS_INDEXNOW = 3;
const MAX_URLS = 10000;   // lo más que admite una petición
const MAX_ESPERA_H = 48;  // lo más que se espera tras un fallo, aunque Retry-After pida más

// doc: el documento indexnow tal como lo lee el planificador ({texto, actualizado}). Tras
// un fallo se espera lo que diga su espera_h; si no, HORAS_INDEXNOW. El texto solo se lee
// pasadas esas horas: los demás minutos no cuesta nada.
export function tocaIndexnow(doc, resumen, aj, ahora) {
  if (!aj.indexnowUrl || !resumen || resumen.estado !== "listo") return null;
  if (!doc) return "nunca se ha hecho";
  const horas = (ahora - doc.actualizado) / MS_HORA;
  if (horas < HORAS_INDEXNOW) return null;
  let espera = HORAS_INDEXNOW;
  try { espera = JSON.parse(doc.texto).espera_h || HORAS_INDEXNOW; } catch { /* sin texto: lo de siempre */ }
  return horas >= espera ? `la última hace ${Math.trunc(horas)} h` : null;
}

// Horas que pide esperar una cabecera Retry-After (segundos o una fecha), o 0.
export function horasRetryAfter(valor, ahora) {
  if (!valor) return 0;
  const s = /^\d+$/.test(valor.trim()) ? Number(valor) : (Date.parse(valor) - ahora) / 1000;
  return Number.isFinite(s) && s > 0 ? Math.ceil(s / 3600) : 0;
}

// Las direcciones que cambiaron desde la vez anterior (previo: el documento indexnow, o
// null si nunca se hizo; hasta que una llega, al_dia es false y se manda todo), y lo que
// hay que guardar si llegan: hasta dónde se leyeron los resultados (liquidado) y qué
// partidos de la ventana ya se mandaron.
export async function cambios(almacen, previo, ahora, reloj = new Reloj(ajustes().tz)) {
  const db = almacen.db;
  const primera = !(previo && previo.al_dia);
  const desde = primera ? 0 : previo.desde;
  const yaEnviados = new Set(primera ? [] : previo.enviados);
  const [ventana, terminados] = await almacen.consultar(() => db.batch([
    db.prepare(`SELECT pa.id, pa.liga, pa.local_id, pa.visita_id FROM partidos pa JOIN predicciones pr ON pr.id = pa.id
      WHERE pa.utc > ?1`).bind(isoSinMs(ahora)),
    db.prepare(`SELECT r.id, r.liga, r.utc, r.liquidado, r.contado, json_extract(p.ficha, '$.local_id') AS local_id,
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
  const semanas = new Set();
  for (const f of terminados.results) {
    apuntar(f);
    hasta = Math.max(hasta, f.liquidado);
    if (f.contado) semanas.add(lunesDe(reloj.local(Date.parse(f.utc)).fecha));
  }
  if (primera) {
    for (const c of CODIGOS) ligas.add(c);
    for (const [id] of await equiposDeTablas(almacen)) equipos.add(id);
    for (const s of await semanasConResultados(almacen, reloj)) semanas.add(s);
  }
  const rutas = partidos.size || primera ? ["/"] : [];
  if (semanas.size) rutas.push("/resultados");
  for (const s of semanas) rutas.push(`/resultados/${s}`);
  for (const c of ligas) rutas.push(`/liga/${c}`);
  for (const id of partidos) rutas.push(`/partido/${id}`);
  for (const id of equipos) rutas.push(`/equipo/${id}`);
  return { rutas: rutas.slice(0, MAX_URLS), desde: hasta, enviados: ventana.results.map((f) => Number(f.id)) };
}

// Si no responde 200 o 202, se apunta igual (para no repetirlo cada minuto) sin mover lo
// ya mandado: la vez siguiente va otra vez.
export async function avisarBuscadores(almacen, aj, previo, ahora, fetchFn = fetch) {
  const c = await cambios(almacen, previo, ahora, new Reloj(aj.tz));
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
      if (r.status !== 200 && r.status !== 202) {
        doc.error = (await r.text()).slice(0, 300);
        const ra = r.headers.get("Retry-After");
        if (ra) doc.retry_after = ra.slice(0, 100);
      }
    } catch (e) {
      doc.estado = 0;
      doc.error = String((e && e.message) || e).slice(0, 300);
    }
    if (doc.error !== undefined) {
      console.error(`IndexNow: ${doc.estado} ${doc.error}`);
      // cada fallo seguido dobla la espera (6, 12, 24 h), y si pide más con Retry-After, eso
      const fallos = ((previo && previo.fallos) || 0) + 1;
      const espera = Math.max(Math.min(24, HORAS_INDEXNOW * 2 ** fallos), horasRetryAfter(doc.retry_after, ahora));
      Object.assign(doc, { al_dia: Boolean(previo && previo.al_dia), desde: previo ? previo.desde : 0,
        enviados: previo ? previo.enviados : [], fallos, espera_h: Math.min(MAX_ESPERA_H, espera) });
    }
  }
  await almacen.escribir([almacen.sentenciaDoc("indexnow", doc, ahora)]);
  return { urls: doc.urls, estado: doc.estado ?? null };
}
