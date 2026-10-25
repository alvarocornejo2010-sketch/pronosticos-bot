// Lo que leen los buscadores. Toda la web va detrás del # (#/dia/..., #/liga/...),
// que Google no ve como páginas distintas; lo que sí ve son los enlaces de cada
// partido (/partido/123, compartir.js), con su título ("Inter – Shakhtar"), su
// descripción y su dirección canónica. El sitemap los lista todos, los de los
// partidos por jugar, para que Google los encuentre sin que nadie los enlace.
// Las direcciones salen del origen de la petición: si la web cambia de dominio,
// cambian solas. Los datos de la web (/api/estado y los demás de solo lectura) no
// se cierran: Google pinta la página con ellos, y sin ellos indexaría "Cargando".

import { isoSinMs } from "./registro.js";

export function robots(origen) {
  return `# La web, los partidos y los datos que pinta sí; las visitas, los avisos y las rutas con token, no.
User-agent: *
Disallow: /api/contar
Disallow: /api/visitas
Disallow: /api/avisos
Disallow: /visitas
Disallow: /actualizar
Disallow: /validar
Allow: /

Sitemap: ${origen}/sitemap.xml
`;
}

export async function sitemap(almacen, origen, ahora = Date.now()) {
  const db = almacen.db;
  const r = await almacen.consultar(() => db.prepare(
    `SELECT pa.id, pr.calculado FROM partidos pa LEFT JOIN predicciones pr ON pr.id = pa.id
     WHERE pa.utc > ?1 ORDER BY pa.utc, pa.orden`).bind(isoSinMs(ahora)).all());
  const url = (ruta, extra = "") => `<url><loc>${origen}${ruta}</loc>${extra}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url("/", "<changefreq>hourly</changefreq>")}
${r.results.map((f) => url(`/partido/${Number(f.id)}`,
    /^\d{4}-\d{2}-\d{2}/.test(f.calculado || "") ? `<lastmod>${f.calculado.slice(0, 10)}</lastmod>` : "")).join("\n")}
</urlset>
`;
}
