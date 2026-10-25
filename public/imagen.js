// La imagen de un pronóstico para compartir en historias (Instagram, WhatsApp):
// un PNG de 1080x1920 dibujado en un canvas, en el navegador, sin pedir nada al
// servidor. app.js lo carga solo cuando alguien pulsa "Imagen" (import()) y le pasa
// todo ya calculado: los mismos enteros y los mismos tonos que la web.
//
// Los escudos se piden con CORS: si el servidor de football-data no lo permite, la
// imagen no se puede usar en el canvas (lo "ensucia" y no se puede exportar), así
// que en ese caso va el monograma, como en la web.

const W = 1080, H = 1920, M = 84;   // ancho, alto y margen
const C = {
  fondo: "#070d0a", panel: "#111a15", linea: "#1f2b25", tinta: "#f4f7f5", tinta2: "#b8c5bd", tinta3: "#87968c",
  oscura: "#0a120e", logo: ["#ffd24c", "#a18047", "#594d39"],
};
const DISP = '"Saira", "Archivo Narrow", "Arial Narrow", system-ui, sans-serif';
const TXT = '"Figtree", "Segoe UI", system-ui, -apple-system, sans-serif';

function cargarEscudo(url) {
  return new Promise((ok) => {
    if (!url || !/^https:\/\//.test(url)) return ok(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    const fin = setTimeout(() => ok(null), 4000);
    img.onload = () => { clearTimeout(fin); ok(img); };
    img.onerror = () => { clearTimeout(fin); ok(null); };
    img.src = url;
  });
}

function rectRedondo(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Texto en varias líneas, como mucho `max`, con "…" si no cabe; devuelve la y final.
function parrafo(g, texto, x, y, ancho, alto, max) {
  const palabras = String(texto).split(/\s+/);
  const lineas = [];
  let actual = "";
  for (const p of palabras) {
    const prueba = actual ? actual + " " + p : p;
    if (g.measureText(prueba).width <= ancho || !actual) actual = prueba;
    else { lineas.push(actual); actual = p; }
  }
  if (actual) lineas.push(actual);
  const quedan = lineas.slice(0, max);
  if (lineas.length > max) {
    let u = quedan[max - 1];
    while (u && g.measureText(u + "…").width > ancho) u = u.slice(0, -1);
    quedan[max - 1] = u + "…";
  }
  quedan.forEach((l, i) => g.fillText(l, x, y + i * alto));
  return y + quedan.length * alto;
}

// Una línea que no pase de `ancho`: si no cabe, se corta con "…".
function ajustar(g, texto, ancho) {
  let t = String(texto);
  if (g.measureText(t).width <= ancho) return t;
  while (t && g.measureText(t + "…").width > ancho) t = t.slice(0, -1);
  return t + "…";
}

function escudo(g, img, ini, cx, cy, r) {
  g.save();
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.closePath();
  g.fillStyle = C.panel; g.fill();
  g.lineWidth = 4; g.strokeStyle = C.linea; g.stroke();
  if (img) {
    g.clip();
    const s = r * 1.3;
    g.drawImage(img, cx - s / 2, cy - s / 2, s, s);
  } else {
    g.fillStyle = C.tinta2; g.font = `800 ${r}px ${DISP}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(ini, cx, cy + r * 0.05);
  }
  g.restore();
}

// d: { liga, sigla, tono, tinta, cuando, local, visita, iniLocal, iniVisita, escudoLocal,
//      escudoVisita, veredicto, frase, reparto: [{v, nombre, bg, fg}] x3, extras: [[texto, valor]],
//      web }
export async function dibujarImagen(d) {
  await Promise.all(["800 80px Saira", "700 48px Figtree", "500 36px Figtree"].map((f) => document.fonts.load(f).catch(() => null)));
  const [eL, eV] = await Promise.all([cargarEscudo(d.escudoLocal), cargarEscudo(d.escudoVisita)]);
  const lienzo = document.createElement("canvas");
  lienzo.width = W; lienzo.height = H;
  const g = lienzo.getContext("2d");
  g.fillStyle = C.fondo; g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";

  // la marca: el logo Casilla y el nombre
  let y = 150;
  C.logo.forEach((tono, i) => { g.fillStyle = tono; rectRedondo(g, M + i * 46, y - 52, 38, 60, 9); g.fill(); });
  g.fillStyle = C.tinta; g.font = `800 64px ${DISP}`; g.textAlign = "left";
  g.fillText("Pronósticos", M + 158, y);

  // la liga y cuándo
  y = 300;
  g.font = `800 34px ${DISP}`;
  const anchoSigla = g.measureText(d.sigla).width + 36;
  rectRedondo(g, M, y - 44, anchoSigla, 58, 12);
  if (d.tono === "none") { g.lineWidth = 3; g.strokeStyle = C.tinta; g.stroke(); } else { g.fillStyle = d.tono; g.fill(); }
  g.fillStyle = d.tono === "none" ? C.tinta : d.tinta; g.fillText(d.sigla, M + 18, y - 2);
  g.fillStyle = C.tinta; g.font = `700 44px ${TXT}`;
  parrafo(g, d.liga, M + anchoSigla + 22, y, W - 2 * M - anchoSigla - 22, 50, 1);
  g.fillStyle = C.tinta3; g.font = `500 36px ${TXT}`;
  g.fillText(d.cuando, M, y + 66);

  // los dos equipos, frente a frente (el nombre, hasta dos líneas)
  y = 480;
  const cx = [W * 0.27, W * 0.73];
  g.fillStyle = C.tinta3; g.font = `600 30px ${TXT}`; g.textAlign = "center";
  g.fillText("LOCAL", cx[0], y - 24); g.fillText("VISITANTE", cx[1], y - 24);
  escudo(g, eL, d.iniLocal, cx[0], y + 110, 110);
  escudo(g, eV, d.iniVisita, cx[1], y + 110, 110);
  g.fillStyle = C.tinta3; g.font = `800 52px ${DISP}`; g.textAlign = "center";
  g.fillText("vs", W / 2, y + 128);
  g.fillStyle = C.tinta; g.font = `700 48px ${TXT}`;
  parrafo(g, d.local, cx[0], y + 300, 420, 56, 2);
  parrafo(g, d.visita, cx[1], y + 300, 420, 56, 2);

  // el pronóstico en una frase
  y = 960;
  g.textAlign = "left";
  g.fillStyle = C.tinta; g.font = `800 72px ${DISP}`;
  y = parrafo(g, d.veredicto, M, y, W - 2 * M, 80, 2);
  g.fillStyle = C.tinta2; g.font = `500 40px ${TXT}`;
  y = parrafo(g, d.frase, M, y + 10, W - 2 * M, 50, 2);

  // la barra 1 X 2, con los mismos enteros y tonos que la web
  y += 40;
  const anchoBarra = W - 2 * M, alto = 130, hueco = 6;
  const util = anchoBarra - hueco * (d.reparto.length - 1);
  let x = M;
  d.reparto.forEach((s, i) => {
    const w = Math.max(util * s.v / 100, 8);
    g.save();
    rectRedondo(g, M, y, anchoBarra, alto, 22); g.clip();
    g.fillStyle = s.bg; g.fillRect(x, y, w, alto);
    g.restore();
    if (s.v >= 9) {
      g.fillStyle = s.fg; g.font = `800 64px ${DISP}`; g.textAlign = "center";
      g.fillText(String(s.v), x + w / 2, y + alto / 2 + 23);
    }
    s.x = x; s.w = w;
    x += w + (i < d.reparto.length - 1 ? hueco : 0);
  });
  y += alto + 56;
  g.font = `600 34px ${TXT}`;
  const tercio = (W - 2 * M) / 3 - 12;
  d.reparto.forEach((s, i) => {
    g.fillStyle = C.tinta2;
    g.textAlign = i === 0 ? "left" : i === 2 ? "right" : "center";
    const px = i === 0 ? M : i === 2 ? W - M : W / 2;
    g.fillText(ajustar(g, s.nombre + " " + s.v + " %", tercio), px, y);
  });

  // los mercados de goles y el marcador más probable
  y += 70;
  const col = (W - 2 * M - 2 * 24) / 3;
  d.extras.slice(0, 3).forEach(([t, v], i) => {
    const px = M + i * (col + 24);
    rectRedondo(g, px, y, col, 150, 22); g.fillStyle = C.panel; g.fill();
    g.lineWidth = 2; g.strokeStyle = C.linea; g.stroke();
    g.textAlign = "left";
    g.fillStyle = C.tinta3; g.font = `600 28px ${TXT}`;
    g.fillText(ajustar(g, t, col - 52), px + 26, y + 50);
    g.fillStyle = C.tinta; g.font = `800 60px ${DISP}`;
    g.fillText(ajustar(g, v, col - 52), px + 26, y + 120);
  });

  // al pie: de dónde sale. Por encima de los ~200 px de abajo, que en una historia de
  // Instagram tapa la barra de responder.
  g.textAlign = "left";
  g.fillStyle = C.tinta3; g.font = `500 30px ${TXT}`;
  parrafo(g, "Probabilidades de un modelo estadístico con los resultados de cada equipo. No es una garantía.", M, H - 300, W - 2 * M, 40, 2);
  g.fillStyle = C.tinta2; g.font = `600 32px ${TXT}`;
  parrafo(g, ajustar(g, d.web, W - 2 * M), M, H - 206, W - 2 * M, 40, 1);

  return new Promise((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error("sin imagen"))), "image/png"));
}
