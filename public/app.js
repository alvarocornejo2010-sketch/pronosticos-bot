// La lógica de la web. Va aparte de index.html para que la política de
// seguridad (CSP: script-src 'self') no tenga que permitir JavaScript en línea:
// si algún día se colara HTML ajeno por un fallo de escapado, un <script> o un
// onerror= inyectados no se ejecutarían.

// Los errores de la propia web van al panel de visitas (sección VISITAS): solo el
// tipo y la línea de app.js, nada del mensaje, que puede llevar datos de la página.
// Se apuntan desde aquí por si algo falla al arrancar; como mucho 3 por visita.
const erroresWeb = [];
let erroresApuntados = 0;
function apuntarError(tipo, linea) {
  if (erroresApuntados++ < 3) erroresWeb.push({ t: "error", k: tipo, l: linea });
}
window.addEventListener("error", (e) => {
  if (!e.filename || !/\/app\.js(\?|$)/.test(e.filename)) return;   // no los de una extensión del navegador
  const n = e.error && e.error.name;
  apuntarError(/^(TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError|AggregateError)$/.test(n) ? n : "Error",
    e.lineno || 0);
});
window.addEventListener("unhandledrejection", () => apuntarError("Promesa", 0));

const $ = (id) => document.getElementById(id);
const app = document.querySelector(".app");
const vista = $("vista");
const fechasEl = $("fechas");
const bandaEl = $("banda");
const tiraLigasEl = $("tira-ligas");
const ordenEl = $("orden");
const tituloEl = $("titulo-vista");
const centroEl = document.querySelector(".centro");
// En escritorio sobra sitio para toda la ventana de golpe; en el móvil se abre en el primer día.
const mqEscritorio = window.matchMedia("(min-width: 880px)");
const limpiarHueco = $("limpiar-hueco");
const paneLigas = $("pane-ligas");
const panePan = $("pane-panorama");
const proximosEl = $("proximos");
const estadoBarra = $("estado-barra");
const estadoCorto = $("estado-corto");
const inputBuscar = $("buscador");
const tip = $("tip");

let datos = null;        // último /api/estado
let validacion = null;   // /api/validacion: puede no haberse ejecutado nunca
let registro = null;     // /api/registro: lo publicado contra lo que pasó (solo en Cloudflare)
let infoLigas = null;    // /api/ligas: medias de goles que usa el modelo
let rutaPintada = null;
let ligaContada = null;   // la liga en la que ya se contó la entrada (visitas)
let equipoContado = null;   // y el equipo

// Los equipos que sigue quien mira, por su nombre completo, en su navegador (sin
// cuenta). Sus partidos salen en "Mis equipos", primero en cada día y primero en
// los próximos. versionFav entra en la huella de las filas: cambia su estrella.
const CLAVE_FAVORITOS = "pronosticos.favoritos";
const MAX_FAVORITOS = 60;
const favoritos = new Set(leerFavoritos());
let versionFav = 0;
function leerFavoritos() {
  try {
    const v = JSON.parse(localStorage.getItem(CLAVE_FAVORITOS) || "[]");
    return Array.isArray(v) ? v.filter(x => typeof x === "string" && x).slice(0, MAX_FAVORITOS) : [];
  } catch (e) { return []; }
}
function guardarFavoritos() {
  try { localStorage.setItem(CLAVE_FAVORITOS, JSON.stringify([...favoritos])); }
  catch (e) { /* sin memoria: dura lo que la pestaña */ }
  equiposCambiados();   // los avisos llevan la lista de equipos (sección AVISOS)
}
function esFavorito(p) { return favoritos.has(p.local) || favoritos.has(p.visita); }

// /partido/123: un enlace compartido (worker/compartir.js le pone la tarjeta de
// WhatsApp). En cuanto llegan los datos se abre ese partido y la dirección vuelve
// a la de siempre.
const enlacePartido = (location.pathname.match(/^\/partido\/(\d+)\/?$/) || [])[1] || null;
let partidoEnlazado = enlacePartido;
// /equipo/86: la página de un equipo compartida (worker/equipos.js le pone la tarjeta).
// Es una vista más de la web: la dirección pasa en el acto a /#/equipo/86.
const enlaceEquipo = (location.pathname.match(/^\/equipo\/(\d{1,9})\/?$/) || [])[1] || null;
if (enlaceEquipo) history.replaceState(null, "", "/#/equipo/" + enlaceEquipo);
let orden = "hora";
let mercadoFiab = "1x2";   // qué mercado enseña el panel de fiabilidad
let fuenteFiab = "validacion";   // y de dónde: la temporada pasada o el registro en vivo
let busqueda = "";
const abiertos = new Set();
const escudosRotos = new Set();

// Identidad de liga: la SIGLA es el canal principal y va siempre dentro de la
// insignia; el tono acompaña. Ninguna paleta de cuatro o más colores pasa la
// prueba de todos-los-pares, así que donde cualquier liga puede quedar junto a
// cualquier otra (tabla ordenada, próximos) es la sigla la que distingue.
// "tinta": la que contrasta con el tono (todas >= 4.8:1). La Champions va primera
// y con insignia de contorno: es un torneo, no una liga, y no gasta un tono.
const LIGAS = {
  CL:  { sigla: "UCL", tono: "none",            tinta: "var(--tinta)", copa: true },
  PD:  { sigla: "ESP", tono: "var(--liga-PD)",  tinta: "var(--oscura)" },
  PL:  { sigla: "ENG", tono: "var(--liga-PL)",  tinta: "var(--oscura)" },
  FL1: { sigla: "FRA", tono: "var(--liga-FL1)", tinta: "var(--oscura)" },
  BL1: { sigla: "ALE", tono: "var(--liga-BL1)", tinta: "var(--oscura)" },
  SA:  { sigla: "ITA", tono: "var(--liga-SA)",  tinta: "var(--oscura)" },
  DED: { sigla: "NED", tono: "var(--liga-DED)", tinta: "var(--oscura)" },
  PPL: { sigla: "POR", tono: "var(--liga-PPL)", tinta: "var(--oscura)" },
  ELC: { sigla: "EN2", tono: "var(--liga-ELC)", tinta: "#ffffff" },
  BSA: { sigla: "BRA", tono: "var(--liga-BSA)", tinta: "var(--oscura)" },
};
const ORDEN_LIGAS = Object.keys(LIGAS);

// Las ligas donde el modelo aporta poco: su mejora sobre "no saber nada" (skill del
// 1X2 frente a la base "equipo medio"), medida con afinar_liga.py en las temporadas
// de prueba. En las demás ligas va de +7.5 a +15.6 %. Son las más igualadas: el
// número es tan honesto como en las otras, pero se separa poco de la moneda al aire.
const POCO_FIABLES = {
  ELC: { skill: 2.7, partidos: "2.855", cuando: "las temporadas 2021/22 a 2025/26" },
  BSA: { skill: 3.5, partidos: "277", cuando: "2026 hasta octubre" },
};
function textoPocoFiable(cod, nombre) {
  const f = POCO_FIABLES[cod];
  return "En " + (nombre || cod) + " el modelo acierta poco más que no saber nada: mejora un +" + f.skill
    + " % medido en " + f.partidos + " partidos (" + f.cuando + "), frente a entre +7.5 y +15.6 % en las demás ligas."
    + " Es de las ligas más igualadas: tómalo con cautela.";
}
function htmlMarcaPocoFiable(cod, nombre) {
  return POCO_FIABLES[cod]
    ? '<span class="poco-fiable" data-tip="' + esc(textoPocoFiable(cod, nombre)) + '" tabindex="0" role="note"'
      + ' aria-label="' + esc("Fiabilidad baja. " + textoPocoFiable(cod, nombre)) + '">' + ICONO_AVISO
      + '<span>fiabilidad baja</span></span>'
    : "";
}
function ligaDe(cod) {
  return LIGAS[cod] || { sigla: (cod || "?").slice(0, 3).toUpperCase(), tono: "var(--tinta-3)", tinta: "var(--oscura)" };
}
function htmlInsignia(cod, clase) {
  const L = ligaDe(cod);
  return '<span class="insignia' + (L.copa ? " copa" : "") + (clase ? " " + clase : "") + '" style="--tono:' + L.tono
    + ";--tono-t:" + L.tinta + '">' + esc(L.sigla) + '</span>';
}

// Escala secuencial de probabilidad: un solo tono ámbar, 8 tramos con
// luminosidad monótona, validada con el script de dataviz. Tinta blanca en los
// tres primeros y oscura en el resto (todas >= 4.8:1). El tramo se decide con el
// entero que se enseña, para que una celda que dice 60 caiga en 60-70.
// op: la opacidad del texto secundario de una casilla (la etiqueta, qué es y la cuota
// justa; 0.8 si no se dice). En los tramos de 30 y de 40 la tinta va entera: con 0.8
// bajaba a 3.8 y 4.0:1, por debajo del 4.5 que pide el texto pequeño (axe, oct 2026).
const RAMPA = [
  { min: 0,  bg: "#594d39", fg: "#ffffff" },
  { min: 20, bg: "#705d3e", fg: "#ffffff" },
  { min: 30, bg: "#876e42", fg: "#ffffff", op: 1 },
  { min: 40, bg: "#a18047", fg: "var(--oscura)", op: 1 },
  { min: 50, bg: "#ba934a", fg: "var(--oscura)" },
  { min: 60, bg: "#d4a64c", fg: "var(--oscura)" },
  { min: 70, bg: "#ebbb4c", fg: "var(--oscura)" },
  { min: 80, bg: "#ffd24c", fg: "var(--oscura)" },
];
function tramo(v) {
  let t = RAMPA[0];
  for (const r of RAMPA) if (v >= r.min) t = r;
  return t;
}
function estiloTramo(v) { const t = tramo(v); return "--bg:" + t.bg + ";--fg:" + t.fg + (t.op ? ";--op:" + t.op : ""); }

// ==========================================
// UTILIDADES
// ==========================================
// Los nombres de equipo vienen de football-data.org, no de nosotros. Todo lo que
// llega de fuera se trata como texto, nunca como HTML.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v) { return String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, c => ESCAPES[c]); }

function normalizar(v) {
  return String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// OJO: new Date("2026-09-06") se interpreta como medianoche UTC y en Lima cae el día
// anterior. Por eso las fechas se parten a mano en todas partes.
function partes(iso) {
  const p = iso.split("-");
  return { a: Number(p[0]), m: Number(p[1]), d: Number(p[2]) };
}
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
                      "septiembre", "octubre", "noviembre", "diciembre"];
function fechaCorta(iso) { const p = partes(iso); return p.d + " " + MESES[p.m - 1]; }
function fechaLarga(iso) { const p = partes(iso); return p.d + " de " + MESES_LARGOS[p.m - 1]; }
// Lun, Mar, Sáb...: con las tarjetas de día estrechas, "Sábado" no cabía y salía "Sába…".
function diaCorto(d) { return d === "Hoy" || d === "Mañana" ? d : d.slice(0, 3); }
// "Sáb 31 oct", o solo "Hoy" / "Mañana", que ya dicen el día (y "Mañana 25 oct" no cabía)
function diaConFecha(p) { return p.dia === "Hoy" || p.dia === "Mañana" ? p.dia : diaCorto(p.dia) + " " + fechaCorta(p.fecha); }
function pct(v) { return Number(v).toFixed(1) + " %"; }

// Hoy en Lima ("2026-10-21"): UTC-5 todo el año, sin horario de verano. Hoy, Mañana
// y el día de la semana se ponen aquí y no se toman del servidor, que los pone en
// cada pasada: tras la medianoche se quedaban viejos hasta la siguiente (~25 min).
function hoyLima() { return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10); }
const NOMBRES_DIA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
function etiquetaDia(fecha, hoy) {
  const p = partes(fecha), h = partes(hoy);
  const dia = Date.UTC(p.a, p.m - 1, p.d);
  const dif = Math.round((dia - Date.UTC(h.a, h.m - 1, h.d)) / 86400000);
  return dif === 0 ? "Hoy" : dif === 1 ? "Mañana" : NOMBRES_DIA[new Date(dia).getUTCDay()];
}
function f2(v) { return Number(v).toFixed(2); }

// Los que ya empezaron se quitan aquí: el servidor los quita en su pasada
// siguiente, hasta 25 minutos después.
function aplanar(dias) {
  const out = [], ahora = Date.now(), hoy = hoyLima();
  (dias || []).forEach(d => d.partidos.forEach(p => {
    if (Date.parse(p.utcDate) <= ahora) return;
    out.push(Object.assign({}, p, { fecha: d.fecha, dia: etiquetaDia(d.fecha, hoy) }));
  }));
  return out;
}

// El orden es el de LIGAS, no el de aparición en los datos: si no, la lista de
// ligas se reordena sola conforme van entrando partidos calculados.
function porLigas(partidos) {
  const m = new Map();
  partidos.forEach(p => {
    const cod = p.liga_codigo || p.liga || "?";
    if (!m.has(cod)) m.set(cod, { codigo: cod, nombre: p.liga, partidos: [] });
    m.get(cod).partidos.push(p);
  });
  const pos = c => { const i = ORDEN_LIGAS.indexOf(c); return i < 0 ? 99 : i; };
  return [...m.values()].sort((a, b) => pos(a.codigo) - pos(b.codigo) || a.nombre.localeCompare(b.nombre));
}

function porDias(partidos) {
  const m = new Map();
  partidos.forEach(p => {
    if (!m.has(p.fecha)) m.set(p.fecha, { fecha: p.fecha, etiqueta: p.dia, partidos: [] });
    m.get(p.fecha).partidos.push(p);
  });
  return [...m.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// Nombre corto y sigla de tres letras: vienen de la API desde que la ficha los
// guarda. Hasta que se recalcula una predicción vieja se sacan del nombre.
const PREFIJOS = /^(?:fc|cf|afc|sc|ac|as|rc|rcd|ogc|ssc|vfb|vfl|tsg|sv|1\.|ca|cd|ud|real|club)\s+/i;
function cortoDe(p, lado) { return p[lado + "_corto"] || p[lado] || "?"; }
function siglaDe(p, lado) {
  if (p[lado + "_sigla"]) return p[lado + "_sigla"];
  const n = cortoDe(p, lado).replace(PREFIJOS, "").replace(/[^A-Za-zÀ-ÿ]/g, "");
  return (n.slice(0, 3) || "?").toUpperCase();
}

function htmlEscudo(url, nombre) {
  const ini = esc((nombre || "?").replace(PREFIJOS, "").charAt(0).toUpperCase());
  if (url && /^https:\/\//.test(url) && !escudosRotos.has(url)) {
    return '<span class="escudo" data-ini="' + ini + '"><img src="' + esc(url)
      + '" alt="" width="24" height="24" loading="lazy" decoding="async"></span>';
  }
  return '<span class="escudo mono" aria-hidden="true">' + ini + '</span>';
}

// ==========================================
// PROBABILIDADES
// ==========================================
function favorito(p) { return Math.max(p.prob_local, p.prob_empate, p.prob_visita); }

/** Los enteros que se enseñan, sumando 100 exacto. Redondear cada uno por su
 *  cuenta da un 54+24+23 = 101 que canta a la vista. Reparto por resto mayor. */
function enterosQueSuman(bruto) {
  const enteros = bruto.map(Math.floor);
  let faltan = 100 - enteros.reduce((a, b) => a + b, 0);
  const porResto = bruto.map((v, i) => ({ i: i, resto: v - Math.floor(v) })).sort((a, b) => b.resto - a.resto);
  for (let k = 0; k < porResto.length && faltan > 0; k++, faltan--) enteros[porResto[k].i]++;
  return enteros;
}
function reparto(p) {
  const e = enterosQueSuman([p.prob_local, p.prob_empate, p.prob_visita]);
  return { l: e[0], x: e[1], v: e[2] };
}
/** Los mercados de goles llegaron después: una predicción guardada antes no los trae. */
function conGoles(p) { return p.prob_mas_25 !== undefined && p.prob_ambos !== undefined; }

function veredictoDe(p) {
  const o = [{ signo: "1", valor: p.prob_local }, { signo: "X", valor: p.prob_empate }, { signo: "2", valor: p.prob_visita }];
  return o.reduce((a, b) => (b.valor > a.valor ? b : a));
}

/** El % del favorito tal como sale en la tabla (del reparto que suma 100), para
 *  que la casilla de los próximos y la de los más claros digan lo mismo. */
function pctFavorito(p) {
  const r = reparto(p), g = veredictoDe(p).signo;
  return g === "1" ? r.l : g === "2" ? r.v : r.x;
}

/** Quién es el favorito, en tres letras: la sigla del equipo o "X" si es el empate. */
function siglaFavorito(p) {
  const g = veredictoDe(p).signo;
  return g === "1" ? siglaDe(p, "local") : g === "2" ? siglaDe(p, "visita") : "X";
}

const ORDENES = {
  hora:    { etiqueta: "Hora",    fn: (a, b) => a.utcDate.localeCompare(b.utcDate) },
  claros:  { etiqueta: "Claros",  fn: (a, b) => favorito(b) - favorito(a) },
  renidos: { etiqueta: "Reñidos", fn: (a, b) => favorito(a) - favorito(b) },
};

function ordenar(lista) {
  if (orden === "hora") return [...lista].sort(ORDENES.hora.fn);
  const con = lista.filter(p => !p.pendiente).sort(ORDENES[orden].fn);
  const sin = lista.filter(p => p.pendiente).sort(ORDENES.hora.fn);
  return [...con, ...sin];
}

// ==========================================
// FILA DE PARTIDO
// ==========================================
const FAV = "\u2605";   // el "código de liga" del grupo Mis equipos
const ESTRELLA = "M8 1.5l1.95 4.1 4.45.55-3.27 3.1.85 4.45L8 11.5l-3.98 2.2.85-4.45L1.6 6.15l4.45-.55z";
const ICONO_ESTRELLA = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="' + ESTRELLA
  + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path></svg>';
const ICONO_ESTRELLA_LLENA = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="' + ESTRELLA
  + '" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path></svg>';
const ICONO_IMAGEN = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="1.6" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="6" cy="6" r="1.3"/>'
  + '<path d="M2.5 12.5 6.5 8.5l3 3 2-2 2.5 2.5"/></svg>';
const ICONO_COMPARTIR = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="1.4"><circle cx="12" cy="3.5" r="2"></circle><circle cx="4" cy="8" r="2"></circle>'
  + '<circle cx="12" cy="12.5" r="2"></circle><path d="M5.8 7l4.4-2.5M5.8 9l4.4 2.5"></path></svg>';
function htmlInsigniaFav(clase) {
  return '<span class="insignia fav' + (clase ? " " + clase : "") + '">' + ICONO_ESTRELLA_LLENA + '</span>';
}
const ICONO_CAMPANA = '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.8A4.2 4.2 0 0 0 3.8 6v2.7L2.4 11.3h11.2l-1.4-2.6V6A4.2 4.2 0 0 0 8 1.8z"/>'
  + '<path d="M6.4 13.2a1.6 1.6 0 0 0 3.2 0" stroke-linecap="round"/></svg>';
const ICONO_AVISO = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path>'
  + '<path d="M8 6v3.4M8 11.6v.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>';

function muestraDe(p) {
  const ml = p.muestra_local === undefined ? 99 : p.muestra_local;
  const mv = p.muestra_visita === undefined ? 99 : p.muestra_visita;
  return { l: ml, v: mv, min: Math.min(ml, mv) };
}

function htmlFila(p, ctx, abierto) {
  const hora = '<span class="c-hora"><span class="hh">' + esc(p.hora) + '</span>'
    + (ctx.conDia ? '<span class="dd">' + esc(diaConFecha(p)) + '</span>' : "")
    + '</span>';
  const liga = '<span class="c-liga">' + htmlInsignia(p.liga_codigo) + '</span>';

  let g = null, r = null;
  if (!p.pendiente) { g = veredictoDe(p).signo; r = reparto(p); }
  const equipo = (lado, signo) => '<span class="c-eq c-' + lado + (g === signo ? " gana" : "") + '">'
    + htmlEscudo(p[lado + "_escudo"], cortoDe(p, lado))
    + '<span class="nom">' + esc(cortoDe(p, lado)) + '</span>'
    + (favoritos.has(p[lado]) ? '<span class="sigo">' + ICONO_ESTRELLA_LLENA + '</span>' : "") + '</span>';

  let celdas, etiqueta;
  if (p.pendiente) {
    celdas = '<span class="c-p c-1 nada">—</span><span class="c-p c-x nada">—</span><span class="c-p c-2 nada">—</span>';
    etiqueta = p.liga + ". " + cortoDe(p, "local") + " contra " + cortoDe(p, "visita") + ", " + p.hora + ". Sin calcular todavía.";
  } else {
    const m = muestraDe(p);
    const ancho = (v) => '<i style="flex:' + v + ';background:' + tramo(v).bg + '"></i>';
    celdas = '<span class="c-p c-1' + (g === "1" ? " gana" : "") + '" style="' + estiloTramo(r.l) + '">' + r.l + '</span>'
      + '<span class="c-p c-x' + (g === "X" ? " gana" : "") + '" style="' + estiloTramo(r.x) + '">' + r.x + '</span>'
      + '<span class="c-p c-2' + (g === "2" ? " gana" : "") + '" style="' + estiloTramo(r.v) + '">' + r.v + '</span>'
      + '<span class="c-d">' + (r.l + r.x) + '</span><span class="c-d">' + (r.x + r.v) + '</span><span class="c-d">' + (r.l + r.v) + '</span>'
      + '<span class="c-xg">' + f2(p.xg_local) + "–" + f2(p.xg_visita) + '</span>'
      + '<span class="c-g">' + (conGoles(p) ? Math.round(p.prob_mas_25) : "—") + '</span>'
      + '<span class="c-g">' + (conGoles(p) ? Math.round(p.prob_ambos) : "—") + '</span>'
      + '<span class="c-m' + (m.min < 4 ? " poca" : "") + '">' + (m.min < 4 ? ICONO_AVISO : "") + (m.min >= 99 ? "—" : m.min) + '</span>'
      + '<span class="c-rep" aria-hidden="true">' + ancho(r.l) + ancho(r.x) + ancho(r.v) + '</span>';
    etiqueta = p.liga + ". " + cortoDe(p, "local") + " contra " + cortoDe(p, "visita") + ", " + p.hora + ". Local " + r.l
      + " %, empate " + r.x + " %, visitante " + r.v + " %."
      + (conGoles(p) ? " Más de 2.5 goles " + Math.round(p.prob_mas_25) + " %, ambos marcan " + Math.round(p.prob_ambos) + " %." : "");
  }

  return '<button class="fila" data-id="' + esc(p.id) + '" aria-expanded="' + (abierto ? "true" : "false")
    + '" aria-label="' + esc(etiqueta) + '">'
    + hora + liga + equipo("local", "1") + equipo("visita", "2") + celdas + '</button>'
    + (abierto && !p.pendiente ? htmlDetalle(p) : "");
}

// El detalle de un partido, de un vistazo: arriba los dos equipos; luego el
// resultado (1X2 repartido, doble oportunidad, goles esperados, porterías a cero y
// cómo gana)
// y los goles (cuántos, más/menos, ambos marcan, marcadores), con los mismos
// enteros que la tabla y la escala oro de la probabilidad; abajo, apagado, cómo se
// calculó. En un panel ancho, resultado y goles van en dos columnas.
function htmlDetalle(p) {
  const m = muestraDe(p);
  const ch = p.champions;
  const vieja = p.calculado && Date.now() - Date.parse(p.calculado) > 26 * 3600000;
  const avisos = (ch ? htmlAvisoChampions(p, m) : htmlAvisoMuestra(m))
    + (POCO_FIABLES[p.liga_codigo] ? '<p class="aviso">' + ICONO_AVISO + '<span>'
      + esc(textoPocoFiable(p.liga_codigo, p.liga)) + '</span></p>' : "")
    + (vieja ? '<p class="aviso">' + ICONO_AVISO + '<span>Calculado ' + esc(haceCuanto(p.calculado))
      + ': la API no responde y estos son los números de entonces.</span></p>' : "");
  const resultado = htmlBloque("Quién gana", htmlQuienGana(p))
    + htmlBloque("Doble oportunidad", htmlDobleOportunidad(p))
    + htmlBloque("Goles esperados", htmlGolesEsperados(p))
    + (conGoles(p) ? htmlBloque("Portería a cero", htmlPorteriaCero(p)) : "")
    + (typeof p.prob_gana2_local === "number" ? htmlBloque("Cómo gana", htmlComoGana(p)) : "");
  const goles = conGoles(p)
    ? htmlBloque("Goles en el partido", htmlGraficoGoles(p), f2(p.goles_total) + " esperados")
      + htmlBloque("Más / menos", htmlMasMenos(p))
      + htmlBloque("Ambos marcan", htmlAmbosMarcan(p))
      + ((p.marcadores || []).length ? htmlBloque("Marcadores más probables", htmlMarcadores(p)) : "")
    : "";
  return '<div class="detalle">' + htmlCabeceraDetalle(p) + htmlVeredicto(p) + avisos + htmlInvitacionAvisos(p)
    + '<div class="det-rejilla' + (goles ? "" : " una") + '"><div class="det-col">' + resultado + '</div>'
    + (goles ? '<div class="det-col">' + goles + '</div>' : "") + '</div>'
    + htmlComoSeCalculo(p, m) + '</div>';
}

// El pronóstico en una frase, arriba del detalle, en "de cada 10" (se entiende
// mejor que un %). Los tramos son los del registro, con el mismo entero que la
// tabla: claro con 60 o más, intermedio de 45 a 59 y parejo por debajo.
function veredictoTexto(p) {
  const n = pctFavorito(p), g = veredictoDe(p).signo;
  const quien = g === "1" ? cortoDe(p, "local") : g === "2" ? cortoDe(p, "visita") : null;
  const de10 = Math.round(n / 10);
  const gana = de10 >= 10 ? "De cada 10 partidos así, los gana casi todos." : "De cada 10 partidos así, gana unos " + de10 + ".";
  if (!quien) return { titulo: "Partido parejo", frase: "Lo más probable es el empate, con " + n + " %." };
  if (n >= 60) return { titulo: "Favorito claro: " + quien, frase: gana };
  if (n >= 45) return { titulo: "Favorito: " + quien, frase: "Sin ser claro. " + gana };
  return { titulo: "Partido parejo", frase: "Nadie llega al 45 %. Lo más probable es que gane " + quien + ", con " + n + " %." };
}
function htmlVeredicto(p) {
  const v = veredictoTexto(p);
  return '<p class="det-veredicto"><b>' + esc(v.titulo) + '.</b> ' + esc(v.frase) + '</p>';
}

// La cuota justa de un %: 100 dividido por él, la que pagaría una apuesta si la
// casa no se quedara margen (las casas pagan menos). Sale del entero que se enseña,
// para que la cuenta cuadre a la vista: 56 % es 1.79.
function cuotaJusta(v) { return v >= 1 ? (100 / v).toFixed(2) : "—"; }
function htmlCuota(v) {
  return '<small class="cuota" title="Cuota justa: 100 / ' + v + '">cuota ' + cuotaJusta(v) + '</small>';
}

function htmlBloque(titulo, cuerpo, meta) {
  // h2, como las cabeceras de grupo: en la búsqueda y en otras listas sin grupos,
  // un h3 seguiría directamente al h1 de la vista (axe: heading-order)
  return '<section class="det-bloque"><h2>' + esc(titulo) + (meta ? ' <small>' + esc(meta) + '</small>' : "") + '</h2>'
    + cuerpo + '</section>';
}

// Los dos equipos frente a frente, cada uno con su estrella para seguirlo, y en
// medio la liga, la hora y Compartir.
function htmlCabeceraDetalle(p) {
  const eq = (lado) => {
    const si = favoritos.has(p[lado]);
    return '<div class="det-eq ' + lado + '">' + htmlEscudo(p[lado + "_escudo"], cortoDe(p, lado))
      + htmlEnlaceEquipo(p[lado + "_id"], esc(p[lado]), "n") + '<span class="rol">' + (lado === "local" ? "Local" : "Visitante") + '</span>'
      + '<button class="accion" data-seguir="' + esc(p[lado]) + '" aria-pressed="' + si + '"'
      + ' aria-label="' + esc((si ? "Dejar de seguir a " : "Seguir a ") + cortoDe(p, lado)) + '">'
      + (si ? ICONO_ESTRELLA_LLENA : ICONO_ESTRELLA) + '<span>' + (si ? "Siguiendo" : "Seguir") + '</span></button></div>';
  };
  return '<div class="det-cab">' + eq("local")
    + '<div class="det-cuando">' + htmlInsignia(p.liga_codigo) + '<span class="hora">' + esc(p.hora) + '</span>'
    + '<span class="dia">' + esc(p.dia) + " " + esc(fechaCorta(p.fecha)) + '</span>'
    + '<button class="accion" data-compartir="' + esc(p.id) + '">' + ICONO_COMPARTIR + '<span>Compartir</span></button>'
    + '<button class="accion" data-imagen="' + esc(p.id) + '" aria-label="Imagen para historias">' + ICONO_IMAGEN
    + '<span>Imagen</span></button></div>'
    + eq("visita") + '</div>';
}

// Una barra repartida en tramos (1X2, más/menos, ambos marcan): cada uno con el
// tono de la escala de su probabilidad y su número dentro si cabe; 2px de aire
// entre tramos. partes: [{ v: entero, nombre }].
function htmlReparto(partes, clase) {
  const etiqueta = partes.map(x => x.nombre + " " + x.v + " %").join(", ");
  return '<div class="reparto' + (clase ? " " + clase : "") + '" role="img" aria-label="' + esc(etiqueta) + '">'
    + partes.map(x => '<i style="flex:' + Math.max(x.v, 1) + ";" + estiloTramo(x.v) + '">'
      + (x.v >= 13 ? '<b>' + x.v + '</b>' : "") + '</i>').join("") + '</div>';
}

function htmlQuienGana(p) {
  const r = reparto(p), g = veredictoDe(p).signo;
  const partes = [
    { v: r.l, nombre: cortoDe(p, "local"), s: "1" },
    { v: r.x, nombre: "Empate", s: "X" },
    { v: r.v, nombre: cortoDe(p, "visita"), s: "2" },
  ];
  return htmlReparto(partes, "grande")
    + '<div class="rep-ley" aria-hidden="true">' + partes.map(x => '<span class="' + (x.s === g ? "fav" : "") + '">'
      + '<span class="nom"><i style="' + estiloTramo(x.v) + '"></i><span class="k">' + esc(x.nombre) + '</span></span>'
      + '<b>' + x.v + ' %</b>' + htmlCuota(x.v) + '</span>').join("") + '</div>';
}

// La doble oportunidad, sumada de los mismos enteros que la tabla.
function htmlDobleOportunidad(p) {
  const r = reparto(p);
  return '<div class="casillas">' + [
    ["1X", r.l + r.x, "Local o empate"],
    ["X2", r.x + r.v, "Empate o visitante"],
    ["12", r.l + r.v, "Sin empate"],
  ].map(c => '<span class="cas" role="group" style="' + estiloTramo(c[1]) + '" aria-label="'
    + esc(c[2] + ": " + c[1] + " %, cuota justa " + cuotaJusta(c[1])) + '">'
    + '<small aria-hidden="true">' + c[0] + '</small><b aria-hidden="true">' + c[1] + '</b>'
    + '<span class="que" aria-hidden="true">' + esc(c[2]) + '</span>'
    + '<span aria-hidden="true">' + htmlCuota(c[1]) + '</span></span>').join("") + '</div>';
}

// Los goles esperados de cada uno, enfrentados desde el centro (no es una
// probabilidad: barras en la tinta del texto, no en oro).
function htmlGolesEsperados(p) {
  const tope = Math.max(3, p.xg_local, p.xg_visita);
  const ancho = (v) => (Math.min(v, tope) / tope * 100).toFixed(1) + "%";
  return '<div class="xg" role="img" aria-label="' + esc("Goles esperados: " + cortoDe(p, "local") + " " + f2(p.xg_local)
      + ", " + cortoDe(p, "visita") + " " + f2(p.xg_visita)) + '">'
    + '<b class="num">' + f2(p.xg_local) + '</b><span class="xg-b izq"><i style="width:' + ancho(p.xg_local) + '"></i></span>'
    + '<span class="xg-b der"><i style="width:' + ancho(p.xg_visita) + '"></i></span><b class="num">' + f2(p.xg_visita) + '</b></div>'
    + '<div class="xg-ley" aria-hidden="true"><span>' + esc(cortoDe(p, "local")) + '</span><span>' + esc(cortoDe(p, "visita")) + '</span></div>';
}

function htmlPorteriaCero(p) {
  return ["local", "visita"].filter(lado => typeof p["prob_cero_" + lado] === "number").map(lado => {
    const v = Math.round(p["prob_cero_" + lado]);
    return '<div class="cero"><span class="k">' + esc(cortoDe(p, lado)) + ' no encaja</span>'
      + '<span class="mini" aria-hidden="true"><i style="width:' + v + '%;' + estiloTramo(v) + '"></i></span>'
      + '<span class="cero-v"><b>' + v + ' %</b>' + htmlCuota(v) + '</span></div>';
  }).join("");
}

// Gana por 2 o más y gana sin recibir gol, de cada equipo: cuatro casillas, las dos
// de arriba por 2 o más. Salen de la rejilla de los goles, no de la del 1X2: nunca
// pasan del entero con que gana en la tabla (en 35.000 partidos de prueba no pasaba
// ni una vez, pero así no se contradicen a la vista).
function htmlComoGana(p) {
  const r = reparto(p);
  const tope = { local: r.l, visita: r.v };
  const cas = (lado, clave, que) => {
    const v = Math.min(Math.round(p[clave + lado]), tope[lado]);
    return '<span class="cas" role="group" style="' + estiloTramo(v) + '" aria-label="'
      + esc(cortoDe(p, lado) + " " + que.toLowerCase() + ": " + v + " %, cuota justa " + cuotaJusta(v)) + '">'
      + '<small aria-hidden="true">' + esc(cortoDe(p, lado)) + '</small><b aria-hidden="true">' + v + '</b>'
      + '<span class="que" aria-hidden="true">' + que + '</span>'
      + '<span aria-hidden="true">' + htmlCuota(v) + '</span></span>';
  };
  return '<div class="casillas dos">'
    + cas("local", "prob_gana2_", "Gana por 2 o más") + cas("visita", "prob_gana2_", "Gana por 2 o más")
    + cas("local", "prob_gana_cero_", "Gana sin recibir gol") + cas("visita", "prob_gana_cero_", "Gana sin recibir gol")
    + '</div>';
}

// "Menos de" es el complemento de "más de", del entero ya redondeado: cada barra suma 100.
function htmlMasMenos(p) {
  return '<div class="lineas"><div class="lin-cab" aria-hidden="true"><span></span><span>más</span><span>menos</span></div>'
    + [["1.5", p.prob_mas_15], ["2.5", p.prob_mas_25], ["3.5", p.prob_mas_35]].filter(l => typeof l[1] === "number").map(l => {
      const mas = Math.round(l[1]);
      return '<div class="lin"><span class="k">' + l[0] + '</span><div>'
        + htmlReparto([{ v: mas, nombre: "Más de " + l[0] }, { v: 100 - mas, nombre: "Menos de " + l[0] }])
        + '<div class="lin-cuotas">' + htmlCuota(mas) + htmlCuota(100 - mas) + '</div></div></div>';
    }).join("") + '</div>';
}

function htmlAmbosMarcan(p) {
  const si = Math.round(p.prob_ambos);
  return htmlReparto([{ v: si, nombre: "Sí" }, { v: 100 - si, nombre: "No" }])
    + '<div class="rep-ley dos" aria-hidden="true"><span><span class="nom"><span class="k">Sí</span></span><b>' + si + ' %</b>'
    + htmlCuota(si) + '</span>'
    + '<span><span class="nom"><span class="k">No</span></span><b>' + (100 - si) + ' %</b>' + htmlCuota(100 - si) + '</span></div>';
}

function htmlMarcadores(p) {
  return '<div class="marcs">' + p.marcadores.map((mk, i) => '<span class="marc' + (i === 0 ? " primero" : "") + '">'
    + '<b>' + mk[0] + "–" + mk[1] + '</b><small>' + Math.round(mk[2]) + ' %</small>' + htmlCuota(Math.round(mk[2]))
    + '</span>').join("") + '</div>';
}

function htmlAvisoMuestra(m) {
  return m.min < 4
    ? '<p class="aviso">' + ICONO_AVISO + '<span>Solo ' + m.min + ' partido' + (m.min === 1 ? "" : "s")
      + ' de liga en la muestra: la estimación tira hacia un equipo medio (o, si acaba de subir, hacia lo'
      + ' habitual de un ascendido).</span></p>'
    : "";
}

/** Lo que no es el pronóstico sino de dónde sale: apagado, al final. */
function htmlComoSeCalculo(p, m) {
  const ch = p.champions;
  const dato = (t, v) => '<div><dt>' + t + '</dt><dd>' + v + '</dd></div>';
  const muestraTxt = (ch ? "En su liga: " : "") + m.l + " partidos del local y " + m.v
    + " del visitante, de esta temporada y la anterior";
  return '<section class="det-datos"><h2>Cómo se calculó</h2><dl>'
    + dato("Muestra", muestraTxt)
    + (p.calculado ? dato("Calculado", esc(haceCuanto(p.calculado))) : "")
    + dato("Cuota justa", "100 dividido por el %: lo que pagaría una apuesta si la casa no se quedara margen."
      + " Las casas pagan menos. Apostar es solo para mayores de 18 años.")
    + (ch ? dato("Nivel de liga", htmlNivelChampions(p)) : "")
    + (ch && ch.local && ch.local.partidos_cl !== undefined ? dato("En la Champions, frente a lo esperado", htmlHistorialChampions(p)) : "")
    + '</dl>' + (ch ? htmlNotaChampions() : "") + (conGoles(p) ? htmlNotaGoles(p) : "") + '</section>';
}

/** De qué liga sale cada equipo de la Champions y con qué nivel. */
function htmlNivelChampions(p) {
  const uno = (lado) => {
    const c = p.champions[lado] || {};
    return '<span class="nw">' + esc(cortoDe(p, lado)) + ": " + (c.liga ? esc(c.nombre_liga) : "otra liga")
      + " ×" + Number(c.factor).toFixed(2) + '</span>';
  };
  return uno("local") + ", " + uno("visita");
}

// Un multiplicador como porcentaje frente a lo esperado: 1.18 -> "+18 %", 0.85 -> "−15 %".
function frenteAEsperado(x) {
  const v = Math.round((Number(x) - 1) * 100);
  return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v) + " %";
}

/** El historial de cada equipo en la Champions (esta temporada y la anterior), uno por línea. */
function htmlHistorialChampions(p) {
  const uno = (lado) => {
    const c = p.champions[lado] || {};
    const n = c.partidos_cl || 0;
    return esc(cortoDe(p, lado)) + ": "
      + (n ? n + " partido" + (n === 1 ? "" : "s") + ', marca <span class="nw">' + frenteAEsperado(c.ataque_cl)
        + '</span> y encaja <span class="nw">' + frenteAEsperado(c.defensa_cl) + '</span>' : "sin partidos");
  };
  return uno("local") + "<br>" + uno("visita");
}

function htmlAvisoChampions(p, m) {
  const sinLiga = ["local", "visita"].filter(l => !(p.champions[l] || {}).liga);
  if (sinLiga.length) {
    const nombres = sinLiga.map(l => cortoDe(p, l)).join(" y ");
    const factor = Number(p.champions[sinLiga[0]].factor).toFixed(2);
    return '<p class="aviso">' + ICONO_AVISO + '<span>' + esc(nombres) + (sinLiga.length > 1 ? " juegan" : " juega")
      + ' en una liga que no está en el plan: sin datos de su liga, cuenta como un equipo medio de nivel ×' + factor
      + ', corregido con lo que haya jugado en la Champions.</span></p>';
  }
  return m.min < 4
    ? '<p class="aviso">' + ICONO_AVISO + '<span>Solo ' + m.min + ' partido' + (m.min === 1 ? "" : "s")
      + ' previo' + (m.min === 1 ? "" : "s") + ' en su liga: la estimación tira hacia la media de esa liga.</span></p>'
    : "";
}

function htmlNotaChampions() {
  return '<p class="nota-goles">En la Champions cada equipo se mide en su liga nacional (su fuerza de liga, '
    + 'atenuada), se ajusta por el nivel de esa liga y se corrige con sus partidos de Champions de esta temporada y '
    + 'la anterior: lo que marcó y encajó frente a lo esperado de un equipo de su liga contra esos mismos rivales. '
    + 'Medido con cuatro Champions (2022/23 a 2025/26, 628 partidos): acierta un 13 % mejor que no saber nada, y el '
    + 'historial suma casi 1 punto a lo que daba la liga sola.</p>';
}

/** Goles totales del partido, 0 a 5+: un histograma de seis barras con su valor
 *  encima. Son seis números y el valor ES el dato, así que van todos rotulados. */
function htmlGraficoGoles(p) {
  const rep = p.goles_reparto || [];
  if (rep.length !== 6) return "";
  const e = enterosQueSuman(rep);
  const max = Math.max(...rep);
  const etiquetas = ["0", "1", "2", "3", "4", "5+"];
  const alto = 56;
  const texto = etiquetas.map((k, i) => k + (k === "1" ? " gol " : " goles ") + e[i] + " %").join(", ");
  return '<div class="goles-graf" role="img" aria-label="' + esc("Goles en el partido: " + texto) + '">'
    + rep.map((v, i) => '<div class="gb' + (v === max ? " max" : "") + '"><span class="v">' + e[i] + '</span>'
      + '<i style="height:' + Math.max(2, Math.round(v / max * alto)) + 'px"></i>'
      + '<span class="k">' + etiquetas[i] + '</span></div>').join("")
    + '</div>';
}

/** Lo que hay que saber de estos números, con la medida de su liga si ya existe. */
function htmlNotaGoles(p) {
  let medida = "";
  const det = validacion && validacion.estado === "listo" ? (validacion.ligas || {})[p.liga_codigo] : null;
  const mk = det && det.mercados;
  if (mk && mk.mas_25 && mk.ambos) {
    const sk = v => (v > 0 ? "+" : "") + v;
    medida = " Medido en " + esc(p.liga) + " (temporada " + esc(det.temporada_evaluada) + "): skill "
      + sk(mk.mas_25.skill_score) + " en más de 2.5 y " + sk(mk.ambos.skill_score)
      + " en ambos marcan, frente a " + sk(det.skill_score) + " en el 1X2.";
  }
  return '<p class="nota-goles">Más/menos, ambos marcan, porterías a cero, cómo gana y marcadores salen de una misma'
    + ' rejilla de marcadores, con el total de goles esperados acercado a la media de la liga y el reparto entre los dos'
    + ' equipos del 1X2: con solo resultados, el modelo exagera cuántos goles habrá, pero no quién los marca. Cuántos'
    + ' goles habrá (más/menos, ambos marcan) apenas se predice mejor que con la media de la liga: tómalo como'
    + ' orientación. Quién gana por 2 o más, o sin recibir gol, se predice casi tan bien como el 1X2.'
    + medida + '</p>';
}

/**
 * Pinta bloques tocando el DOM lo mínimo: cada bloque lleva id y huella, y si la
 * huella no cambió no se toca. Así no parpadea ni se pierde el scroll cuando entra
 * una tanda nueva de resultados.
 */
function pintarBloques(cont, items) {
  const vistos = new Set();
  items.forEach((it, i) => {
    vistos.add(it.id);
    let el = document.getElementById(it.id);
    if (!el) { el = document.createElement("div"); el.id = it.id; }
    if (el.dataset.huella !== it.huella) {
      el.dataset.huella = it.huella;
      el.className = it.clase;
      el.innerHTML = it.html;
    }
    if (cont.children[i] !== el) cont.insertBefore(el, cont.children[i] || null);
  });
  [...cont.children].forEach(el => { if (!vistos.has(el.id)) el.remove(); });
}

function bloquesDePartidos(partidos, ctx) {
  return partidos.map(p => {
    const abierto = abiertos.has(String(p.id));
    return {
      id: "p-" + p.id,
      huella: JSON.stringify(p) + "|" + JSON.stringify(ctx) + "|" + abierto + "|" + escudosRotos.size + "|" + versionFav
        + "|" + versionAvisos,
      clase: "partido" + (p.pendiente ? " pendiente" : ""),
      conDia: !!ctx.conDia,
      html: htmlFila(p, ctx, abierto),
    };
  });
}

function bloqueGrupo(clave, texto, cuenta, codLiga, clase) {
  return {
    id: "g-" + clave,
    huella: texto + "|" + cuenta + "|" + (codLiga || ""),
    clase: "grupo" + (clase ? " " + clase : ""),
    html: '<span class="g-nom" role="heading" aria-level="2">' + (codLiga === FAV ? htmlInsigniaFav() : codLiga ? htmlInsignia(codLiga) : "")
      + '<span class="txt">' + esc(texto) + '</span>'
      + '<span class="cuenta">' + cuenta + " partido" + (cuenta === 1 ? "" : "s") + '</span>'
      + (codLiga && codLiga !== FAV ? htmlMarcaPocoFiable(codLiga, texto) : "") + '</span>'
      + '<span class="g-col">1</span><span class="g-col">X</span><span class="g-col">2</span>',
  };
}

// ==========================================
// RUTAS
//   #/                    el primer día con partidos
//   #/dia/2026-09-12      un día, todas las ligas
//   #/semana              toda la ventana
//   #/liga/PD             una liga entera
//   #/liga/PD/2026-09-12  una liga, un día
//   #/favoritos           los partidos de los equipos que sigues
//   #/equipo/86           la página de un equipo (sección EQUIPO)
// ==========================================
// Un enlace mal escrito (#/liga/%E0) no tiene que tumbar la página.
function decodificar(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function leerRuta() {
  const t = (location.hash || "#/").replace(/^#\/?/, "").split("/").filter(Boolean);
  if (t[0] === "liga" && t[1] && t[2] === "tabla") return { vista: "liga", liga: decodificar(t[1]), fecha: null, tabla: true };
  if (t[0] === "liga" && t[1]) return { vista: "liga", liga: decodificar(t[1]), fecha: t[2] || null };
  if (t[0] === "dia" && t[1]) return { vista: "dia", fecha: t[1] };
  if (t[0] === "semana") return { vista: "semana" };
  if (t[0] === "favoritos") return { vista: "favoritos" };
  if (t[0] === "equipo" && /^\d{1,9}$/.test(t[1] || "")) return { vista: "equipo", id: Number(t[1]) };
  return { vista: "inicio" };
}
// Se pinta en el acto: así quien navega (los más claros, los próximos) encuentra la
// fila ya en el DOM. El hashchange que llega después ve la misma ruta y no reconstruye nada.
function irA(hash) {
  if (location.hash !== hash) location.hash = hash;
  render();
}

function primerDia(todos) { const d = porDias(todos); return d.length ? d[0].fecha : ""; }

// ==========================================
// TABLA Y PROYECCIÓN (#/liga/PD/tabla)
// La clasificación de la liga (football-data) y lo que le falta de temporada, con
// los goles esperados de cada partido según el modelo (/api/tabla/PD, que monta
// worker/tablas.js en los minutos libres del cron; solo en Cloudflare). La
// temporada se simula aquí, en el navegador: SIMULACIONES veces, cada partido con
// dos Poisson de sus goles esperados. De ahí, cuántas veces acaba cada equipo
// campeón, en la zona de arriba o en el descenso, y sus puntos medios. Semilla fija:
// los mismos datos dan los mismos números en cada visita.
// ==========================================
const SIMULACIONES = 4000;
const POR_TANDA = 500;   // simulaciones por tanda: entre tanda y tanda, la página responde
const tablas = new Map();   // código → { doc, etag, pedida, cargando, error, sim, hechas }
const ZONA_CORTA = { "Campeón": "Camp.", "Descenso": "Desc.", "Ascenso directo": "Asc." };
const ICONO_TABLA = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16M9 4v16"/></svg>';

async function cargarTabla(cod) {
  const t = tablas.get(cod) || {};
  tablas.set(cod, t);
  t.cargando = true;
  t.pedida = Date.now();
  try {
    const r = await pedirSiCambio("/api/tabla/" + encodeURIComponent(cod), t.etag);
    if (r.status !== 304) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      t.etag = r.headers.get("ETag");
      t.doc = await r.json();
      t.sim = null;
      t.error = null;
      if (t.doc.estado === "listo") simularPorTandas(cod, t);
    }
  } catch (e) {
    t.error = "No se pudo cargar la tabla. Se reintenta en un rato.";
  }
  t.cargando = false;
  render();
}

// Generador con semilla (mulberry32): rápido y reproducible.
function azar(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function semillaDe(texto) {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) h = Math.imul(h ^ texto.charCodeAt(i), 16777619);
  return h >>> 0;
}
// Las acumuladas de Poisson hasta 10 goles: un sorteo es buscar dónde cae u.
function acumuladaPoisson(lambda) {
  const a = new Float64Array(11);
  let p = Math.exp(-lambda), s = p;
  a[0] = s;
  for (let k = 1; k <= 10; k++) { p *= lambda / k; s += p; a[k] = s; }
  a[10] = 1;
  return a;
}
function sortear(acum, u) { let k = 0; while (u > acum[k]) k++; return k; }

function simularPorTandas(cod, t) {
  const doc = t.doc, eq = doc.equipos, n = eq.length;
  const partidos = doc.restantes.map(([i, j, xl, xv]) => [i, j, acumuladaPoisson(xl), acumuladaPoisson(xv)]);
  const sim = { puestos: eq.map(() => new Float64Array(n)), puntos: new Float64Array(n), hechas: 0,
    rnd: azar(semillaDe(cod + "|" + doc.tabla_actualizada + "|" + doc.restantes_actualizados)) };
  t.sim = sim;
  const pts = new Float64Array(n), dg = new Float64Array(n), gf = new Float64Array(n);
  const orden = eq.map((_, i) => i);
  const tanda = () => {
    if (t.sim !== sim) return;   // llegó una tabla nueva: esta simulación ya no vale
    for (let s = 0; s < POR_TANDA && sim.hechas < SIMULACIONES; s++, sim.hechas++) {
      for (let i = 0; i < n; i++) { pts[i] = eq[i].pts; dg[i] = eq[i].gf - eq[i].gc; gf[i] = eq[i].gf; }
      for (const [i, j, al, av] of partidos) {
        const gl = sortear(al, sim.rnd()), gv = sortear(av, sim.rnd());
        dg[i] += gl - gv; dg[j] += gv - gl; gf[i] += gl; gf[j] += gv;
        if (gl > gv) pts[i] += 3; else if (gl < gv) pts[j] += 3; else { pts[i] += 1; pts[j] += 1; }
      }
      // en empate a puntos, la diferencia de goles y luego los goles a favor
      orden.sort((a, b) => pts[b] - pts[a] || dg[b] - dg[a] || gf[b] - gf[a] || eq[a].pos - eq[b].pos);
      for (let k = 0; k < n; k++) sim.puestos[orden[k]][k] += 1;
      for (let i = 0; i < n; i++) sim.puntos[i] += pts[i];
    }
    if (sim.hechas >= SIMULACIONES && leerRuta().tabla) contar({ t: "tabla", c: cod });
    render();
    if (sim.hechas < SIMULACIONES) setTimeout(tanda, 0);
  };
  setTimeout(tanda, 0);
}

// Una zona ([nombre, desde, hasta], los de abajo en negativo) en puestos 1..n.
function puestosDe(z, n) {
  const p = (v) => (v < 0 ? n + v + 1 : v);
  return [p(z[1]), p(z[2])];
}
function pctZona(sim, i, z, n) {
  const [a, b] = puestosDe(z, n);
  let s = 0;
  for (let k = a - 1; k <= b - 1; k++) s += sim.puestos[i][k];
  return (100 * s) / sim.hechas;
}
function textoPct(v) {
  if (v === 0) return "—";
  if (v < 1) return "<1";
  if (v > 99 && v < 100) return ">99";
  return String(Math.round(v));
}
function celdaPct(v) {
  const txt = textoPct(v);
  return '<td class="tz">' + (txt === "—" ? '<span class="nada">—</span>'
    : '<span class="v" style="' + estiloTramo(Math.round(v)) + '">' + txt + '</span>') + '</td>';
}

function pintarTabla(cod) {
  const t = tablas.get(cod);
  if (!t || (!t.cargando && Date.now() - t.pedida > 10 * 60000)) cargarTabla(cod);
  const html = htmlTabla(cod, t);
  if (vista.dataset.huella === html) return;
  vista.dataset.huella = html;
  vista.innerHTML = html;
}

function htmlTabla(cod, t) {
  const caja = (titulo, texto) => '<div class="vacio"><h2>' + esc(titulo) + '</h2><p>' + esc(texto) + '</p></div>';
  if (!t || (!t.doc && !t.error)) return caja("Cargando la tabla…", "Un momento.");
  if (!t.doc) return caja("Sin tabla por ahora", t.error);
  const doc = t.doc;
  if (doc.estado === "no_disponible") return caja("Sin tabla aquí", "La tabla y la proyección funcionan en la versión de Cloudflare.");
  if (doc.estado !== "listo") return caja("La tabla aún no está", doc.nota || "Vuelve en un rato.");
  const eq = doc.equipos, n = eq.length, sim = t.sim, listo = sim && sim.hechas >= SIMULACIONES;
  const zonas = doc.zonas || [];
  const cab = '<thead><tr><th scope="col" class="pos"><abbr title="Puesto">#</abbr></th><th scope="col" class="eq">Equipo</th>'
    + '<th scope="col" class="n c-pj"><abbr title="Partidos jugados">PJ</abbr></th>'
    + '<th scope="col" class="n c-dg"><abbr title="Diferencia de goles">DG</abbr></th>'
    + '<th scope="col" class="n"><abbr title="Puntos">Pts</abbr></th>'
    + '<th scope="col" class="n proy"><abbr title="Puntos al final de la temporada, de media en las simulaciones">Proy.</abbr></th>'
    + zonas.map(z => '<th scope="col" class="n tz"><abbr title="' + esc("% de las temporadas simuladas en que acaba en " + z[0].toLowerCase()
      + " (puestos " + puestosDe(z, n).join(" a ") + ")") + '"><span class="largo">' + esc(z[0]) + '</span><span class="corto">'
      + esc(ZONA_CORTA[z[0]] || z[0]) + '</span></abbr></th>').join("")
    + '</tr></thead>';
  // una raya bajo el último puesto de cada zona de arriba y sobre el primero de las de abajo
  const rayas = new Set();
  for (const z of zonas.slice(1)) { const [a, b] = puestosDe(z, n); if (a === 1) rayas.add(b); else rayas.add(a - 1); }
  const filas = eq.map((e, i) => {
    const nombre = e.corto || e.nombre;
    return '<tr' + (rayas.has(e.pos) ? ' class="raya"' : "") + '><td class="pos num">' + e.pos + '</td>'
      + '<th scope="row" class="eq"><span class="eq-in">' + htmlEscudo(e.escudo, nombre) + htmlEnlaceEquipo(e.id, esc(nombre), "nom")
      + (favoritos.has(e.nombre) ? '<span class="sigo" role="img" aria-label="Lo sigues">' + ICONO_ESTRELLA_LLENA + '</span>' : "") + '</span></th>'
      + '<td class="n c-pj num">' + e.pj + '</td><td class="n c-dg num">' + (e.gf - e.gc > 0 ? "+" : "") + (e.gf - e.gc) + '</td>'
      + '<td class="n num"><b>' + e.pts + '</b></td>'
      + (listo ? '<td class="n proy num">' + Math.round(sim.puntos[i] / sim.hechas) + '</td>' + zonas.map(z => celdaPct(pctZona(sim, i, z, n))).join("")
        : '<td class="n proy">…</td>' + zonas.map(() => '<td class="tz"><span class="nada">…</span></td>').join(""))
      + '</tr>';
  }).join("");
  const cuando = doc.tabla_actualizada ? "Clasificación de football-data, " + haceCuanto(doc.tabla_actualizada) + "." : "";
  const estado = listo ? "" : '<p class="tabla-sim" role="status">Simulando la temporada… ' + Math.round(100 * (sim ? sim.hechas : 0) / SIMULACIONES) + ' %</p>';
  return '<div class="tabla-vista">' + estado
    // enfocable: sin un solo botón dentro, el teclado no podría desplazar la tabla (axe: scrollable-region-focusable)
    + '<div class="tabla-desliza" tabindex="0" role="region" aria-label="' + esc("Tabla de " + (doc.nombre || cod)) + '">'
    + '<table class="tabla-liga"><caption class="oculto">Tabla de ' + esc(doc.nombre || cod)
    + ' con la proyección de la temporada</caption>' + cab + '<tbody>' + filas + '</tbody></table></div>'
    + '<p class="tabla-nota">' + esc(cuando) + ' Proyección: la temporada que falta (' + doc.restantes.length
    + ' partidos) jugada ' + String(SIMULACIONES).replace(/\B(?=(\d{3})+$)/g, ".") + ' veces, cada partido con los goles esperados del modelo, como los de la semana.'
    + ' En empate a puntos, cuenta la diferencia de goles y después los goles a favor (algunas ligas desempatan antes por los enfrentamientos directos).'
    + ' Cada equipo juega como dicen sus fuerzas de hoy: fichajes, lesiones o un cambio de entrenador tardan en notarse.'
    + (zonas.some(z => z[0] === "Descenso") ? ' Descenso es el directo: el puesto de promoción, donde lo hay, no cuenta.' : "")
    + (POCO_FIABLES[cod] ? " " + esc(textoPocoFiable(cod, doc.nombre)) : "") + '</p></div>';
}

// ==========================================
// EQUIPO (#/equipo/86)
// La página de cada equipo: arriba, su ficha (su puesto, la proyección de la
// temporada con la misma simulación que la tabla de su liga, su forma y su ataque y
// su defensa frente a los de su liga); luego sus próximos partidos, de /api/estado y
// por su nombre, como Mis equipos; y al final lo que dijo la web de sus últimos
// partidos, contra lo que pasó. Lo de la ficha y el final sale de /api/equipo/86
// (worker/equipos.js, solo en Cloudflare): en Render quedan solo sus partidos.
// ==========================================
const equipos = new Map();   // id → { doc, etag, pedida, cargando, error }
const ICONO_FLECHA = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';

async function cargarEquipo(id) {
  const e = equipos.get(id) || {};
  equipos.set(id, e);
  e.cargando = true;
  e.pedida = Date.now();
  try {
    const r = await pedirSiCambio("/api/equipo/" + id, e.etag);
    if (r.status !== 304) {
      // 404: un equipo que no está en ninguna liga ni juega esta semana (lo dice el cuerpo)
      if (!r.ok && r.status !== 404) throw new Error("HTTP " + r.status);
      e.etag = r.headers.get("ETag");
      e.doc = await r.json();
      e.error = null;
    }
  } catch (err) {
    e.error = "No se pudo cargar el equipo. Se reintenta en un rato.";
  }
  e.cargando = false;
  render();
}

// El nombre de un equipo con un enlace a su página (si se sabe su id).
function htmlEnlaceEquipo(id, html, clase) {
  return id ? '<a class="' + clase + '" href="#/equipo/' + Number(id) + '">' + html + '</a>'
    : '<span class="' + clase + '">' + html + '</span>';
}

function signoPct(v) {
  const n = Math.round(v);
  return (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n) + " %";
}

// Su puesto en la proyección: cuántas veces acaba en cada zona de su liga y sus
// puntos medios. La simulación es la de la tabla (tablas, simularPorTandas).
function htmlProyeccion(d) {
  const t = tablas.get(d.liga);
  if (!t || (!t.cargando && Date.now() - t.pedida > 10 * 60000)) cargarTabla(d.liga);
  const doc = t && t.doc && t.doc.estado === "listo" ? t.doc : null;
  const i = doc ? doc.equipos.findIndex(x => x.id === d.id) : -1;
  if (i < 0) return '<p class="nota">La proyección sale en cuanto esté la tabla de su liga.</p>';
  const n = doc.equipos.length, sim = t.sim, listo = sim && sim.hechas >= SIMULACIONES;
  const faltan = doc.restantes.filter(([a, b]) => a === i || b === i).length;
  const casillas = (doc.zonas || []).map(z => {
    const v = listo ? pctZona(sim, i, z, n) : null;
    const txt = v === null ? "…" : textoPct(v);
    const [a, b] = puestosDe(z, n);
    const donde = a === b ? "puesto " + a : "puestos " + a + " a " + b;
    // sin número (aún simulando, o no pasa nunca): gris, con la tinta que aguanta la opacidad de la etiqueta
    const estilo = v === null || txt === "—" ? "--bg:var(--panel-alto);--fg:var(--tinta-2)" : estiloTramo(Math.round(v));
    const etiqueta = z[0] + " (" + donde + "): " + (v === null ? "simulando" : txt === "—" ? "no pasa en ninguna temporada simulada"
      : txt + " % de las temporadas simuladas");
    return '<span class="cas" role="group" style="' + estilo + '" aria-label="' + esc(etiqueta) + '">'
      + '<small aria-hidden="true"><span class="largo">' + esc(z[0]) + '</span><span class="corto">' + esc(ZONA_CORTA[z[0]] || z[0])
      + '</span></small><b aria-hidden="true">' + esc(txt) + '</b>'
      + '<span class="que" aria-hidden="true">' + esc(donde) + '</span></span>';
  }).join("");
  const puntos = listo ? Math.round(sim.puntos[i] / sim.hechas) : null;
  return '<div class="casillas" style="grid-template-columns:repeat(' + (doc.zonas || []).length + ',minmax(0,1fr))">' + casillas + '</div>'
    + '<p class="eq-proy">' + (listo
      ? "Acaba con <b>" + puntos + " puntos</b> de media, con " + faltan + " partido" + (faltan === 1 ? "" : "s") + " por jugar."
      : "Simulando la temporada… " + Math.round(100 * (sim ? sim.hechas : 0) / SIMULACIONES) + " %") + '</p>';
}

// Sus últimos partidos de liga, del más viejo al más nuevo: G, E o P y el marcador.
function htmlFormaEquipo(forma) {
  if (!forma.length) return "";
  const que = { g: ["G", "Ganó"], e: ["E", "Empató"], p: ["P", "Perdió"] };
  return '<ol class="eq-forma" aria-label="Sus últimos partidos de liga, del más antiguo al más reciente">' + forma.map(f => {
    const k = f.gf > f.gc ? "g" : f.gf === f.gc ? "e" : "p";
    const rival = f.rival_corto || f.rival || "su rival";
    const etiqueta = que[k][1] + " " + f.gf + "-" + f.gc + (f.local ? " en casa contra " : " fuera contra ") + rival;
    return '<li class="' + k + '" aria-label="' + esc(etiqueta) + '" title="' + esc(etiqueta) + '"><b aria-hidden="true">'
      + que[k][0] + '</b><span aria-hidden="true">' + f.gf + "-" + f.gc + '</span></li>';
  }).join("") + '</ol>';
}

// Ataque y defensa: 1 es un equipo medio de su liga contra los mismos rivales.
function htmlFuerza(d) {
  const f = d.fuerza;
  const liga = d.liga_nombre || "su liga";
  const fila = (k, v, puesto, texto) => '<div class="eq-fz"><span class="k">' + esc(k) + '</span><b>' + signoPct(v) + '</b>'
    + '<span class="puesto">' + puesto + '.º de ' + f.equipos + '</span><p>' + esc(texto) + '</p></div>';
  const a = (f.ataque - 1) * 100, df = (f.defensa - 1) * 100;
  const cuanto = (v) => Math.abs(Math.round(v)) + " % " + (Math.round(v) >= 0 ? "más" : "menos");
  return '<div class="eq-fuerza">'
    + fila("Marca", a, f.puesto_ataque, Math.round(a) === 0 ? "Lo mismo que un equipo medio de " + liga + " contra las mismas defensas."
      : cuanto(a) + " que un equipo medio de " + liga + " contra las mismas defensas.")
    + fila("Encaja", df, f.puesto_defensa, Math.round(df) === 0 ? "Lo mismo que un equipo medio contra los mismos ataques."
      : cuanto(df) + " que un equipo medio contra los mismos ataques.")
    + '</div><p class="nota">' + (f.partidos
      ? "Con sus " + f.partidos + " partidos de liga de esta temporada y la anterior; los más recientes pesan más. Es lo que usa el modelo."
      : "Recién llegado a la liga: parte de lo que suelen rendir los que llegan, hasta que juegue.") + '</p>';
}

const cuantos = (n, uno, varios) => n + " " + (n === 1 ? uno : varios);

function htmlFichaEquipo(d, nombre, suyo, id) {
  const escudo = d ? d.escudo : suyo && suyo[(suyo.local_id === id ? "local" : "visita") + "_escudo"];
  const sigo = favoritos.has(nombre);
  const corto = (d && d.corto) || nombre;
  const t = d && d.tabla;
  const forma = d ? htmlFormaEquipo(d.forma) : "";
  const cab = '<div class="eq-cab">' + htmlEscudo(escudo, corto)
    + '<div class="eq-que">'
    + (d && d.liga ? '<p class="eq-liga">' + htmlInsignia(d.liga) + '<span>' + esc(d.liga_nombre || d.liga) + '</span></p>' : "")
    + (t ? '<p class="eq-puesto"><b>' + t.pos + '.º</b> de ' + t.equipos + ' · <b>' + cuantos(t.pts, "punto", "puntos") + '</b></p>'
      + '<p class="eq-balance">' + cuantos(t.pj, "jugado", "jugados") + ': ' + cuantos(t.g, "ganado", "ganados") + ', '
      + cuantos(t.e, "empatado", "empatados") + ' y ' + cuantos(t.p, "perdido", "perdidos") + ' · goles ' + t.gf + ':' + t.gc + '</p>' : "")
    + '</div>'
    + (forma ? '<div class="eq-forma-fila"><span class="k">Últimos de liga</span>' + forma + '</div>' : "")
    + '<div class="eq-acciones"><button class="accion" data-seguir="' + esc(nombre) + '" aria-pressed="' + sigo + '"'
    + ' aria-label="' + esc((sigo ? "Dejar de seguir a " : "Seguir a ") + corto) + '">'
    + (sigo ? ICONO_ESTRELLA_LLENA : ICONO_ESTRELLA) + '<span>' + (sigo ? "Siguiendo" : "Seguir") + '</span></button>'
    + '<button class="accion" data-compartir-equipo="' + Number(id) + '">' + ICONO_COMPARTIR + '<span>Compartir</span></button></div></div>';
  if (!d) {
    const e = equipos.get(id);
    const nota = e && e.doc && e.doc.estado === "no_disponible" ? "Su tabla, su fuerza y su historial salen en la versión de Cloudflare."
      : e && e.error ? e.error : "Cargando su tabla y su fuerza…";
    return cab + '<p class="nota">' + esc(nota) + '</p>';
  }
  const tabla = d.tabla ? htmlBloque("En la tabla", htmlProyeccion(d)
      + '<a class="eq-ir" href="#/liga/' + encodeURIComponent(d.liga) + '/tabla">Ver la tabla de ' + esc(d.liga_nombre || d.liga)
      + ICONO_FLECHA + '</a>', "proyección de la temporada")
    : htmlBloque("En la tabla", '<p class="nota">Su liga no está en el plan gratis de football-data: sin tabla ni proyección.</p>');
  const fuerza = d.fuerza ? htmlBloque("Cómo juega", htmlFuerza(d), "frente a su liga") : "";
  return cab + '<div class="det-rejilla' + (fuerza ? "" : " una") + '"><div class="det-col">' + tabla + '</div>'
    + (fuerza ? '<div class="det-col">' + fuerza + '</div>' : "") + '</div>';
}

function htmlWebEquipo(d) {
  const lista = (d && d.ultimos) || [];
  if (!lista.length) {
    return htmlBloque("Lo que dijo la web", '<p class="nota">Todavía no ha terminado ningún partido suyo con el pronóstico'
      + ' publicado antes de empezar. Desde el 18 oct 2026, la web guarda lo que dijo de cada partido.</p>');
  }
  let aciertos = 0;
  const filas = lista.map(p => { const f = htmlFilaResultado(p); if (f.acerto) aciertos++; return f.html; }).join("");
  return htmlBloque("Lo que dijo la web", '<div class="claros" role="list">' + filas + '</div>'
    + '<p class="nota">La casilla es lo que la web le dio, antes del partido, a lo que pasó.</p>',
  "acertó el favorito en " + aciertos + " de " + lista.length);
}

function bloquesEquipo(todos, id) {
  let e = equipos.get(id);
  if (!e || (!e.cargando && Date.now() - e.pedida > 10 * 60000)) { cargarEquipo(id); e = equipos.get(id); }
  const d = e.doc && e.doc.estado === "listo" ? e.doc : null;
  // el nombre: el de su página o, mientras llega (o en Render), el de un partido suyo de la semana
  const suyo = todos.find(p => p.local_id === id || p.visita_id === id);
  const nombre = d ? d.nombre : suyo ? (suyo.local_id === id ? suyo.local : suyo.visita) : null;
  const out = { titulo: nombre || "Equipo", sub: d && d.tabla ? (d.liga_nombre + " · " + d.tabla.pos + ".º") : "",
    mezcla: true, bloques: [] };
  // el título de la pestaña, el mismo que pone el Worker en /equipo/86 (textosEquipo)
  if (nombre) out.pestana = ((d && d.corto) || nombre) + ": próximos partidos y pronóstico · Pronósticos";
  if (!nombre) {
    out.vacio = e.doc && e.doc.estado === "no_encontrado" ? ["No encontramos ese equipo", e.doc.nota]
      : e.error ? ["No se pudo cargar el equipo", e.error] : ["Cargando el equipo…", "Un momento."];
    return out;
  }
  const ficha = htmlFichaEquipo(d, nombre, suyo, id);
  out.bloques.push({ id: "eq-ficha", clase: "detalle eq-ficha", html: ficha,
    huella: ficha + "|" + escudosRotos.size });
  const suyos = todos.filter(p => p.local === nombre || p.visita === nombre);
  out.bloques.push(bloqueGrupo("eq-prox", "Próximos partidos", suyos.length, null, "dia"));
  if (suyos.length) out.bloques.push(...bloquesDePartidos(ordenar(suyos), { conDia: true }));
  else out.bloques.push({ id: "eq-sin", clase: "eq-sin", huella: "sin", html: '<p class="nota">No juega en los próximos días.</p>' });
  if (d || !e.doc || e.doc.estado !== "no_disponible") {
    const web = htmlWebEquipo(d);
    out.bloques.push({ id: "eq-web", clase: "detalle eq-web", html: web, huella: web });
  }
  return out;
}

// Compartir la página del equipo: el menú del sistema, o el enlace al portapapeles.
async function compartirEquipo(id) {
  const e = equipos.get(Number(id));
  const d = e && e.doc && e.doc.estado === "listo" ? e.doc : null;
  const nombre = d ? d.corto || d.nombre : tituloEl.firstChild && tituloEl.firstChild.textContent;
  const url = location.origin + "/equipo/" + Number(id);
  const texto = (nombre ? nombre + ": " : "") + "sus próximos partidos con el pronóstico, su forma y lo que dijo la web.";
  contar({ t: "compartir_equipo", id: Number(id) });
  if (navigator.share) {
    try { await navigator.share({ title: nombre || "Pronósticos", text: texto, url: url }); return; }
    catch (err) { if (err && err.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); avisar("Enlace copiado: pégalo en WhatsApp o donde quieras."); }
  catch (err) { avisar("Copia este enlace: " + url); }
}

// ==========================================
// CONTENIDO DEL CENTRO
// ==========================================
function nombreDia(d) {
  const L = d.etiqueta;
  return (L === "Hoy" || L === "Mañana" ? L + ", " : L + " ") + fechaLarga(d.fecha);
}

function bloquesCentro(todos, ruta) {
  // búsqueda: lista plana por hora, con día y liga en cada fila
  if (busqueda) {
    const q = normalizar(busqueda).trim();
    const hallados = todos.filter(p => [p.local, p.visita, p.local_corto, p.visita_corto]
      .some(n => n && normalizar(n).indexOf(q) >= 0));
    return { titulo: "Búsqueda", sub: hallados.length + " partido" + (hallados.length === 1 ? "" : "s"),
             mezcla: true, bloques: bloquesDePartidos(ordenar(hallados), { conDia: true }),
             vacio: hallados.length ? null : ["Ningún partido de «" + busqueda + "»",
               "Solo se buscan los partidos de la ventana actual. Prueba con otra grafía o con el nombre corto del club."] };
  }

  if (ruta.vista === "equipo") return bloquesEquipo(todos, ruta.id);

  if (ruta.vista === "favoritos") {
    const suyos = todos.filter(esFavorito);
    const out = { titulo: "Mis equipos", sub: suyos.length + " partido" + (suyos.length === 1 ? "" : "s"),
                  mezcla: true, bloques: [] };
    if (!favoritos.size) {
      out.vacio = ["Todavía no sigues a ningún equipo",
        "Abre un partido y toca la estrella de un equipo: sus partidos saldrán aquí y los primeros de cada día."];
      return out;
    }
    const tarjetas = [bloqueAvisos(), bloqueCalendario()].filter(Boolean);
    if (!suyos.length) {
      out.vacio = ["Tus equipos no juegan esta semana", "Sigues a " + [...favoritos].join(", ") + "."];
      out.extra = tarjetas;
      return out;
    }
    out.bloques.push(...tarjetas);
    if (orden !== "hora") { out.bloques.push(...bloquesDePartidos(ordenar(suyos), { conDia: true })); return out; }
    porDias(suyos).forEach(d => {
      out.bloques.push(bloqueGrupo("fav-" + d.fecha, nombreDia(d), d.partidos.length, null, "dia"));
      out.bloques.push.apply(out.bloques, bloquesDePartidos(ordenar(d.partidos), { conDia: false }));
    });
    return out;
  }

  if (ruta.vista === "liga") {
    const suyos = todos.filter(p => (p.liga_codigo || p.liga) === ruta.liga);
    const sel = ruta.fecha ? suyos.filter(p => p.fecha === ruta.fecha) : suyos;
    const nombre = suyos.length ? suyos[0].liga : ruta.liga;
    const out = { titulo: nombre, sub: (ruta.fecha ? fechaLarga(ruta.fecha) : "toda la semana")
      + (POCO_FIABLES[ruta.liga] ? " · fiabilidad baja" : ""), mezcla: false, bloques: [] };
    if (!sel.length) { out.vacio = ["Nada ese día", "Esta liga no juega en la fecha elegida."]; return out; }
    if (orden !== "hora" || ruta.fecha) {
      out.bloques = bloquesDePartidos(ordenar(sel), { conDia: !ruta.fecha });
      return out;
    }
    porDias(sel).forEach(d => {
      out.bloques.push(bloqueGrupo(d.fecha, nombreDia(d), d.partidos.length, null, "dia"));
      out.bloques.push.apply(out.bloques, bloquesDePartidos(ordenar(d.partidos), { conDia: false }));
    });
    return out;
  }

  if (ruta.vista === "semana" || (ruta.vista === "inicio" && mqEscritorio.matches)) {
    const out = { titulo: "Toda la semana", sub: todos.length + " partidos", mezcla: true, bloques: [] };
    if (orden !== "hora") { out.bloques = bloquesDePartidos(ordenar(todos), { conDia: true }); return out; }
    porDias(todos).forEach(d => {
      // los de tus equipos, primero en su día (en la vista de un día van en su grupo)
      const lista = ordenar(d.partidos);
      out.bloques.push(bloqueGrupo(d.fecha, nombreDia(d), d.partidos.length, null, "dia"));
      out.bloques.push.apply(out.bloques, bloquesDePartidos(
        lista.filter(esFavorito).concat(lista.filter(p => !esFavorito(p))), { conDia: false }));
    });
    return out;
  }

  // un día, agrupado por liga en orden fijo
  const fecha = ruta.vista === "dia" ? ruta.fecha : primerDia(todos);
  const delDia = todos.filter(p => p.fecha === fecha);
  const d0 = porDias(delDia)[0];
  const out = { titulo: d0 ? nombreDia(d0) : "Sin partidos", sub: delDia.length + " partidos", mezcla: false, bloques: [] };
  if (!delDia.length) { out.vacio = ["Nada ese día", "No hay partidos programados en esta fecha."]; return out; }
  if (orden !== "hora") {
    out.mezcla = true;
    out.bloques = bloquesDePartidos(ordenar(delDia), { conDia: false });
    return out;
  }
  // los de tus equipos, primero y en su propio grupo (no se repiten en su liga)
  const mios = delDia.filter(esFavorito);
  if (mios.length) {
    out.bloques.push(bloqueGrupo("fav-" + fecha, "Mis equipos", mios.length, FAV, "liga"));
    out.bloques.push.apply(out.bloques, bloquesDePartidos(ordenar(mios), { conDia: false }));
  }
  porLigas(delDia.filter(p => !esFavorito(p))).forEach(L => {
    out.bloques.push(bloqueGrupo(L.codigo + "-" + fecha, L.nombre, L.partidos.length, L.codigo, "liga"));
    out.bloques.push.apply(out.bloques, bloquesDePartidos(ordenar(L.partidos), { conDia: false }));
  });
  return out;
}

// ==========================================
// DÍAS: el único calendario
// ==========================================
function htmlForma(partidos) {
  // una barrita por partido, alto según la fuerza del favorito, de más a menos claro
  const con = partidos.filter(p => !p.pendiente).map(favorito).sort((a, b) => b - a);
  const sin = partidos.length - con.length;
  return '<span class="forma" aria-hidden="true">'
    + con.map(v => '<i style="height:' + Math.max(3, Math.round((v - 30) / 60 * 20)) + 'px;background:'
        + tramo(Math.round(v)).bg + '"></i>').join("")
    + Array(sin).fill('<i style="height:2px;background:var(--linea-viva)"></i>').join("")
    + '</span>';
}

function pintarFechas(todos, ruta) {
  let conjunto = todos, base = "#/dia/", todoHash = "#/semana", todoTexto = "Semana", sel;
  if (ruta.vista === "liga") {
    conjunto = todos.filter(p => (p.liga_codigo || p.liga) === ruta.liga);
    base = "#/liga/" + encodeURIComponent(ruta.liga) + "/";
    todoHash = "#/liga/" + encodeURIComponent(ruta.liga);
    todoTexto = "Todas";
    sel = ruta.tabla ? "tabla" : ruta.fecha || "";
  } else if (ruta.vista === "semana") sel = "";
  else if (ruta.vista === "dia") sel = ruta.fecha;
  else if (ruta.vista === "inicio") sel = mqEscritorio.matches ? "" : primerDia(todos);
  if (busqueda) sel = null;

  const dias = porDias(conjunto);
  const html = '<button class="dia-celda toda" data-hash="' + esc(todoHash) + '" aria-current="' + (sel === "") + '"'
    + ' aria-label="' + esc(todoTexto + ", " + conjunto.length + " partidos en " + dias.length + " días") + '">'
    + '<span class="dow">' + esc(todoTexto) + '</span>'
    + '<span class="cuantos num">' + conjunto.length + '</span>'
    + '<span class="fecha num">' + dias.length + '<small>' + (dias.length === 1 ? "día" : "días") + '</small></span>'
    + htmlForma(conjunto) + '</button>'
    + (ruta.vista === "liga" && LIGAS[ruta.liga] && !LIGAS[ruta.liga].copa
      ? '<button class="dia-celda tabla-celda" data-hash="#/liga/' + esc(encodeURIComponent(ruta.liga)) + '/tabla"'
        + ' aria-current="' + (sel === "tabla") + '" aria-label="Tabla y proyección de la temporada">'
        + '<span class="dow">Tabla</span><span class="fecha">' + ICONO_TABLA + '</span>'
        + '<span class="que">y proyección</span></button>'
      : "")
    + dias.map(d => {
      const p = partes(d.fecha);
      return '<button class="dia-celda" data-hash="' + esc(base + d.fecha) + '" aria-current="' + (sel === d.fecha) + '"'
        + ' aria-label="' + esc(nombreDia(d) + ", " + d.partidos.length + " partidos") + '">'
        + '<span class="dow">' + esc(d.etiqueta === "Hoy" || d.etiqueta === "Mañana" ? d.etiqueta : diaCorto(d.etiqueta)) + '</span>'
        + '<span class="cuantos num">' + d.partidos.length + '</span>'
        + '<span class="fecha num">' + p.d + '<small>' + MESES[p.m - 1] + '</small></span>'
        + htmlForma(d.partidos) + '</button>';
    }).join("");
  if (fechasEl.dataset.huella === html) return;
  fechasEl.dataset.huella = html;
  fechasEl.innerHTML = html;
  const elegido = fechasEl.querySelector('[aria-current="true"]:not(.toda)');
  if (elegido && elegido.dataset.hash !== fechasEl.dataset.elegido) {
    fechasEl.dataset.elegido = elegido.dataset.hash;
    elegido.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function pintarTiraLigas(todos, ruta) {
  const activa = ruta.vista === "liga" ? ruta.liga : ruta.vista === "favoritos" || ruta.vista === "equipo" ? null : "";
  const html = '<button class="sin-insignia" data-liga="" aria-current="' + (activa === "") + '">Todas <span class="n num">' + todos.length + '</span></button>'
    + (favoritos.size ? '<button data-hash="#/favoritos" aria-current="' + (ruta.vista === "favoritos") + '">'
      + htmlInsigniaFav("redonda") + 'Mis equipos <span class="n num">' + todos.filter(esFavorito).length + '</span></button>' : "")
    + porLigas(todos).map(L => '<button data-liga="' + esc(L.codigo) + '" aria-current="' + (activa === L.codigo) + '">'
      + htmlInsignia(L.codigo, "redonda") + esc(L.nombre)
      + ' <span class="n num">' + L.partidos.length + '</span></button>').join("");
  if (tiraLigasEl.dataset.huella === html) return;
  tiraLigasEl.dataset.huella = html;
  tiraLigasEl.innerHTML = html;
}

function pintarOrden() {
  const html = Object.keys(ORDENES).map(k => '<button data-orden="' + k + '" aria-pressed="' + (orden === k) + '">'
    + esc(ORDENES[k].etiqueta) + '</button>').join("");
  if (ordenEl.dataset.huella === html) return;
  ordenEl.dataset.huella = html;
  ordenEl.innerHTML = html;
}

// ==========================================
// TABLERO DE LIGAS
// ==========================================
const MERCADOS_FIAB = {
  "1x2":  { etiqueta: "1X2",   nombre: "1X2" },
  mas_25: { etiqueta: "+2.5",  nombre: "más de 2.5 goles" },
  ambos:  { etiqueta: "Ambos", nombre: "ambos marcan" },
};

const validacionLista = () => !!(validacion && validacion.estado === "listo");
const registroListo = () => !!(registro && registro.estado === "listo" && registro.partidos > 0);

/** Skill y acierto de una liga en el mercado elegido, o null si no se midió.
 *  fuente es la validación o el registro en vivo: los dos tienen la misma forma. */
function medidaFiab(fuente, c, mercado) {
  const det = (fuente.ligas || {})[c] || {};
  if (mercado === "1x2") {
    const r = (fuente.resumen || {})[c];
    if (!r) return null;
    return { skill: r.skill_score, acierto: det.modelo ? det.modelo.acierto : undefined,
             tip: (det.liga || c) + ", 1X2" + (det.partidos ? "\n" + det.partidos + " partidos" : "") };
  }
  const mk = (det.mercados || {})[mercado];
  if (!mk) return null;
  return { skill: mk.skill_score, acierto: mk.modelo.acierto,
           tip: (det.liga || c) + ", " + MERCADOS_FIAB[mercado].nombre + "\nPredicho de media " + Math.round(mk.modelo.predicho)
             + " %, pasó en el " + Math.round(mk.modelo.real) + " %\n" + mk.modelo.n + " partidos" };
}

/** El registro en vivo de cada versión del modelo (registro.versiones, la más nueva
 *  primero): con cada cambio del modelo sus números empiezan de cero, y así se ve si el
 *  de ahora acierta más o menos que el de antes. Con una sola versión no dice nada más. */
function htmlVersionesFiab(mercado) {
  const vs = (registro && registro.versiones) || [];
  if (vs.length < 2) return "";
  return '<div class="fiab-versiones"><p class="fiab-v-cab">Por versión del modelo</p>' + vs.map(v => {
    const m = mercado === "1x2" ? v : (v.mercados || {})[mercado];
    if (!m) return "";
    const ahora = v.version === registro.version_actual;
    const meta = (v.desde_fecha ? "desde el " + fechaCorta(v.desde_fecha) + " · " : "")
      + v.partidos + (v.partidos === 1 ? " partido" : " partidos");
    return '<div class="fiab fiab-v"><span>Modelo ' + esc(String(v.version)) + (ahora ? ' <b>(el de ahora)</b>' : "")
      + '<span class="meta">' + esc(meta) + '</span></span>'
      + '<span class="val">' + (m.skill_score > 0 ? "+" : "") + esc(String(m.skill_score)) + '</span>'
      + '<span class="acierto">' + (m.acierto !== undefined ? Math.round(m.acierto) + " %" : "—") + '</span></div>';
  }).join("") + '</div>';
}

function htmlFiabilidad() {
  const hayVal = validacionLista(), hayReg = registroListo();
  if (!hayVal && !hayReg) {
    return '<section class="modulo m-fiab"><h2>Fiabilidad medida</h2><p class="placeholder">'
      + 'Aún no se ha ejecutado la validación del modelo. Se lanza sola cuando el calendario está completo.</p></section>';
  }
  const enVivo = hayReg && (fuenteFiab === "registro" || !hayVal);
  const fuente = enVivo ? registro : validacion;
  const res = fuente.resumen || {};
  const codigos = ORDEN_LIGAS.filter(c => res[c]).concat(Object.keys(res).filter(c => ORDEN_LIGAS.indexOf(c) < 0));
  if (!codigos.length) return "";
  const segmentos = (aria, opciones) => '<div class="segmentos" role="group" aria-label="' + aria + '">'
    + opciones.map(o => '<button ' + o.attr + ' aria-pressed="' + o.activo + '">' + esc(o.texto) + '</button>').join("") + '</div>';
  const selFuente = hayVal && hayReg ? segmentos("Qué se mide", [
      { attr: 'data-fuente="validacion"', activo: !enVivo, texto: "Temporada " + (validacion.temporada || "") },
      { attr: 'data-fuente="registro"', activo: enVivo, texto: "En vivo" }]) : "";
  const selector = segmentos("Mercado medido", Object.keys(MERCADOS_FIAB).map(k =>
    ({ attr: 'data-mercado="' + k + '"', activo: mercadoFiab === k, texto: MERCADOS_FIAB[k].etiqueta })));
  const medidas = codigos.map(c => ({ c: c, m: medidaFiab(fuente, c, mercadoFiab) })).filter(x => x.m);
  const meta = enVivo ? registro.partidos + (registro.partidos === 1 ? " partido" : " partidos")
    : "temporada " + (validacion.temporada || "");
  const cab = '<section class="modulo m-fiab"><h2>Fiabilidad medida <span class="meta">' + esc(meta) + '</span></h2>'
    + selFuente + selector;
  if (!medidas.length) {
    return cab + '<p class="placeholder">Esta validación no midió ' + esc(MERCADOS_FIAB[mercadoFiab].nombre)
      + '. Se mide en la próxima validación.</p></section>';
  }
  const tope = Math.max(10, ...medidas.map(x => Math.abs(x.m.skill)));
  return cab
    + '<div class="fiab-cab"><span></span><span>Mejora</span><span>Skill</span><span>Acierto</span></div>'
    + medidas.map(x => {
        const m = x.m;
        const acierto = m.acierto !== undefined ? Math.round(m.acierto) + " %" : "—";
        const ancho = Math.abs(m.skill) / tope * 50;
        const barra = m.skill >= 0
          ? '<i style="left:50%;width:' + ancho + '%"></i>'
          : '<i class="neg" style="left:' + (50 - ancho) + '%;width:' + ancho + '%"></i>';
        return '<div class="fiab">' + htmlInsignia(x.c)
          + '<span class="eje" role="img" data-tip="' + esc(m.tip) + '" aria-label="' + esc(m.tip.replace(/\n/g, ". ")) + '">' + barra + '</span>'
          + '<span class="val">' + (m.skill > 0 ? "+" : "") + m.skill + '</span>'
          + '<span class="acierto">' + acierto + '</span></div>';
      }).join("")
    + (enVivo ? htmlVersionesFiab(mercadoFiab) : "")
    + '<p class="nota">' + (enVivo
        ? 'Lo que publicó esta web antes de cada partido, contra el resultado real'
          + (registro.desde_fecha ? ', desde el ' + esc(fechaLarga(registro.desde_fecha)) : "")
          + '. Skill frente a la base "equipo medio". Con pocos partidos por liga es sobre todo ruido: la temporada pasada mide cientos.'
          + ((registro.versiones || []).length > 1 ? ' Cada vez que cambia el modelo, sus números empiezan de cero.' : "")
        : mercadoFiab === "1x2"
        ? 'Skill score: cuánto Brier le quita el modelo a la base "equipo medio". 0 es no aportar nada.'
        : 'Skill score frente a la base "equipo medio" en este mercado. Con solo resultados, los mercados de goles'
          + ' apenas se separan de la media de la liga: un skill cercano a 0 es lo esperable.') + '</p></section>';
}

/** Los últimos partidos terminados del registro en vivo: qué le dio la web,
 *  antes de empezar, a lo que pasó, y si acertó el favorito. */
// Un partido terminado: lo que la web le dio a lo que pasó, el marcador y si acertó
// el favorito (el tablero Resultados y la página de cada equipo).
function htmlFilaResultado(p) {
  const r = reparto(p);
  const paso = p.gl > p.gv ? "1" : p.gl === p.gv ? "X" : "2";
  const n = paso === "1" ? r.l : paso === "2" ? r.v : r.x;
  const fav = veredictoDe(p).signo;
  const acerto = fav === paso;
  const quien = fav === "1" ? cortoDe(p, "local") : fav === "2" ? cortoDe(p, "visita") : "el empate";
  const marcador = cortoDe(p, "local") + " " + p.gl + "–" + p.gv + " " + cortoDe(p, "visita");
  // el veredicto delante: si algo se corta, que sea el nombre
  const detalle = (acerto ? "Acertó" : "Falló") + " el favorito: " + quien;
  const etiqueta = marcador + ". Le dio un " + n + " % a lo que pasó. " + detalle + ". " + p.liga + ", " + fechaCorta(p.fecha);
  // el marcador no se corta nunca: cada nombre se encoge por su cuenta
  return { acerto, html: '<div class="res" role="listitem" aria-label="' + esc(etiqueta) + '">'
    + '<span class="casilla" style="' + estiloTramo(n) + '" aria-hidden="true">' + n + '</span>'
    + '<span class="txt" aria-hidden="true"><span class="quien marcador"><span class="eq">' + esc(cortoDe(p, "local")) + '</span>'
    + '<b>' + p.gl + '–' + p.gv + '</b><span class="eq">' + esc(cortoDe(p, "visita")) + '</span></span>'
    + '<span class="contra">' + esc(detalle) + '</span></span>'
    + '<span class="cuando" aria-hidden="true">' + htmlInsignia(p.liga_codigo) + '<span>' + esc(fechaCorta(p.fecha)) + '</span></span></div>' };
}

function htmlResultados() {
  if (!registroListo() || !(registro.ultimos || []).length) return "";
  const lista = registro.ultimos.slice(0, 8);
  let aciertos = 0;
  const filas = lista.map(p => { const f = htmlFilaResultado(p); if (f.acerto) aciertos++; return f.html; }).join("");
  return '<section class="modulo m-resultados"><h2>Resultados <span class="meta">acertó el favorito en ' + aciertos + ' de ' + lista.length + '</span></h2>'
    + '<div class="claros" role="list">' + filas + '</div>'
    + '<p class="nota">La casilla es lo que la web le dio, antes del partido, a lo que pasó. Liga a liga, en Fiabilidad medida, En vivo.</p></section>';
}

// Los últimos 7 días del registro en vivo: en cuántos acertó el favorito, frente a
// lo que esperaban sus propias probabilidades, por tramo de confianza, y la
// mayor sorpresa. El servidor lo lleva sumado por día (registro.semana).
const TRAMOS_SEMANA = [
  { k: "claros", nombre: "Claros", rango: "60 % o más" },
  { k: "medios", nombre: "Intermedios", rango: "45–60 %" },
  { k: "renidos", nombre: "Reñidos", rango: "menos de 45 %" },
];
function htmlSemana() {
  if (!registroListo() || !(registro.semana || []).length) return "";
  const hoy = hoyLima();
  const desde = new Date(Date.parse(hoy + "T00:00:00Z") - 6 * 86400000).toISOString().slice(0, 10);
  const dias = registro.semana.filter(d => d.fecha >= desde && d.fecha <= hoy);
  const s = { n: 0, ac: 0, esp: 0, tramos: {}, sorpresa: null };
  dias.forEach(d => {
    s.n += d.n; s.ac += d.ac; s.esp += d.esp;
    Object.keys(d.tramos || {}).forEach(k => {
      const t = (s.tramos[k] = s.tramos[k] || [0, 0, 0]);
      d.tramos[k].forEach((v, i) => { t[i] += v; });
    });
    if (d.sorpresa && (!s.sorpresa || favorito(d.sorpresa) > favorito(s.sorpresa))) s.sorpresa = d.sorpresa;
  });
  if (!s.n) return "";
  const porc = (a, b) => Math.round(100 * a / b);
  const filas = TRAMOS_SEMANA.filter(T => s.tramos[T.k]).map(T => {
    const t = s.tramos[T.k], real = porc(t[1], t[0]), esperado = porc(t[2], t[0]);
    const etiqueta = T.nombre + " (" + T.rango + "): acertó " + t[1] + " de " + t[0] + ", el " + real
      + " %; sus probabilidades esperaban el " + esperado + " %";
    return '<div class="sem-fila" role="listitem" aria-label="' + esc(etiqueta) + '">'
      + '<span class="sem-nom" aria-hidden="true">' + esc(T.nombre) + '<small>' + esc(T.rango) + '</small></span>'
      + '<span class="sem-barra" aria-hidden="true"><i style="width:' + real + '%"></i>'
      + '<b style="left:' + esperado + '%"></b></span>'
      + '<span class="sem-val" aria-hidden="true">' + t[1] + '<small> de ' + t[0] + '</small></span></div>';
  }).join("");
  let sorpresa = "";
  const p = s.sorpresa;
  if (p) {
    const g = veredictoDe(p).signo, n = pctFavorito(p);
    const quien = g === "1" ? cortoDe(p, "local") : g === "2" ? cortoDe(p, "visita") : "el empate";
    sorpresa = '<div class="sem-sorpresa"><span class="casilla" style="' + estiloTramo(n) + '" aria-hidden="true">' + n + '</span>'
      + '<span class="txt"><span class="eti">La sorpresa</span><span class="quien marcador"><span class="eq">' + esc(cortoDe(p, "local"))
      + '</span><b>' + p.gl + '–' + p.gv + '</b><span class="eq">' + esc(cortoDe(p, "visita")) + '</span></span>'
      + '<span class="contra">La web daba un ' + n + ' % a ' + esc(quien) + '</span></span>'
      + '<span class="cuando" aria-hidden="true">' + htmlInsignia(p.liga_codigo) + '<span>' + esc(fechaCorta(p.fecha)) + '</span></span></div>';
  }
  return '<section class="modulo m-semana"><h2>Últimos 7 días <span class="meta">' + s.n + ' partido' + (s.n === 1 ? "" : "s") + '</span></h2>'
    + '<p class="sem-cifra"><span class="num">' + porc(s.ac, s.n) + ' %</span><span>acertó el favorito: ' + s.ac + ' de ' + s.n
    + '. Sus probabilidades esperaban el ' + porc(s.esp, s.n) + ' %.</span></p>'
    + '<div class="sem-tramos" role="list">' + filas + '</div>'
    + '<p class="sem-leyenda" aria-hidden="true"><span><i class="real"></i>acertó</span><span><i class="esp"></i>esperado</span></p>'
    + sorpresa
    + '<p class="nota">Lo esperado es lo que decían las propias probabilidades: si están bien medidas, el favorito acierta más o menos eso, ni mucho más ni mucho menos.</p></section>';
}

const ICONO_TODAS = '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect x="2" y="2" width="5" height="5" rx="1.3" fill="currentColor"></rect><rect x="9" y="2" width="5" height="5" rx="1.3" fill="currentColor"></rect>'
  + '<rect x="2" y="9" width="5" height="5" rx="1.3" fill="currentColor"></rect><rect x="9" y="9" width="5" height="5" rx="1.3" fill="currentColor"></rect></svg>';

function pintarLigasPane(todos, ruta) {
  const activa = ruta.vista === "liga" ? ruta.liga : ruta.vista === "favoritos" || ruta.vista === "equipo" ? null : "";
  const mios = todos.filter(esFavorito).length;
  const filaFav = favoritos.size
    ? '<button class="liga-fila" data-hash="#/favoritos" aria-current="' + (ruta.vista === "favoritos") + '">'
      + htmlInsigniaFav("grande") + '<span class="nom">Mis equipos</span>'
      + '<span class="stats">' + favoritos.size + (favoritos.size === 1 ? " equipo" : " equipos") + ' con estrella</span>'
      + '<span class="n">' + mios + '</span></button>'
    : "";
  const ligas = porLigas(todos);
  const filas = ligas.map(L => {
    const i = (infoLigas || {})[L.codigo] || {};
    const stats = (i.media_usada_local
      ? "Goles: " + f2(i.media_usada_local) + " casa, " + f2(i.media_usada_visita) + " fuera" : "")
      + (POCO_FIABLES[L.codigo] ? (i.media_usada_local ? " · " : "") + "fiabilidad baja" : "");
    const jugados = (i.media_usada_local ? "Media de goles que usa el modelo: " + f2(i.media_usada_local) + " del local y "
      + f2(i.media_usada_visita) + " del visitante"
      + (i.partidos_esta_temporada ? ", con " + i.partidos_esta_temporada + " partidos jugados esta temporada" : "") + "." : "")
      + (POCO_FIABLES[L.codigo] ? (i.media_usada_local ? " " : "") + textoPocoFiable(L.codigo, L.nombre) : "");
    return '<button class="liga-fila' + (stats ? "" : " sin-stats") + '" data-liga="' + esc(L.codigo) + '" aria-current="' + (activa === L.codigo) + '">'
      + htmlInsignia(L.codigo, "grande") + '<span class="nom">' + esc(L.nombre) + '</span>'
      + (stats ? '<span class="stats" title="' + esc(jugados) + '">' + esc(stats) + '</span>' : "")
      + '<span class="n">' + L.partidos.length + '</span></button>';
  }).join("");
  const html = '<section class="modulo m-ligas"><h2>Ligas <span class="meta">' + todos.length + ' partidos</span></h2><div class="ligas">'
    + '<button class="liga-fila" data-liga="" aria-current="' + (activa === "") + '">'
    + '<span class="insignia grande todas">' + ICONO_TODAS + '</span><span class="nom">Todas las ligas</span>'
    + '<span class="stats">' + ligas.length + (ligas.length === 1 ? " competición" : " competiciones") + ' esta semana</span>'
    + '<span class="n">' + todos.length + '</span></button>'
    + filaFav + filas + '</div></section>' + htmlFiabilidad()
    + '<p class="pie-izq">Datos de football-data.org · <a href="/privacidad">Privacidad</a></p>';
  if (paneLigas.dataset.huella === html) return;
  paneLigas.dataset.huella = html;
  paneLigas.innerHTML = html;
}

// ==========================================
// TABLERO PANORAMA
// ==========================================
/** Los ocho favoritos más claros de la ventana, de más a menos. */
function htmlClaros(todos) {
  const con = todos.filter(p => !p.pendiente).sort((a, b) => favorito(b) - favorito(a)).slice(0, 8);
  if (!con.length) return "";
  return '<section class="modulo m-claros"><h2>Los más claros <span class="meta">de la semana</span></h2><div class="claros">'
    + con.map(p => {
        const g = veredictoDe(p).signo;
        const n = pctFavorito(p);
        const quien = g === "1" ? cortoDe(p, "local") : g === "2" ? cortoDe(p, "visita") : "Empate";
        const contra = g === "1" ? "en casa contra " + cortoDe(p, "visita")
          : g === "2" ? "fuera, contra " + cortoDe(p, "local")
          : cortoDe(p, "local") + " – " + cortoDe(p, "visita");
        const cuando = (p.dia === "Hoy" || p.dia === "Mañana" ? p.dia : p.dia.slice(0, 3)) + " " + p.hora;
        return '<button class="claro" data-fecha="' + esc(p.fecha) + '" data-id="' + esc(p.id) + '"'
          + ' aria-label="' + esc(quien + " " + n + " %, " + contra + ". " + p.liga + ", " + cuando) + '">'
          + '<span class="casilla" style="' + estiloTramo(n) + '">' + n + '</span>'
          + '<span class="txt"><span class="quien">' + esc(quien) + '</span><span class="contra">' + esc(contra) + '</span></span>'
          + '<span class="cuando">' + htmlInsignia(p.liga_codigo) + '<span>' + esc(cuando) + '</span></span></button>';
      }).join("")
    + '</div></section>';
}

function htmlHistograma(todos) {
  const vals = todos.filter(p => !p.pendiente).map(p => favorito(p));
  if (vals.length < 3) return "";
  // tramos iguales de 5 puntos; el último, abierto
  const bordes = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
  const cuenta = bordes.map(() => 0);
  vals.forEach(v => {
    let i = bordes.length - 1;
    while (i > 0 && v < bordes[i]) i--;
    cuenta[i]++;
  });
  const max = Math.max(...cuenta);
  const iMax = cuenta.indexOf(max);
  const ord = [...vals].sort((a, b) => a - b);
  const mediana = ord.length % 2 ? ord[(ord.length - 1) / 2] : (ord[ord.length / 2 - 1] + ord[ord.length / 2]) / 2;
  const barras = cuenta.map((c, i) => {
    const rango = i === bordes.length - 1 ? bordes[i] + " % o más" : bordes[i] + "–" + bordes[i + 1] + " %";
    const txt = rango + "\n" + c + " partido" + (c === 1 ? "" : "s");
    return '<button class="' + (i === iMax ? "max" : "") + '" data-tip="' + esc(txt) + '" aria-label="' + esc(txt.replace("\n", ": ")) + '">'
      + (i === iMax ? '<span class="etq">' + c + '</span>' : "")
      + '<i style="--bg:' + tramo(bordes[i]).bg + ';height:' + (max ? c / max * 96 : 0) + 'px"></i></button>';
  }).join("");
  const eje = bordes.map((b, i) => '<span>' + (i % 2 === 0 ? (i === bordes.length - 1 ? "80+" : b) : "") + '</span>').join("");
  return '<section class="modulo m-confianza"><h2>Confianza del favorito <span class="meta">mediana ' + Math.round(mediana) + ' %</span></h2>'
    + '<div class="histo">' + barras + '</div><div class="histo-eje" aria-hidden="true">' + eje + '</div>'
    + '<p class="nota">Cuántos partidos tienen un favorito de cada fuerza. A la izquierda, los que son casi una moneda al aire.</p></section>';
}

function pintarPanorama(todos, ruta) {
  const html = htmlClaros(todos) + htmlHistograma(todos) + htmlSemana() + htmlResultados();
  if (panePan.dataset.huella === html) return;
  panePan.dataset.huella = html;
  panePan.innerHTML = html;
}

// ==========================================
// MARCADOR DE PRÓXIMOS
// ==========================================
function cuentaAtras(p) {
  const min = Math.round((Date.parse(p.utcDate) - Date.now()) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return "en " + min + " min";
  if (min < 24 * 60) return "en " + Math.round(min / 60) + " h, " + p.hora;
  return diaCorto(p.dia) + " " + p.hora;
}

function pintarProximos(todos) {
  const ahora = Date.now();
  // los de tus equipos primero; luego, por hora
  const prox = todos.filter(p => Date.parse(p.utcDate) > ahora)
    .sort((a, b) => (esFavorito(b) - esFavorito(a)) || a.utcDate.localeCompare(b.utcDate)).slice(0, 10);
  const html = prox.length ? '<span class="rotulo-cinta">Próximos</span>' + prox.map(p => {
    const n = p.pendiente ? null : pctFavorito(p);
    const fav = p.pendiente
      ? '<span class="p-fav nada" aria-hidden="true">—</span>'
      : '<span class="p-fav" style="' + estiloTramo(n) + '"><span class="s">' + esc(siglaFavorito(p)) + '</span>'
        + '<span class="v num">' + n + '</span></span>';
    const etiqueta = cortoDe(p, "local") + " contra " + cortoDe(p, "visita") + ", " + p.liga + ", " + cuentaAtras(p)
      + (p.pendiente ? ". Sin calcular todavía" : ". Favorito " + (siglaFavorito(p) === "X" ? "el empate" : siglaFavorito(p)) + ", " + n + " %");
    return '<button class="prox" data-fecha="' + esc(p.fecha) + '" data-id="' + esc(p.id) + '" aria-label="' + esc(etiqueta) + '">'
      + '<span class="p-cab">' + htmlInsignia(p.liga_codigo) + '<span>' + esc(cuentaAtras(p)) + '</span>'
      + (esFavorito(p) ? '<span class="sigo">' + ICONO_ESTRELLA_LLENA + '</span>' : "") + '</span>'
      + '<span class="p-eq">' + htmlEscudo(p.local_escudo, cortoDe(p, "local")) + '<span class="nom">' + esc(cortoDe(p, "local")) + '</span></span>'
      + '<span class="p-eq">' + htmlEscudo(p.visita_escudo, cortoDe(p, "visita")) + '<span class="nom">' + esc(cortoDe(p, "visita")) + '</span></span>'
      + fav + '</button>';
  }).join("") : "";
  if (proximosEl.dataset.huella === html) return;
  proximosEl.dataset.huella = html;
  proximosEl.innerHTML = html;
}

// ==========================================
// ESTADO
// ==========================================
function haceCuanto(iso) {
  if (!iso) return "—";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return "hace " + min + " min";
  const h = Math.floor(min / 60);
  return "hace " + h + " h";
}

const ICONO_PAUSA = '<svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1" width="2.5" height="8" fill="currentColor"></rect><rect x="6" y="1" width="2.5" height="8" fill="currentColor"></rect></svg>';

function pintarEstado() {
  const e = datos.estado;
  const total = datos.total || 0, pend = datos.pendientes || 0, hechos = total - pend;
  const modo = e === "actualizando" || e === "sin_datos" ? "trabajando"
    : e === "parcial" ? "pausa" : e === "error" ? "error" : "reposo";
  // actualizando sin ninguno sin números: rehace predicciones caducadas, y mientras
  // tanto se ven las de antes (no hay nada "por calcular")
  const recalculo = e === "actualizando" && total > 0 && !pend;
  const texto = recalculo ? "Actualizando números"
    : { actualizando: "Calculando", parcial: "En pausa", listo: "Al día", error: "Error",
        sin_datos: "Esperando la primera actualización", sin_partidos: "Sin partidos en la ventana" }[e] || e;

  // móvil: un punto y lo esencial
  estadoCorto.dataset.modo = modo;
  estadoCorto.querySelector(".txt").textContent = total && pend ? hechos + "/" + total : recalculo ? "Actualizando" : texto;

  // escritorio: barra de estado a lo editor de código
  let seg = '<span title="' + esc(e === "parcial"
      ? "Se agotó el presupuesto de peticiones de esta pasada; la siguiente sigue por donde se quedó." : texto) + '">'
    + '<span class="punto"></span>' + esc(texto) + (e === "parcial" ? ", faltan " + pend : "") + '</span>';
  if (e === "error") {
    seg += '<span class="err">' + ICONO_AVISO + esc("La última actualización falló: " + (datos.error || "sin detalle")
      + (total ? ". Se ven los números de la pasada anterior." : ".")) + '</span>';
  }
  if (total) {
    seg += '<span><b>' + hechos + '</b> de <b>' + total + '</b> calculados'
      + (pend ? '<span class="medidor"><i style="width:' + (100 * hechos / total) + '%"></i></span>' : "") + '</span>';
  }
  if (typeof datos.requests_gastadas === "number") {
    seg += '<span><b>' + datos.requests_gastadas + '</b> peticiones en la última pasada</span>';
  }
  if (datos.ultima_actualizacion) seg += '<span>Actualizado ' + esc(haceCuanto(datos.ultima_actualizacion)) + '</span>';
  seg += '<span class="der">Datos de football-data.org</span><span><a href="/privacidad">Privacidad</a></span>'
    + '<span><kbd>/</kbd> buscar</span>';
  estadoBarra.dataset.modo = modo;
  if (estadoBarra.dataset.huella !== seg) { estadoBarra.dataset.huella = seg; estadoBarra.innerHTML = seg; }

  // móvil: la pausa y el error necesitan su línea, que no hay barra de estado
  let banda = "";
  if (e === "parcial") {
    banda = ICONO_PAUSA + '<span><b>Faltan ' + pend + ' por calcular.</b> Entran en la próxima pasada.</span>';
  } else if (e === "error" && total) {   // sin ningún partido, el error ya ocupa el centro
    banda = ICONO_AVISO + '<span><b>La última actualización falló.</b> ' + esc(datos.error || "sin detalle") + '. Se ven los números de la pasada anterior.</span>';
  }
  bandaEl.hidden = !banda;
  bandaEl.className = "banda" + (e === "error" ? " error" : "");
  if (bandaEl.dataset.huella !== banda) { bandaEl.dataset.huella = banda; bandaEl.innerHTML = banda; }
}

// ==========================================
// RENDER
// ==========================================
function estadoVacio() {
  // un error antes de tener ningún partido (en Cloudflare, casi siempre un secreto sin poner)
  if (datos.estado === "error") {
    return '<div class="vacio"><h2>No se pudo actualizar</h2><p>' + esc(datos.error || "Sin detalle.") + '</p>'
      + '<p>La página lo vuelve a intentar sola cada pocos minutos.</p></div>';
  }
  const sinDatos = datos.estado === "sin_datos";
  // el mismo HTML lo sirven Render (app.py) y Cloudflare (worker/), que se llenan distinto
  const cloudflare = datos.plataforma === "cloudflare";
  const pasos = cloudflare
    ? '<p>Es la primera vez: la base de datos está vacía y hay que bajarlo todo de football-data.org. Después se guarda y los despliegues ya no la borran.</p>'
      + '<ul class="pasos"><li><b>Ahora</b><span>Un cron de Cloudflare lanza la actualización cada minuto, sin que nadie abra la página.</span></li>'
      + '<li><b>Cada minuto</b><span>Hace como mucho 6 peticiones a la API (el plan gratis da 10 por minuto) y deja el resto para el minuto siguiente.</span></li>'
    : '<p>Cada despliegue en Render borra el disco, así que la caché arranca vacía y la primera pasada tiene que bajarlo todo de nuevo.</p>'
      + '<ul class="pasos"><li><b>Ahora</b><span>El planificador interno lanza la actualización sola, sin esperar al siguiente turno.</span></li>'
      + '<li><b>Cada pasada</b><span>Calcula hasta agotar 40 peticiones a la API y deja el resto para la siguiente.</span></li>';
  return '<div class="vacio"><h2>' + (sinDatos ? "Todavía no hay datos" : "No hay partidos en los próximos días") + '</h2>'
    + (sinDatos
      ? pasos + '<li><b>Esta página</b><span>Se actualiza sola: los partidos aparecen en cuanto haya números.</span></li></ul>'
      : '<p>Ninguna de las ligas juega en la ventana consultada. Es lo normal en parones de selecciones.</p>')
    + '</div>';
}

function render() {
  if (!datos) return;
  pintarEstado();

  if (datos.estado === "sin_datos" || datos.estado === "sin_partidos" || (datos.estado === "error" && !datos.total)) {
    rutaPintada = null;
    app.classList.add("sin-datos");
    tituloEl.innerHTML = "Pronósticos";
    [fechasEl, tiraLigasEl, ordenEl, proximosEl].forEach(el => { el.innerHTML = ""; el.dataset.huella = ""; });
    vista.innerHTML = estadoVacio();
    const ph = (t) => '<section class="modulo"><h2>' + t + '</h2><p class="placeholder">Se rellena con la primera actualización.</p></section>';
    paneLigas.innerHTML = ph("Ligas") + htmlFiabilidad(); paneLigas.dataset.huella = "";
    panePan.innerHTML = ph("Los más claros") + ph("Confianza del favorito"); panePan.dataset.huella = "";
    return;
  }
  app.classList.remove("sin-datos");

  const todos = aplanar(datos.dias);
  let ruta = leerRuta();
  // un enlace guardado a un día que ya pasó lleva a la semana (o a la liga entera),
  // no a "Nada ese día"
  if (ruta.fecha && ruta.fecha < hoyLima()) {
    history.replaceState(null, "", ruta.vista === "liga" ? "#/liga/" + encodeURIComponent(ruta.liga) : "#/");
    ruta = leerRuta();
  }
  const ligaVista = ruta.vista === "liga" ? ruta.liga : null;
  if (ligaVista && ligaVista !== ligaContada) contar({ t: "liga", c: ligaVista });
  ligaContada = ligaVista;
  const equipoVista = ruta.vista === "equipo" ? ruta.id : null;
  if (equipoVista && equipoVista !== equipoContado) contar({ t: "equipo", id: equipoVista });
  if (!equipoVista && equipoContado) document.title = "Pronósticos";   // sale de la página de un equipo
  equipoContado = equipoVista;
  const clave = JSON.stringify(ruta) + "|" + orden + "|" + (busqueda ? "b" : "") + "|" + mqEscritorio.matches;
  const reconstruir = clave !== rutaPintada;
  rutaPintada = clave;
  if (reconstruir) {
    vista.innerHTML = ""; vista.dataset.huella = ""; vista.scrollTop = 0;
    // a la página de un equipo se llega desde el medio de otra (el detalle de un partido, la tabla)
    if (equipoVista) window.scrollTo(0, 0);
  }

  pintarFechas(todos, ruta);
  pintarTiraLigas(todos, ruta);
  pintarOrden();

  const enTabla = ruta.vista === "liga" && ruta.tabla && !busqueda;
  centroEl.classList.toggle("en-tabla", enTabla);
  if (enTabla) {
    const suya = todos.find(p => (p.liga_codigo || p.liga) === ruta.liga);
    const t = tablas.get(ruta.liga);
    const nombre = (t && t.doc && t.doc.nombre) || (suya ? suya.liga : ruta.liga);
    tituloEl.innerHTML = esc(nombre) + '<small>Tabla y proyección</small>';
    centroEl.classList.remove("mezcla", "con-dia");
    limpiarHueco.innerHTML = "";
    pintarTabla(ruta.liga);
    pintarLigasPane(todos, ruta);
    pintarPanorama(todos, ruta);
    pintarProximos(todos);
    return;
  }
  const c = bloquesCentro(todos, ruta);
  tituloEl.innerHTML = esc(c.titulo) + (c.sub ? '<small>' + esc(c.sub) + '</small>' : "");
  if (c.pestana && document.title !== c.pestana) document.title = c.pestana;
  centroEl.classList.toggle("mezcla", !!c.mezcla);
  centroEl.classList.toggle("con-dia", c.bloques.some(b => b.conDia));
  limpiarHueco.innerHTML = busqueda ? '<button class="limpiar" id="limpiar">Limpiar búsqueda</button>' : "";
  if (c.vacio) {
    vista.innerHTML = '<div class="vacio"><h2>' + esc(c.vacio[0]) + '</h2><p>' + esc(c.vacio[1]) + '</p></div>'
      + (c.extra || []).map(x => '<div class="' + x.clase + '">' + x.html + '</div>').join("");
  } else {
    pintarBloques(vista, c.bloques);
  }

  pintarLigasPane(todos, ruta);
  pintarPanorama(todos, ruta);
  pintarProximos(todos);
}

// ==========================================
// INTERACCIÓN
// ==========================================
function ponerPestana(p) {
  app.dataset.pestana = p;
  document.querySelectorAll(".pestanas button").forEach(b => b.setAttribute("aria-current", String(b.dataset.p === p)));
}

function limpiarBusqueda() { busqueda = ""; inputBuscar.value = ""; }

// Un aviso que se va solo (enlace copiado, partido que ya no está).
const avisoEl = $("aviso-flotante");
let quitarAviso = null;
function avisar(texto) {
  avisoEl.textContent = texto;
  avisoEl.hidden = false;
  clearTimeout(quitarAviso);
  quitarAviso = setTimeout(() => { avisoEl.hidden = true; }, 4500);
}

function alternarFavorito(nombre, boton) {
  if (favoritos.has(nombre)) favoritos.delete(nombre);
  else if (favoritos.size < MAX_FAVORITOS) { favoritos.add(nombre); contar({ t: "favorito" }); avisoCuenta(); }
  else { avisar("Ya sigues a " + MAX_FAVORITOS + " equipos: quita alguno antes."); return; }
  guardarFavoritos();
  if (cuenta) encolar(nombre, favoritos.has(nombre));
  versionFav++;
  paneLigas.dataset.huella = "";
  const bloque = boton.closest(".partido");
  const antes = boton.getBoundingClientRect().top;
  render();
  // el partido puede cambiar de grupo (Mis equipos va primero): el botón se queda
  // donde estaba en la pantalla, y con el foco
  const nuevo = bloque && bloque.isConnected
    && [...bloque.querySelectorAll("[data-seguir]")].find(b => b.dataset.seguir === nombre);
  if (!nuevo) return;
  const dy = nuevo.getBoundingClientRect().top - antes;
  const caja = contenedorDeScroll(nuevo);
  if (caja) caja.scrollTop += dy; else window.scrollBy(0, dy);
  nuevo.focus({ preventScroll: true });
}

// Las estrellas que cambió otra pestaña: esta las toma, para no borrarlas al guardar
// las suyas.
window.addEventListener("storage", (e) => {
  if (e.key !== CLAVE_FAVORITOS && e.key !== null) return;
  favoritos.clear();
  leerFavoritos().forEach(n => favoritos.add(n));
  versionFav++;
  paneLigas.dataset.huella = "";
  if (datos) render();
});

// La caja que se desplaza con el elemento dentro (la tabla en escritorio), o null si es la página.
function contenedorDeScroll(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

// En el móvil, el menú de compartir del sistema (WhatsApp, Telegram...); si no
// lo hay, el enlace al portapapeles. La tarjeta con los números la pone el
// Worker en /partido/123.
async function compartir(id) {
  const p = datos && aplanar(datos.dias).find(x => String(x.id) === String(id));
  if (!p) return;
  const url = location.origin + "/partido/" + p.id;
  const r = reparto(p);
  const titulo = cortoDe(p, "local") + " – " + cortoDe(p, "visita");
  // como la tarjeta (compartir.js): el mensaje se lee otro día y quizá en otro país,
  // así que la fecha va escrita y la hora con su zona, no "Mañana 14:00"
  const dia = NOMBRES_DIA[new Date(p.fecha + "T00:00:00Z").getUTCDay()].slice(0, 3).toLowerCase();
  const texto = titulo + ". " + p.liga + " · " + dia + " " + fechaCorta(p.fecha) + ", " + p.hora + " (hora de Lima). "
    + cortoDe(p, "local") + " " + r.l + " % · empate " + r.x + " % · " + cortoDe(p, "visita") + " " + r.v + " %.";
  contar({ t: "compartir", id: Number(p.id) });
  if (navigator.share) {
    try { await navigator.share({ title: titulo, text: texto, url: url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); avisar("Enlace copiado: pégalo en WhatsApp o donde quieras."); }
  catch (e) { avisar("Copia este enlace: " + url); }
}

// La imagen del pronóstico para historias (public/imagen.js, que se carga solo al
// pulsar): con el menú del sistema si deja compartir archivos (Android, iPhone) y
// si no, se descarga. Mismos enteros, tonos y frase que el detalle.
const valorCss = (v, porDefecto) => {
  const m = /^var\((--[\w-]+)\)$/.exec(v || "");
  const r = m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : v;
  return /^#[0-9a-f]{3,8}$/i.test(r || "") ? r : porDefecto;
};
const sinTildes = (s) => normalizar(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
async function imagenPartido(id, boton) {
  const p = datos && aplanar(datos.dias).find(x => String(x.id) === String(id));
  if (!p || p.pendiente) return;
  boton.disabled = true;
  avisar("Preparando la imagen…");
  try {
    const { dibujarImagen } = await import("/imagen.js");
    const r = reparto(p), v = veredictoTexto(p), L = ligaDe(p.liga_codigo);
    const dia = NOMBRES_DIA[new Date(p.fecha + "T00:00:00Z").getUTCDay()].slice(0, 3).toLowerCase();
    const parte = (valor, nombre) => { const t = tramo(valor); return { v: valor, nombre, bg: t.bg, fg: valorCss(t.fg, "#0a120e") }; };
    const marcador = (p.marcadores || [])[0];
    const extras = conGoles(p)
      ? [["Más de 2.5 goles", Math.round(p.prob_mas_25) + " %"], ["Ambos marcan", Math.round(p.prob_ambos) + " %"]]
        .concat(marcador ? [["Marcador", marcador[0] + "–" + marcador[1]]] : [])
      : [["Goles esperados", f2(p.xg_local) + "–" + f2(p.xg_visita)]];
    const blob = await dibujarImagen({
      liga: p.liga, sigla: L.sigla, tono: L.tono === "none" ? "none" : valorCss(L.tono, "#87968c"), tinta: valorCss(L.tinta, "#0a120e"),
      cuando: dia + " " + fechaCorta(p.fecha) + " · " + p.hora + ", hora de Lima",
      local: cortoDe(p, "local"), visita: cortoDe(p, "visita"),
      iniLocal: cortoDe(p, "local").replace(PREFIJOS, "").charAt(0).toUpperCase(),
      iniVisita: cortoDe(p, "visita").replace(PREFIJOS, "").charAt(0).toUpperCase(),
      escudoLocal: p.local_escudo, escudoVisita: p.visita_escudo,
      veredicto: v.titulo, frase: v.frase,
      reparto: [parte(r.l, cortoDe(p, "local")), parte(r.x, "Empate"), parte(r.v, cortoDe(p, "visita"))],
      extras, web: location.host,
    });
    const nombre = "pronostico-" + sinTildes(cortoDe(p, "local")) + "-" + sinTildes(cortoDe(p, "visita")) + ".png";
    const archivo = new File([blob], nombre, { type: "image/png" });
    contar({ t: "imagen", id: Number(p.id) });
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: cortoDe(p, "local") + " – " + cortoDe(p, "visita") }); avisoEl.hidden = true; return; }
      catch (e) { if (e && e.name === "AbortError") { avisoEl.hidden = true; return; } }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    avisar("Imagen descargada: súbela a tus historias.");
  } catch (e) {
    avisar("No se pudo hacer la imagen.");
  } finally {
    boton.disabled = false;
  }
}

// El partido de un enlace /partido/123, cuando ya hay datos.
function abrirEnlazado() {
  const id = Number(partidoEnlazado);
  partidoEnlazado = null;
  const p = aplanar(datos.dias).find(x => Number(x.id) === id);
  history.replaceState(null, "", "/" + (p ? "#/dia/" + p.fecha : "#/"));
  if (p) { ponerPestana("partidos"); abrirPartido(p.fecha, p.id); return; }
  render();
  avisar("Ese partido ya empezó o ya no está entre los de esta semana.");
}

function abrirPartido(fecha, id) {
  limpiarBusqueda();
  if (!abiertos.has(String(id))) contar({ t: "partido", id: Number(id) });
  abiertos.add(String(id));
  ponerPestana("partidos");
  irA("#/dia/" + fecha);
  const el = document.getElementById("p-" + id);
  if (el) { el.scrollIntoView({ block: "center" }); const b = el.querySelector(".fila"); if (b) b.focus({ preventScroll: true }); }
}

// Delegación: un solo listener que sobrevive a cualquier repintado.
document.addEventListener("click", (e) => {
  const t = e.target;
  const pest = t.closest(".pestanas button");
  if (pest) {
    if (app.dataset.pestana !== pest.dataset.p) contar({ t: "pestana", p: pest.dataset.p });
    ponerPestana(pest.dataset.p); window.scrollTo(0, 0); return;
  }
  const seguir = t.closest("[data-seguir]");
  if (seguir) { alternarFavorito(seguir.dataset.seguir, seguir); return; }
  const comp = t.closest("[data-compartir]");
  if (comp) { compartir(comp.dataset.compartir); return; }
  const compEq = t.closest("[data-compartir-equipo]");
  if (compEq) { compartirEquipo(compEq.dataset.compartirEquipo); return; }
  const img = t.closest("[data-imagen]");
  if (img) { imagenPartido(img.dataset.imagen, img); return; }
  const av = t.closest("[data-avisos]");
  if (av) { accionAvisos(av.dataset.avisos); return; }
  const cal = t.closest("[data-calendario]");
  if (cal) { accionCalendario(cal.dataset.calendario); return; }

  const liga = t.closest("[data-liga]");
  if (liga && (liga.classList.contains("liga-fila") || liga.closest(".tira-ligas"))) {
    limpiarBusqueda(); ponerPestana("partidos");
    irA(liga.dataset.liga ? "#/liga/" + encodeURIComponent(liga.dataset.liga) : "#/");
    return;
  }
  const conHash = t.closest("[data-hash]");
  if (conHash) { limpiarBusqueda(); ponerPestana("partidos"); irA(conHash.dataset.hash); return; }

  const ord = t.closest("[data-orden]");
  if (ord) { orden = ord.dataset.orden; rutaPintada = null; render(); return; }

  const merc = t.closest("[data-mercado]");
  if (merc) { mercadoFiab = merc.dataset.mercado; render(); return; }
  const fuente = t.closest("[data-fuente]");
  if (fuente) { fuenteFiab = fuente.dataset.fuente; render(); return; }

  if (t.closest("#limpiar")) { limpiarBusqueda(); rutaPintada = null; render(); inputBuscar.focus(); return; }

  const salto = t.closest(".claro, .prox");
  if (salto) { abrirPartido(salto.dataset.fecha, salto.dataset.id); return; }

  const fila = t.closest(".fila");
  if (fila) {
    const id = fila.dataset.id;
    if (abiertos.has(id)) abiertos.delete(id); else { abiertos.add(id); contar({ t: "partido", id: Number(id) }); }
    render();
  }
});

inputBuscar.addEventListener("input", () => { busqueda = inputBuscar.value.trim() ? inputBuscar.value : ""; rutaPintada = null; render(); });
// "change" salta al salir del buscador: una búsqueda, no una por letra
inputBuscar.addEventListener("change", () => { if (inputBuscar.value.trim()) contar({ t: "busqueda" }); });

// "/" para buscar y Escape para salir, como en los buscadores de código
document.addEventListener("keydown", (e) => {
  const escribiendo = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === "/" && !escribiendo && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); ponerPestana("partidos"); inputBuscar.focus(); inputBuscar.select();
  } else if (e.key === "Escape" && document.activeElement === inputBuscar) {
    limpiarBusqueda(); rutaPintada = null; render(); inputBuscar.blur();
  }
});

// Un escudo que no carga se queda en monograma, y se recuerda para no volver a pedirlo.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName !== "IMG" || !img.parentNode || !img.parentNode.classList.contains("escudo")) return;
  escudosRotos.add(img.getAttribute("src"));
  const s = img.parentNode;
  s.classList.add("mono");
  s.setAttribute("aria-hidden", "true");
  s.textContent = s.dataset.ini || "?";
}, true);

// Tooltip: uno solo, que sigue al foco o al ratón. Lo mismo está siempre en la tabla
// o en la etiqueta accesible: el tooltip ayuda, no esconde nada.
function mostrarTip(el) {
  const txt = el.getAttribute("data-tip");
  if (!txt) return;
  tip.textContent = txt;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  let y = r.top - h - 8;
  if (y < 8) y = r.bottom + 8;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
function ocultarTip() { tip.hidden = true; }
document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (el) mostrarTip(el); else ocultarTip(); });
document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) mostrarTip(el); else ocultarTip(); });
document.addEventListener("scroll", ocultarTip, true);

window.addEventListener("hashchange", () => render());

// La rueda del ratón mueve en horizontal la tira de días y la de próximos: en
// escritorio no siempre caben todos y, sin barra, no había forma de llegar al último.
function ruedaHorizontal(el) {
  el.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
    const antes = el.scrollLeft;
    el.scrollLeft += e.deltaY;
    if (el.scrollLeft !== antes) e.preventDefault();   // en el borde, la página sigue con su scroll
  }, { passive: false });
}
[fechasEl, proximosEl].forEach(ruedaHorizontal);
mqEscritorio.addEventListener("change", () => { rutaPintada = null; render(); });

// ==========================================
// VISITAS
// Cuánta gente entra, si vuelve y qué mira, sin cookies: el navegador solo guarda
// el día de su última visita. Los avisos van a /api/contar (worker/visitas.js), uno
// al entrar y el resto juntos al irse. En Render, /api/contar no hace nada.
// ==========================================
const CLAVE_VISITA = "pronosticos.ultima_visita";
let colaVisitas = [];
function enviarVisitas() {
  colaVisitas.push(...erroresWeb.splice(0));
  if (!colaVisitas.length) return;
  const cuerpo = JSON.stringify(colaVisitas);
  colaVisitas = [];
  try {
    if (navigator.sendBeacon && navigator.sendBeacon("/api/contar", cuerpo)) return;
    fetch("/api/contar", { method: "POST", body: cuerpo, keepalive: true }).catch(() => {});
  } catch (e) { /* sin aviso: la web no lo necesita para nada */ }
}
function contar(evento) {
  colaVisitas.push(evento);
  if (colaVisitas.length >= 20) enviarVisitas();
}
(function entrada() {
  const hoy = hoyLima();
  let ultima = null;
  try { ultima = localStorage.getItem(CLAVE_VISITA); localStorage.setItem(CLAVE_VISITA, hoy); }
  catch (e) { /* sin memoria (modo privado estricto): cuenta como nuevo */ }
  if (ultima && !/^\d{4}-\d{2}-\d{2}$/.test(ultima)) ultima = null;
  const v = !ultima ? "nuevo" : ultima < hoy ? "vuelve" : "repite";
  let o = "";
  try { if (document.referrer) o = new URL(document.referrer).hostname; } catch (e) { /* sin origen: directo */ }
  const ancho = window.innerWidth;
  const ev = { t: "entrada", v, d: ancho >= 1180 ? "escritorio" : ancho >= 880 ? "intermedio" : "movil", o };
  if (enlacePartido) ev.via = "partido";
  else if (enlaceEquipo) ev.via = "equipo";
  if (favoritos.size) ev.f = 1;
  if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) ev.app = 1;
  if (v === "vuelve") ev.hace = Math.round((Date.parse(hoy) - Date.parse(ultima)) / 86400000);
  contar(ev);
  enviarVisitas();
})();
window.addEventListener("pagehide", enviarVisitas);

// ==========================================
// INSTALAR COMO APP
// El manifiesto (manifest.webmanifest) y un service worker que solo dice "sin
// conexión" cuando no hay red (sw.js). Si el navegador ofrece instalarla
// (Chrome, Edge, Android), sale el botón "Instalar app" en la cabecera; en el
// iPhone se instala desde Compartir → "Añadir a pantalla de inicio".
// ==========================================
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
const botonInstalar = $("instalar");
let ofertaInstalar = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  ofertaInstalar = e;
  botonInstalar.hidden = false;
});
botonInstalar.addEventListener("click", async () => {
  if (!ofertaInstalar) return;
  const oferta = ofertaInstalar;
  ofertaInstalar = null;
  botonInstalar.hidden = true;
  try { await oferta.prompt(); } catch (e) { /* el navegador ya no la ofrece */ }
});
window.addEventListener("appinstalled", () => {
  ofertaInstalar = null;
  botonInstalar.hidden = true;
  contar({ t: "instalada" });
  enviarVisitas();
});

// ==========================================
// CUENTA
// Usuario y contraseña, y un correo si la persona quiere (para entrar con él; aún sin
// verificar). La contraseña no sale del navegador tal cual (claveDe). Crear una cuenta
// pasa por Cloudflare Turnstile si el Worker lo tiene puesto (prepararTurnstile). Con
// la sesión abierta (una cookie que esta página no puede leer), los
// equipos de la cuenta son los de este navegador y cada estrella se guarda también en ella
// (worker/cuentas.js), en orden y con reintento (la cola). Solo en Cloudflare: el
// botón sale con plataforma "cloudflare" en /api/estado, y /api/cuenta solo se pide
// si este navegador entró (pronosticos.sesion): sin cuenta no cuesta una petición.
// ==========================================
const botonCuenta = $("boton-cuenta");
const dialogoCuenta = $("dialogo-cuenta");
const dentroCuenta = $("cuenta-dentro");
let cuenta = null;             // { id, usuario, correo, creada, equipos } con la sesión abierta
let vistaCuenta = "crear";     // sin cuenta: crear | entrar; con cuenta: inicio | correo | contrasena | borrar
let ocupado = false, mensajeCuenta = "";
const CLAVE_SESION = "pronosticos.sesion";   // "1" si este navegador entró: las otras pestañas se enteran
const CLAVE_COLA = "pronosticos.cola_cuenta";

function leerLocal(clave, defecto) {
  try { const v = localStorage.getItem(clave); return v === null ? defecto : JSON.parse(v); } catch (e) { return defecto; }
}
function guardarLocal(clave, valor) {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) { /* sin memoria */ }
}

async function pedirCuenta(ruta, cuerpo) {
  let r;
  try {
    r = await fetch("/api/cuenta" + ruta, cuerpo === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  } catch (e) { throw Object.assign(new Error("sin conexión; inténtalo otra vez."), { estado: 0 }); }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && ruta !== "/entrar") ponerCuenta(null);   // la sesión caducó o se cerró en otro aparato
  if (!r.ok) throw Object.assign(new Error(d.error || "no hubo respuesta; inténtalo otra vez."), { estado: r.status });
  return d;
}

// Las estrellas, a la cuenta de una en una y en el orden en que se pusieron (sin
// eso, quitar y poner rápido podía llegar al revés). Si falla la red o el tope del
// día, se quedan en la cola, guardada en el navegador, y se reintentan con la
// siguiente estrella o al volver a abrir la web; lo que el servidor no puede
// aceptar nunca (un equipo de más), se descarta.
let cola = leerLocal(CLAVE_COLA, []);
if (!Array.isArray(cola)) cola = [];
let enviando = null;
function encolar(equipo, seguir) {
  cola.push({ equipo, seguir });
  if (cola.length > 200) cola = cola.slice(-200);
  guardarLocal(CLAVE_COLA, cola);
  return vaciarCola();
}
function vaciarCola() {
  enviando = enviando || (async () => {
    try {
      while (cola.length && cuenta) {
        try { await pedirCuenta("/equipo", cola[0]); }
        catch (e) {
          if (e.estado === 0 || e.estado === 429 || e.estado >= 500) {
            avisar("No se guardó en tu cuenta (" + e.message + ") Se reintenta luego; aquí sí está.");
            return false;
          }
          if (e.estado !== 401) avisar("No se guardó en tu cuenta: " + e.message);
        }
        cola.shift();
        guardarLocal(CLAVE_COLA, cola);
      }
      return true;
    } finally { enviando = null; }
  })();
  return enviando;
}

// La cuenta manda: al entrar (o al cargar con la sesión abierta), sus equipos son
// los de este navegador. Al salir, los de este navegador se quedan.
function ponerCuenta(c) {
  cuenta = c;
  if (!c) { cola = []; guardarLocal(CLAVE_COLA, cola); }
  if (c) {
    favoritos.clear();
    c.equipos.forEach(n => favoritos.add(n));
    guardarFavoritos();
    versionFav++;
    paneLigas.dataset.huella = "";
    if (datos) render();
  }
  try { localStorage.setItem(CLAVE_SESION, c ? "1" : "0"); } catch (e) { /* sin memoria */ }
  botonCuenta.toggleAttribute("data-con", !!c);
  botonCuenta.querySelector(".txt").textContent = c ? "Mi cuenta" : "Entrar";
  botonCuenta.setAttribute("aria-label", c ? "Mi cuenta" : "Entrar: guarda tus equipos");
}

async function cargarCuenta() {
  if (leerLocal(CLAVE_SESION, 0) !== 1) return;   // este navegador no entró: nada que pedir
  try {
    const r = await fetch("/api/cuenta");
    if (!r.ok) return;
    let d = await r.json();
    if (!d.disponible) return;
    botonCuenta.hidden = false;
    // lo que quedó sin guardar va antes de traer la lista de la cuenta; si sigue sin
    // poder guardarse, manda lo de este navegador
    if (d.cuenta && cola.length) {
      cuenta = d.cuenta;
      if (!(await vaciarCola())) { ponerCuenta({ ...d.cuenta, equipos: [...favoritos] }); return; }
      d = await (await fetch("/api/cuenta")).json();
    }
    ponerCuenta(d.cuenta);
  } catch (e) { /* sin cuenta: las estrellas siguen en el navegador */ }
}

// La primera estrella sin cuenta: dónde se guarda y cómo llevarla a otros aparatos.
function avisoCuenta() {
  if (cuenta || botonCuenta.hidden) return;
  try {
    if (localStorage.getItem("pronosticos.aviso_cuenta")) return;
    localStorage.setItem("pronosticos.aviso_cuenta", "1");
  } catch (e) { return; }
  avisar("Guardado en este navegador. Para tenerlo en todos tus aparatos, crea una cuenta en «Entrar».");
}

const fechaDe = (iso) => fechaLarga(new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10));
const plural = (n, uno, varios) => n + " " + (n === 1 ? uno : varios);

// La contraseña no sale del navegador: se manda PBKDF2-SHA256 de ella con el usuario
// como sal (y, si la cuenta tiene correo, otra vez con el correo de sal, para entrar
// con él), y worker/cuentas.js guarda el SHA-256 de eso con una sal suya. Las 600.000
// vueltas hacen lento probar contraseñas aunque alguien leyera la base, y en el
// navegador cuestan medio segundo. Si algún día cambia ITERACIONES, las contraseñas
// guardadas dejan de valer.
const ITERACIONES = 600000;
async function claveDe(nombre, contrasena) {   // nombre: el usuario o el correo
  const t = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", t.encode(contrasena.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256",
    salt: t.encode("pronosticos-bot/" + nombre), iterations: ITERACIONES }, base, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Las mismas reglas que el Worker (normalizarUsuario), para avisar antes de mandar.
function normalizarUsuario(texto) {
  const u = String(texto || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,23}$/.test(u) ? u : null;
}
const TEXTO_USUARIO = "El usuario lleva de 3 a 24 letras (sin tildes ni ñ), números, punto, guion o guion bajo,"
  + " y empieza por letra o número.";
function normalizarCorreo(texto) {   // igual que en el Worker
  const c = String(texto || "").trim().toLowerCase();
  return c.length <= 254 && /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(c) ? c : null;
}
const TEXTO_CORREO = "Ese correo no parece bien escrito.";
const MUY_COMUNES = new Set(["12345678", "123456789", "1234567890", "87654321", "11111111", "00000000", "12341234",
  "password", "password1", "contraseña", "contrasena", "qwerty123", "qwertyui", "abc12345", "iloveyou", "futbol123"]);
function problemaContrasena(contrasena, repetida, usuario) {
  if (contrasena.length < 8) return "La contraseña tiene que tener al menos 8 caracteres.";
  if (contrasena.length > 128) return "La contraseña puede tener 128 caracteres como mucho.";
  if (contrasena.toLowerCase() === usuario || MUY_COMUNES.has(contrasena.toLowerCase())) {
    return "Esa contraseña es muy fácil de adivinar: elige otra.";
  }
  if (contrasena !== repetida) return "Las dos contraseñas no son iguales.";
  return null;
}

const campo = (nombre, etiqueta, tipo, auto, extra, ayuda) => '<label class="campo"><span>' + etiqueta + '</span>'
  + '<input name="' + nombre + '" type="' + tipo + '" autocomplete="' + auto + '"' + (extra || "") + '>'
  + (ayuda ? '<small>' + ayuda + '</small>' : "") + '</label>';
const CAMPO_USUARIO = (auto) => campo("usuario", "Usuario", "text", auto || "username",
  ' autocapitalize="none" spellcheck="false" maxlength="24"');
const CAMPO_CORREO = (etiqueta, valor, ayuda) => campo("correo", etiqueta, "email", "email",
  ' autocapitalize="none" spellcheck="false" maxlength="254"' + (valor ? ' value="' + esc(valor) + '"' : ""), ayuda);
const AYUDA_CORREO = "Para entrar también con él y, más adelante, recuperar la contraseña. Por ahora no te mandamos nada.";
const ERROR_CUENTA = '<p class="error" role="alert" hidden></p>';
// La política de privacidad (public/privacidad.html), enlazada donde se guarda algo.
const ENLACE_PRIVACIDAD = '<a class="privacidad" href="/privacidad">Qué se guarda</a>';
const NOTA_DATOS = '<p class="nota">Qué guardamos: tu usuario, tu contraseña cifrada (tu navegador la cifra antes de'
  + ' enviarla), tu correo si lo pones y los equipos que sigues. Ni nombre ni IP. Puedes borrarlo todo cuando quieras.'
  + ' <a href="/privacidad">Política de privacidad</a>.</p>';
// crear: con correo (opcional) y el recuadro de Turnstile; usuario: la cuenta de la primera versión
const FORM_USUARIO = (form, boton) => '<form data-cuenta-form="' + form + '" novalidate>'
  + CAMPO_USUARIO() + (form === "crear" ? CAMPO_CORREO("Correo (opcional)", "", AYUDA_CORREO) : "")
  + campo("contrasena", "Contraseña", "password", "new-password", ' maxlength="128"')
  + campo("repetida", "Repite la contraseña", "password", "new-password", ' maxlength="128"')
  + (form === "crear" ? '<div class="turnstile" hidden></div>' : "")
  + ERROR_CUENTA + '<button class="accion principal" type="submit">' + boton + '</button></form>';

function htmlCuenta() {
  if (!cuenta && !["crear", "entrar"].includes(vistaCuenta)) vistaCuenta = "entrar";   // la sesión se cerró por el camino
  if (cuenta && ["crear", "entrar"].includes(vistaCuenta)) vistaCuenta = "inicio";
  const n = favoritos.size;
  if (vistaCuenta === "entrar") {
    return '<h2 id="cuenta-titulo">Entra en tu cuenta</h2>'
      + '<form data-cuenta-form="entrar" novalidate>'
      + campo("usuario", "Usuario o correo", "text", "username", ' autocapitalize="none" spellcheck="false" maxlength="254"')
      + campo("contrasena", "Contraseña", "password", "current-password", ' maxlength="128"')
      + ERROR_CUENTA + '<button class="accion principal" type="submit">Entrar</button></form>'
      + '<div class="bloque"><h3>¿No tienes cuenta?</h3>'
      + '<button class="accion" type="button" data-cuenta="ir-crear">Crear una cuenta</button></div>';
  }
  if (vistaCuenta === "crear") {
    return '<h2 id="cuenta-titulo">Guarda tus equipos</h2>'
      + '<p>' + (n === 1 ? 'El equipo que sigues se guarda' : n ? 'Los ' + n + ' equipos que sigues se guardan'
        : 'Los equipos que sigas se guardan')
      + ' <strong>solo en este navegador</strong>. Con una cuenta se guardan en la web y los ves en cualquier aparato'
      + ' donde entres con tu usuario y contraseña.</p>'
      + FORM_USUARIO("crear", "Crear mi cuenta")
      + '<p class="nota">Si olvidas la contraseña, por ahora no se puede recuperar (tampoco con el correo): solo cambiarla'
      + ' desde un aparato donde ya hayas entrado.</p>'
      + '<div class="bloque"><h3>¿Ya tienes cuenta?</h3>'
      + '<button class="accion" type="button" data-cuenta="ir-entrar">Entrar con mi usuario o correo</button></div>' + NOTA_DATOS;
  }
  if (vistaCuenta === "correo") {
    return '<h2 id="cuenta-titulo">' + (cuenta.correo ? 'Cambiar el correo' : 'Añadir un correo') + '</h2>'
      + '<form data-cuenta-form="correo" novalidate>'
      + '<input name="usuario" type="text" autocomplete="username" value="' + esc(cuenta.usuario) + '" hidden>'
      + CAMPO_CORREO("Correo", cuenta.correo, cuenta.correo ? "Déjalo vacío para quitarlo." : "")
      + campo("actual", "Tu contraseña", "password", "current-password", ' maxlength="128"')
      + ERROR_CUENTA + '<button class="accion principal" type="submit">Guardar</button>'
      + '<button class="accion" type="button" data-cuenta="inicio">Cancelar</button></form>'
      + '<p class="nota">' + AYUDA_CORREO + '</p>';
  }
  if (vistaCuenta === "contrasena") {
    return '<h2 id="cuenta-titulo">Cambiar la contraseña</h2>'
      + '<form data-cuenta-form="contrasena" novalidate>'
      + '<input name="usuario" type="text" autocomplete="username" value="' + esc(cuenta.usuario) + '" hidden>'
      + campo("actual", "Contraseña actual", "password", "current-password", ' maxlength="128"')
      + campo("contrasena", "Contraseña nueva", "password", "new-password", ' maxlength="128"')
      + campo("repetida", "Repite la nueva", "password", "new-password", ' maxlength="128"')
      + ERROR_CUENTA + '<button class="accion principal" type="submit">Cambiar la contraseña</button>'
      + '<button class="accion" type="button" data-cuenta="inicio">Cancelar</button></form>'
      + '<p class="nota">Las sesiones de tus otros aparatos se cierran; en este sigues dentro.</p>';
  }
  if (vistaCuenta === "borrar") {
    return '<h2 id="cuenta-titulo">¿Borrar tu cuenta?</h2>'
      + '<p>Se borran la cuenta' + (cuenta.usuario ? ' <strong>' + esc(cuenta.usuario) + '</strong>' : '')
      + ', sus sesiones y ' + plural(n, "equipo guardado", "equipos guardados")
      + '. No se puede deshacer. Los equipos que ves en este navegador se quedan aquí.</p>' + ERROR_CUENTA
      + '<div class="acciones"><button class="accion borrar principal" type="button" data-cuenta="borrar-si">Sí, borrar mi cuenta</button>'
      + '<button class="accion" type="button" data-cuenta="inicio">Cancelar</button></div>';
  }
  return '<h2 id="cuenta-titulo">Mi cuenta</h2>'
    + (mensajeCuenta ? '<p class="mensaje" role="status">' + esc(mensajeCuenta) + '</p>' : "")
    + '<dl class="ficha-cuenta"><dt>Usuario</dt><dd>' + (cuenta.usuario ? esc(cuenta.usuario) : "sin usuario") + '</dd>'
    + (cuenta.usuario ? '<dt>Correo</dt><dd>' + (cuenta.correo ? esc(cuenta.correo) + ' <span class="apagado">(sin verificar)</span>'
      : '<span class="apagado">sin correo</span>') + '</dd>' : "")
    + '<dt>ID de cuenta</dt><dd class="id">' + esc(cuenta.id) + '</dd>'
    + '<dt>Creada</dt><dd>' + esc(fechaDe(cuenta.creada)) + '</dd></dl>'
    + (cuenta.usuario ? "" : '<div class="bloque"><h3>Ponle usuario y contraseña</h3><p class="nota">Tu cuenta es de la primera'
      + ' versión, que se entraba con un código. Con usuario y contraseña entras desde cualquier aparato; el código deja de valer.</p>'
      + FORM_USUARIO("usuario", "Guardar usuario y contraseña") + '</div>')
    + '<p>' + (n ? 'Sigues a ' + plural(n, "equipo", "equipos") + ', guardados en tu cuenta.'
      : 'Aún no sigues a ningún equipo: abre un partido y pulsa «Seguir».') + '</p>'
    + (n ? '<ul class="equipos">' + [...favoritos].map(e => '<li>' + esc(e) + '</li>').join("") + '</ul>' : "")
    + '<p class="error error-general" role="alert" hidden></p>'
    + (cuenta.usuario ? '<div class="bloque"><h3>Tu correo y tu contraseña</h3><div class="acciones">'
      + '<button class="accion" type="button" data-cuenta="ir-correo">' + (cuenta.correo ? 'Cambiar o quitar el correo'
        : 'Añadir un correo') + '</button>'
      + '<button class="accion" type="button" data-cuenta="ir-contrasena">Cambiar la contraseña</button></div></div>' : "")
    + '<div class="bloque"><h3>Tus datos</h3><div class="acciones">'
    + '<a class="accion" href="/api/cuenta/datos" download="pronosticos-mi-cuenta.json">Descargar mis datos</a>'
    + '<button class="accion" type="button" data-cuenta="salir">Cerrar sesión en este aparato</button>'
    + '<button class="accion" type="button" data-cuenta="salir-todas">Cerrar sesión en todos</button>'
    + '<button class="accion borrar" type="button" data-cuenta="pedir-borrar">Borrar mi cuenta</button></div></div>'
    + NOTA_DATOS;
}

function pintarCuenta(vista) {
  if (vista) vistaCuenta = vista;
  quitarTurnstile();
  dentroCuenta.innerHTML = htmlCuenta();
  const foco = dentroCuenta.querySelector("input:not([hidden]), .accion.principal, .accion");
  if (foco) foco.focus();
  if (vistaCuenta === "crear") prepararTurnstile();
}

function abrirCuenta() {
  mensajeCuenta = "";
  pintarCuenta(cuenta ? "inicio" : "crear");
  if (!dialogoCuenta.open) dialogoCuenta.showModal();
}

// Cloudflare Turnstile en "Crear cuenta": la clave pública la da GET /api/cuenta (null si
// el Worker no lo tiene puesto) y su script se carga solo al llegar aquí. La ficha vale
// una vez: tras cada intento de crear, el recuadro se rehace. Esa misma petición sirve
// para recuperar una sesión que este navegador olvidó (pronosticos.sesion borrado).
let sitioTurnstile;            // undefined: sin preguntar; null: sin Turnstile
let widgetTurnstile = null, fichaTurnstile = "", cargaTurnstile = null;
function scriptTurnstile() {
  cargaTurnstile = cargaTurnstile || new Promise((listo, fallo) => {
    const js = document.createElement("script");
    js.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    js.async = true;
    js.onload = listo;
    js.onerror = () => { cargaTurnstile = null; fallo(new Error("no cargó")); };
    document.head.appendChild(js);
  });
  return cargaTurnstile;
}
async function prepararTurnstile() {
  if (sitioTurnstile === undefined) {
    try {
      const d = await (await fetch("/api/cuenta")).json();
      if (d.cuenta) { ponerCuenta(d.cuenta); if (vistaCuenta === "crear") pintarCuenta("inicio"); return; }
      sitioTurnstile = d.turnstile || null;
    } catch (e) { return; }   // sin red: crear dirá lo que pase
  }
  const caja = dentroCuenta.querySelector(".turnstile");
  if (!sitioTurnstile || !caja || widgetTurnstile !== null) return;
  caja.hidden = false;
  try { await scriptTurnstile(); } catch (e) { caja.textContent = "No cargó la comprobación de Cloudflare: recarga la página."; return; }
  if (!caja.isConnected || widgetTurnstile !== null) return;
  fichaTurnstile = "";
  widgetTurnstile = window.turnstile.render(caja, { sitekey: sitioTurnstile, action: "crear", theme: "dark",
    language: "es", size: "flexible",
    callback: (t) => { fichaTurnstile = t; },
    "expired-callback": () => { fichaTurnstile = ""; },
    "error-callback": () => { fichaTurnstile = ""; } });
}
function quitarTurnstile() {
  if (widgetTurnstile === null) return;
  try { window.turnstile.remove(widgetTurnstile); } catch (e) { /* ya no estaba */ }
  widgetTurnstile = null;
  fichaTurnstile = "";
}
function rehacerTurnstile() {
  fichaTurnstile = "";
  if (widgetTurnstile !== null) try { window.turnstile.reset(widgetTurnstile); } catch (e) { /* se rehará al volver */ }
}

// Mientras va una petición, todo apagado (también la X) y la ventana no se cierra;
// si falla, el error sale junto a lo que se pulsó y lo escrito se queda.
function ocupar(si) {
  ocupado = si;
  dialogoCuenta.querySelectorAll("button, input, a.accion").forEach(el => {
    if (el.tagName === "A") el.toggleAttribute("aria-disabled", si); else el.disabled = si;
  });
}
async function enCuenta(fn, donde) {
  const aviso = (donde && donde.querySelector(".error")) || dentroCuenta.querySelector(".error-general")
    || dentroCuenta.querySelector(".error");
  if (aviso) aviso.hidden = true;
  ocupar(true);
  try { await fn(); }
  catch (e) {
    if (!aviso || !aviso.isConnected) { avisar(e.message); return; }
    aviso.textContent = e.message;
    aviso.hidden = false;
  }
  finally { if (ocupado) ocupar(false); }
}

function dentroDeLaCuenta(d, texto) {
  cola = []; guardarLocal(CLAVE_COLA, cola);   // lo de este navegador ya está en la cuenta
  ponerCuenta(d.cuenta);
  mensajeCuenta = texto;
}

const ENVIOS_CUENTA = {
  crear: async (v) => {
    const usuario = normalizarUsuario(v.usuario);
    if (!usuario) throw new Error(TEXTO_USUARIO);
    const correo = v.correo.trim() ? normalizarCorreo(v.correo) : null;
    if (v.correo.trim() && !correo) throw new Error(TEXTO_CORREO);
    const mal = problemaContrasena(v.contrasena, v.repetida, usuario);
    if (mal) throw new Error(mal);
    if (sitioTurnstile && !fichaTurnstile) throw new Error("Espera a que Cloudflare compruebe que no eres un robot (el recuadro de arriba).");
    const [clave, claveCorreo] = await Promise.all([claveDe(usuario, v.contrasena), correo && claveDe(correo, v.contrasena)]);
    const cuerpo = { usuario, clave, equipos: [...favoritos], ...(correo ? { correo, clave_correo: claveCorreo } : {}),
      ...(fichaTurnstile ? { turnstile: fichaTurnstile } : {}) };
    let d;
    try { d = await pedirCuenta("/crear", cuerpo); } finally { rehacerTurnstile(); }
    dentroDeLaCuenta(d, "Cuenta creada. Entra con «" + usuario + "»" + (correo ? " o con tu correo" : "")
      + " y tu contraseña desde cualquier aparato.");
    pintarCuenta("inicio");
  },
  entrar: async (v) => {
    const texto = String(v.usuario || "");
    const correo = texto.includes("@") ? normalizarCorreo(texto) : null;
    const usuario = correo ? null : normalizarUsuario(texto);
    if (!(correo || usuario) || !v.contrasena) throw new Error("Usuario o contraseña incorrectos.");
    const clave = await claveDe(correo || usuario, v.contrasena);
    const d = await pedirCuenta("/entrar", { ...(correo ? { correo } : { usuario }), clave, equipos: [...favoritos] });
    dentroDeLaCuenta(d, "");
    dialogoCuenta.close();
    const k = d.cuenta.equipos.length;
    avisar("Dentro: " + (k ? plural(k, "equipo", "equipos") + " de tu cuenta." : "tu cuenta aún no sigue a ningún equipo."));
  },
  usuario: async (v) => {
    const usuario = normalizarUsuario(v.usuario);
    if (!usuario) throw new Error(TEXTO_USUARIO);
    const mal = problemaContrasena(v.contrasena, v.repetida, usuario);
    if (mal) throw new Error(mal);
    const d = await pedirCuenta("/usuario", { usuario, clave: await claveDe(usuario, v.contrasena) });
    dentroDeLaCuenta(d, "Listo: ya entras con «" + usuario + "» y tu contraseña.");
    pintarCuenta("inicio");
  },
  contrasena: async (v) => {
    if (!v.actual) throw new Error("Escribe tu contraseña actual.");
    const mal = problemaContrasena(v.contrasena, v.repetida, cuenta.usuario);
    if (mal) throw new Error(mal);
    if (v.contrasena === v.actual) throw new Error("La nueva es igual a la actual.");
    // con correo, la nueva también con su sal: si no, entrar con el correo pediría la vieja
    const [actual, nueva, nuevaCorreo] = await Promise.all([claveDe(cuenta.usuario, v.actual),
      claveDe(cuenta.usuario, v.contrasena), cuenta.correo && claveDe(cuenta.correo, v.contrasena)]);
    await pedirCuenta("/contrasena", { actual, nueva, ...(cuenta.correo ? { nueva_correo: nuevaCorreo } : {}) });
    mensajeCuenta = "Contraseña cambiada. Las sesiones de tus otros aparatos se cerraron.";
    pintarCuenta("inicio");
  },
  correo: async (v) => {
    const correo = v.correo.trim() ? normalizarCorreo(v.correo) : null;
    if (v.correo.trim() && !correo) throw new Error(TEXTO_CORREO);
    if (!correo && !cuenta.correo) throw new Error("Escribe tu correo.");
    if (correo && correo === cuenta.correo) throw new Error("Ese ya es tu correo.");
    if (!v.actual) throw new Error("Escribe tu contraseña.");
    const [actual, claveCorreo] = await Promise.all([claveDe(cuenta.usuario, v.actual), correo && claveDe(correo, v.actual)]);
    const d = await pedirCuenta("/correo", { correo: correo || "", actual, ...(correo ? { clave_correo: claveCorreo } : {}) });
    cuenta = { ...cuenta, correo: d.cuenta.correo };
    mensajeCuenta = correo ? "Correo guardado: ya puedes entrar también con él." : "Correo quitado de tu cuenta.";
    pintarCuenta("inicio");
  },
};

const ACCIONES_CUENTA = {
  cerrar: () => dialogoCuenta.close(),
  inicio: () => { mensajeCuenta = ""; pintarCuenta("inicio"); },
  "ir-crear": () => pintarCuenta("crear"),
  "ir-entrar": () => pintarCuenta("entrar"),
  "ir-contrasena": () => { mensajeCuenta = ""; pintarCuenta("contrasena"); },
  "ir-correo": () => { mensajeCuenta = ""; pintarCuenta("correo"); },
  "pedir-borrar": () => { mensajeCuenta = ""; pintarCuenta("borrar"); },
  salir: () => enCuenta(async () => {
    await pedirCuenta("/salir", { todas: false });
    ponerCuenta(null);
    dialogoCuenta.close();
    avisar("Sesión cerrada. Tus equipos siguen en este navegador.");
  }),
  "salir-todas": () => enCuenta(async () => {
    await pedirCuenta("/salir", { todas: true });
    ponerCuenta(null);
    dialogoCuenta.close();
    avisar("Sesión cerrada en todos tus aparatos.");
  }),
  "borrar-si": () => enCuenta(async () => {
    await pedirCuenta("/borrar", {});
    ponerCuenta(null);
    dialogoCuenta.close();
    avisar("Cuenta borrada. Tus equipos siguen en este navegador.");
  }),
};

botonCuenta.addEventListener("click", abrirCuenta);
// Mientras va una petición, la ventana no se cierra (ni con Esc ni con un clic fuera).
dialogoCuenta.addEventListener("cancel", (e) => { if (ocupado) e.preventDefault(); });
let pulsadoFuera = false;
dialogoCuenta.addEventListener("pointerdown", (e) => { pulsadoFuera = e.target === dialogoCuenta; });
window.addEventListener("storage", (e) => {
  if (e.key === CLAVE_SESION && e.newValue !== (cuenta ? "1" : "0")) cargarCuenta();
});
dialogoCuenta.addEventListener("click", (e) => {
  if (e.target === dialogoCuenta) {   // un clic fuera de la ventana (empezado fuera: no al soltar una selección)
    if (pulsadoFuera && !ocupado) dialogoCuenta.close();
    return;
  }
  const b = e.target.closest("[data-cuenta]");
  if (b && ACCIONES_CUENTA[b.dataset.cuenta] && !b.disabled) ACCIONES_CUENTA[b.dataset.cuenta](b);
});
dialogoCuenta.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target, enviar = ENVIOS_CUENTA[form.dataset.cuentaForm];
  if (!enviar || ocupado) return;
  const valores = Object.fromEntries(new FormData(form));
  enCuenta(() => enviar(valores), form);
});

// ==========================================
// AVISOS
// Los de Mis equipos (worker/avisos.js): uno 2 h antes de cada partido de los equipos
// con estrella, con el pronóstico, y otro con el resultado, por el servicio de avisos
// del navegador (Web Push; los enseña sw.js). Sin cuenta: la suscripción es de este
// navegador y lleva su lista de equipos, que se vuelve a mandar cuando cambian las
// estrellas y una vez por semana (así el servidor sabe que sigue viva). Solo en
// Cloudflare, y donde el navegador sabe: en el iPhone, con la web instalada.
// ==========================================
const CLAVE_AVISOS = "pronosticos.avisos";            // { huella, cuando }: lo último mandado; sin él, apagados
const CLAVE_NO_AVISOS = "pronosticos.avisos_no";      // dijo "Ahora no" a la invitación del detalle
const CLAVE_VAPID = "pronosticos.avisos_clave";       // { clave, cuando }: la pública del servidor, de hoy
const RESINCRONIZAR_MS = 7 * 86400000;
// ? (aún no se sabe, o Render: allí no hay avisos) | pendiente | no_soportado | ios_instalar | bloqueados | apagados
// | activos
const avisos = { estado: "?", ocupado: false, mensaje: "" };
let versionAvisos = 0, sincronia = null;

const deB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const aB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const soportaAvisos = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const esIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const enApp = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function repintarAvisos() {
  versionAvisos++;
  if (datos) render();
}

// La clave pública VAPID del servidor, guardada un día en el navegador: así, al pulsar
// "Activar avisos", ya está y el permiso se pide en el mismo clic (Safari lo exige).
async function claveServidor() {
  const g = leerLocal(CLAVE_VAPID, null);
  if (g && g.clave && Date.now() - g.cuando < 86400000) return g.clave;
  const d = await (await fetch("/api/avisos")).json();
  if (!d.disponible || !d.clave) return null;
  guardarLocal(CLAVE_VAPID, { clave: d.clave, cuando: Date.now() });
  return d.clave;
}

async function suscripcionActual() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// La suscripción de este navegador, con la clave de ahora (si el servidor la cambió, la
// de antes ya no sirve): la que hay, o una nueva si hay permiso.
async function suscribir(clave) {
  // ready no termina nunca si el navegador no dejó registrar sw.js (algunas ventanas privadas)
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, mal) =>
    setTimeout(() => mal(new Error("este navegador no deja recibir avisos aquí.")), 10000))]);
  let sub = await reg.pushManager.getSubscription();
  const suya = sub && sub.options && sub.options.applicationServerKey;
  if (sub && suya && aB64u(suya) !== clave) { await sub.unsubscribe(); sub = null; }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deB64u(clave) });
}

// Manda la suscripción y los equipos si cambiaron (o hace una semana que no).
async function sincronizar(sub, forzar) {
  const j = sub.toJSON();
  const equipos = [...favoritos].sort();
  const huella = j.endpoint + "|" + equipos.join("|");
  const antes = leerLocal(CLAVE_AVISOS, null);
  if (!forzar && antes && antes.huella === huella && Date.now() - antes.cuando < RESINCRONIZAR_MS) return;
  const r = await fetch("/api/avisos/alta", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, equipos }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "no hubo respuesta; inténtalo otra vez.");
  guardarLocal(CLAVE_AVISOS, { huella, cuando: Date.now() });
}

// Al abrir la web en Cloudflare: en qué punto están los avisos de este navegador, y si
// están activos, que sigan bien (suscripción viva, con la clave de ahora y los equipos
// de ahora).
async function prepararAvisos() {
  if (avisos.estado !== "?") return;
  avisos.estado = "pendiente";
  try {
    if (!soportaAvisos()) avisos.estado = esIOS() && !enApp() ? "ios_instalar" : "no_soportado";
    else if (Notification.permission === "denied") avisos.estado = "bloqueados";
    else if (leerLocal(CLAVE_AVISOS, null) && Notification.permission === "granted") {
      await sincronizar(await suscribir(await claveServidor()), false);
      avisos.estado = "activos";
    } else {
      avisos.estado = "apagados";
      if (favoritos.size) claveServidor().catch(() => {});   // para que el clic no tenga que esperarla
    }
  } catch (e) {
    // la suscripción se perdió y no se pudo rehacer: se vuelve a activar con el botón
    try { localStorage.removeItem(CLAVE_AVISOS); } catch (err) { /* sin memoria */ }
    avisos.estado = "apagados";
  }
  repintarAvisos();
}

// Cambiaron las estrellas: con los avisos activos, los equipos van al servidor (juntos,
// si se tocan varias seguidas).
function equiposCambiados() {
  calendarioAlDia();
  if (avisos.estado === "apagados" && favoritos.size) claveServidor().catch(() => {});
  if (avisos.estado !== "activos") return;
  clearTimeout(sincronia);
  sincronia = setTimeout(async () => {
    try { const sub = await suscripcionActual(); if (sub) await sincronizar(sub, false); }
    catch (e) { /* se reintenta con la próxima estrella o al volver a abrir la web */ }
  }, 1500);
}

async function activarAvisos() {
  const clave = await claveServidor();
  if (!clave) throw new Error("los avisos no están disponibles ahora mismo.");
  const permiso = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permiso !== "granted") { avisos.estado = permiso === "denied" ? "bloqueados" : "apagados"; return; }
  await sincronizar(await suscribir(clave), true);
  avisos.estado = "activos";
  avisar("Avisos activados: te avisamos antes de cada partido de tus equipos y con el resultado.");
}

async function desactivarAvisos() {
  const sub = await suscripcionActual();
  if (sub) {
    const j = sub.toJSON();
    const r = await fetch("/api/avisos/baja", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: j.endpoint, auth: j.keys.auth }) });
    if (!r.ok) throw new Error("no hubo respuesta; inténtalo otra vez.");
    await sub.unsubscribe();
  }
  try { localStorage.removeItem(CLAVE_AVISOS); } catch (e) { /* sin memoria */ }
  avisos.estado = "apagados";
}

async function accionAvisos(que) {
  if (que === "no") { guardarLocal(CLAVE_NO_AVISOS, true); repintarAvisos(); return; }
  if (avisos.ocupado) return;
  avisos.ocupado = true;
  avisos.mensaje = "";
  repintarAvisos();
  try { await (que === "activar" ? activarAvisos() : desactivarAvisos()); }
  catch (e) { avisos.mensaje = (que === "activar" ? "No se pudieron activar: " : "No se pudieron quitar: ") + (e.message || e); }
  finally { avisos.ocupado = false; repintarAvisos(); }
}

const botonAvisos = (que, texto, principal) => '<button class="accion' + (principal ? " principal" : "") + '" data-avisos="'
  + que + '"' + (avisos.ocupado ? " disabled" : "") + '>' + esc(avisos.ocupado ? "Un momento…" : texto) + '</button>';

// La tarjeta de los avisos, arriba de Mis equipos; null donde no hay avisos (Render).
function bloqueAvisos() {
  const e = avisos.estado;
  if (e === "?" || e === "pendiente") return null;
  const n = favoritos.size;
  const textos = {
    activos: ["Avisos activados en este aparato", "Te avisamos 2 h antes de cada partido de tus " + n
      + (n === 1 ? " equipo" : " equipos") + ", con el pronóstico, y cuando termina, con el resultado. Si cae de madrugada"
      + " (hora de Lima), el aviso llega la noche antes.", botonAvisos("desactivar", "Quitar los avisos")],
    apagados: ["Avisos de tus equipos", "Te avisamos 2 h antes de cada partido de los equipos que sigues, con el"
      + " pronóstico, y cuando termina, con el resultado. Solo en este aparato; sin cuenta ni correo.",
      botonAvisos("activar", "Activar avisos", true)],
    bloqueados: ["Los avisos están bloqueados", "Este navegador tiene bloqueados los avisos de esta web. Para recibirlos,"
      + " permítelos en los ajustes del sitio (el icono junto a la dirección) y vuelve a esta página.", ""],
    ios_instalar: ["Avisos en el iPhone", "En el iPhone solo llegan con la web instalada: toca Compartir, luego"
      + " «Añadir a pantalla de inicio», y ábrela desde ese icono.", ""],
    no_soportado: ["Avisos", "Este navegador no puede recibir avisos de webs.", ""],
  };
  const [titulo, texto, boton] = textos[e];
  return {
    id: "avisos", clase: "avisos-tarjeta", huella: e + "|" + n + "|" + avisos.ocupado + "|" + avisos.mensaje,
    html: ICONO_CAMPANA + '<div><h2>' + esc(titulo) + '</h2><p>' + esc(texto)
      + (e === "activos" || e === "apagados" ? ' ' + ENLACE_PRIVACIDAD : "") + '</p>'
      + (avisos.mensaje ? '<p class="error" role="status">' + esc(avisos.mensaje) + '</p>' : "")
      + (boton ? '<div class="botones">' + boton + '</div>' : "") + '</div>',
  };
}

// En el detalle de un partido de un equipo que sigues, si los avisos están apagados y
// no dijo "Ahora no".
function htmlInvitacionAvisos(p) {
  if (avisos.estado !== "apagados" || !esFavorito(p) || leerLocal(CLAVE_NO_AVISOS, false)) return "";
  return '<div class="det-avisos">' + ICONO_CAMPANA + '<p>¿Te avisamos 2 h antes de los partidos de tus equipos, y'
    + ' con el resultado?</p>' + (avisos.mensaje ? '<p class="error" role="status">' + esc(avisos.mensaje) + '</p>' : "")
    + botonAvisos("activar", "Activar avisos", true) + (avisos.ocupado ? "" : botonAvisos("no", "Ahora no")) + '</div>';
}

// ==========================================
// CALENDARIO
// El de Mis equipos (worker/calendario.js): una dirección .ics que se suscribe una vez
// desde Google Calendar, el iPhone u Outlook, con los partidos de los equipos con estrella
// y su pronóstico (y el resultado al terminar). Sin cuenta: el servidor da una clave al azar
// para la lista de equipos de este navegador, y cada vez que cambian las estrellas la lista
// nueva va con la misma clave, así que el calendario suscrito la sigue solo. Solo en
// Cloudflare.
// ==========================================
const CLAVE_CALENDARIO = "pronosticos.calendario";   // { clave, huella }: el de este navegador y lo último mandado
const calendario = { ocupado: false, mensaje: "" };
let sincroniaCal = null;
const ICONO_CALENDARIO = '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" stroke-linejoin="round"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';

async function mandarCalendario(clave) {
  const equipos = [...favoritos].sort();
  const r = await fetch("/api/calendario", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clave ? { clave, equipos } : { equipos }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "no hubo respuesta; inténtalo otra vez.");
  guardarLocal(CLAVE_CALENDARIO, { clave: d.clave, huella: equipos.join("|") });
  return d.clave;
}

// Si las estrellas cambiaron desde lo último que se mandó (en esta pestaña, en otra o con la
// cuenta), la lista nueva va al servidor; juntas, si se tocan varias seguidas.
function calendarioAlDia() {
  const cal = leerLocal(CLAVE_CALENDARIO, null);
  if (!cal || !cal.clave || cal.huella === [...favoritos].sort().join("|")) return;
  clearTimeout(sincroniaCal);
  sincroniaCal = setTimeout(() => mandarCalendario(cal.clave).catch(() => { /* con la próxima estrella o visita */ }), 1500);
}

async function accionCalendario(que) {
  const cal = leerLocal(CLAVE_CALENDARIO, null);
  if (que === "copiar") {
    const url = location.origin + "/calendario/" + cal.clave + ".ics";
    try { await navigator.clipboard.writeText(url); avisar("Enlace del calendario copiado: pégalo donde se añaden calendarios por URL."); }
    catch (e) { avisar("Copia este enlace: " + url); }
    return;
  }
  if (calendario.ocupado) return;
  calendario.ocupado = true;
  calendario.mensaje = "";
  render();
  try {
    if (que === "quitar") {
      const r = await fetch("/api/calendario", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clave: cal.clave, borrar: true }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "no hubo respuesta; inténtalo otra vez.");
      try { localStorage.removeItem(CLAVE_CALENDARIO); } catch (e) { /* sin memoria */ }
      avisar("Calendario quitado: su dirección ya no funciona. Bórralo también de tu aplicación de calendario.");
    } else {
      await mandarCalendario(null);
    }
  } catch (e) { calendario.mensaje = (que === "quitar" ? "No se pudo quitar: " : "No se pudo crear: ") + (e.message || e); }
  finally { calendario.ocupado = false; render(); }
}

// La tarjeta del calendario, en Mis equipos (solo en Cloudflare y con algún equipo).
function bloqueCalendario() {
  if (!datos || datos.plataforma !== "cloudflare" || !favoritos.size) return null;
  const cal = leerLocal(CLAVE_CALENDARIO, null);
  const n = favoritos.size;
  let titulo, texto, botones;
  if (cal && cal.clave) {
    const webcal = "webcal://" + location.host + "/calendario/" + cal.clave + ".ics";
    titulo = "Tu calendario de Mis equipos";
    texto = "Suscríbete una vez y se pone al día solo: los partidos de tus " + n + (n === 1 ? " equipo" : " equipos")
      + ", con el pronóstico y, al terminar, el resultado. También cuando sigas a otro.";
    botones = '<a class="accion principal" href="https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(webcal)
      + '" target="_blank" rel="noopener">Google Calendar</a>'
      + '<a class="accion" href="' + esc(webcal) + '">iPhone, Mac u Outlook</a>'
      + '<button class="accion" data-calendario="copiar">Copiar el enlace</button>'
      + '<button class="accion" data-calendario="quitar"' + (calendario.ocupado ? " disabled" : "") + '>Quitar el calendario</button>';
  } else {
    titulo = "Tus partidos en tu calendario";
    texto = "Los partidos de tus equipos, con el pronóstico, en Google Calendar, el iPhone u Outlook. Se pone al día"
      + " solo, también cuando sigues a otro equipo. Sin cuenta.";
    botones = '<button class="accion principal" data-calendario="crear"' + (calendario.ocupado ? " disabled" : "") + '>'
      + esc(calendario.ocupado ? "Un momento…" : "Añadir a mi calendario") + '</button>';
  }
  return {
    id: "calendario", clase: "avisos-tarjeta", huella: (cal && cal.clave) + "|" + n + "|" + calendario.ocupado + "|" + calendario.mensaje,
    html: ICONO_CALENDARIO + '<div><h2>' + esc(titulo) + '</h2><p>' + esc(texto) + ' ' + ENLACE_PRIVACIDAD + '</p>'
      + (calendario.mensaje ? '<p class="error" role="status">' + esc(calendario.mensaje) + '</p>' : "")
      + '<div class="botones">' + botones + '</div></div>',
  };
}

// ==========================================
// SONDEO
// Con la pestaña oculta no se pregunta: una pestaña olvidada costaba hasta 2.880
// peticiones al día, y el plan gratis de Cloudflare da 100.000 para todos.
// Al volver a ella, se pide en el acto. Los números cambian como mucho una vez por
// minuto (una pasada del cron), y con la web al día cada 25: se pregunta cada 15 s
// mientras se calcula y cada minuto el resto del tiempo.
// ==========================================
let periodo = 15000;
let estadoPrevio = null;
let etagEstado = null, etagRegistro = null;
// Con el ETag de la vez anterior el servidor contesta 304 si nada cambió, y no
// vuelven a viajar los ~100 KB del estado.
const pedirSiCambio = (ruta, etag) => fetch(ruta, etag ? { headers: { "If-None-Match": etag } } : {});
async function refrescar() {
  try {
    const r = await pedirSiCambio("/api/estado", etagEstado);
    // sin cambios se repinta igual: la cuenta atrás, los que ya empezaron, Hoy y Mañana
    if (r.status === 304 && datos) { render(); return; }
    if (!r.ok) throw new Error("HTTP " + r.status);   // un 500 no pisa los datos que ya hay
    etagEstado = r.headers.get("ETag");
    datos = await r.json();
    if (datos.plataforma === "cloudflare") { botonCuenta.hidden = false; prepararAvisos(); calendarioAlDia(); }   // solo existen allí
    periodo = (datos.estado === "actualizando") ? 15000 : 60000;
    // las medias de liga y el registro en vivo solo cambian cuando termina una pasada
    if (estadoPrevio === "actualizando" && datos.estado !== "actualizando") { cargarLigas(); cargarRegistro(); }
    estadoPrevio = datos.estado;
    render();
    if (partidoEnlazado && datos.dias && datos.dias.length) abrirEnlazado();
  } catch (e) {
    estadoCorto.dataset.modo = "error";
    estadoCorto.querySelector(".txt").textContent = "Sin conexión";
    estadoBarra.dataset.modo = "error";
    estadoBarra.innerHTML = '<span><span class="punto"></span>Sin conexión con el servidor. Reintentando…</span>';
    estadoBarra.dataset.huella = "";
  }
}

async function cargarLigas() {
  try {
    infoLigas = await (await fetch("/api/ligas")).json();
    paneLigas.dataset.huella = "";
    if (datos) render();
  } catch (e) { /* sin medias: el panel enseña solo los recuentos */ }
}

// La validación es cara de calcular pero no cambia casi nunca: se pide al arrancar.
async function cargarValidacion() {
  try {
    validacion = await (await fetch("/api/validacion")).json();
    paneLigas.dataset.huella = "";
    if (datos) render();
  } catch (e) { /* sin fiabilidad medida: el panel lo dice */ }
}

// El registro en vivo cambia cuando una pasada baja resultados: unas pocas veces al
// día. En Render no existe (responde no_disponible) y los paneles no lo enseñan.
async function cargarRegistro() {
  try {
    const r = await pedirSiCambio("/api/registro", etagRegistro);
    if (!r.ok) return;   // también el 304: el que ya hay sigue valiendo
    etagRegistro = r.headers.get("ETag");
    registro = await r.json();
    paneLigas.dataset.huella = "";
    panePan.dataset.huella = "";
    if (datos) render();
  } catch (e) { /* sin registro: los paneles no lo enseñan */ }
}

let espera = null, pidiendo = false;
async function bucle() {
  clearTimeout(espera);
  espera = null;
  if (pidiendo) return;
  pidiendo = true;
  await refrescar();
  pidiendo = false;
  if (!document.hidden) espera = setTimeout(bucle, periodo);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(espera); espera = null; enviarVisitas(); }
  else if (!espera && !pidiendo) bucle();
});
bucle();
cargarCuenta();
cargarLigas();
cargarValidacion();
cargarRegistro();
setInterval(() => { if (!document.hidden) cargarRegistro(); }, 15 * 60000);
