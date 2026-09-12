# pronosticos-bot — contexto de proyecto

Resume el estado, las decisiones ya tomadas y por qué, para no repetir
investigación ya hecha. Claude Code lee este archivo automáticamente al abrir el
proyecto.

## Qué es

App Flask en Render que predice resultados de fútbol (1/X/2 y doble oportunidad)
con un modelo Poisson de fuerzas ataque/defensa.

- Repo: `pronosticos-bot`
- Carpeta local: `C:\Users\Alvaro\Desktop\webapp`
- URL producción: https://pronosticos-bot.onrender.com
- Ficheros clave: `app.py`, `templates/index.html`, `validacion.py`, `backtest.py`,
  `afinar.py`, `diagnostico.py`

## Stack

- Python 3.12.7 en Render (el default de Render es 3.14 y rompe scipy — fijar
  versión explícitamente, `runtime.txt`). En local: 3.14.
- Flask + gunicorn (`gunicorn app:app`), scipy para el modelo Poisson.
- Datos: football-data.org, plan free (10 peticiones/minuto, sin acceso a
  temporadas 2021/2022 — devuelven HTTP 403).
- Ligas activas: PD, PL, FL1, BL1. Champions deliberadamente fuera (razón
  abajo). SA y DED entrarían en el plan free si se quisiera sumar.

## Arquitectura

**Actualización reanudable por presupuesto.** Cada pasada gasta como mucho
`PRESUPUESTO_REQUESTS` (40). Al agotarse, el estado queda en `parcial` y la
siguiente pasada continúa por los partidos más cercanos. Las predicciones se
conservan 24h. `MIN_MINUTOS_ACTUALIZACION` no aplica cuando el estado es
`parcial`: continuar no es rehacer trabajo.

**Planificador interno** (sustituyó a cron-job.org). Hilos que arrancan al
importar el módulo:

- keep-alive cada 9 min: pide `/salud` a sí mismo vía `RENDER_EXTERNAL_URL`.
  Render free duerme el servicio tras 15 min sin peticiones entrantes, y un hilo
  de fondo no cuenta como tráfico.
- actualizador cada 5 min: decide si toca actualizar y ejecuta. También lanza la
  validación la primera vez, pero solo cuando el calendario ya está `listo`:
  llenar la web es más urgente que medir el modelo y las dos cosas compiten por
  las mismas 10 peticiones/minuto.

En local viene desactivado por defecto (solo se activa si detecta
`RENDER_EXTERNAL_URL`), para que `backtest.py`/`afinar.py` puedan importar
`app.py` sin gastar cuota de la API.

**Coste:** el plan free da ~750h de instancia/mes por workspace (el mes tiene
~730h). Con el keep-alive el servicio va 24/7 y las consume casi todas. Cabe si
`pronosticos-bot` es el único servicio del workspace — un segundo servicio free
suspendería a ambos.

**Endpoints:** `/` (web), `/api/estado`, `/api/ligas` (qué ancla y qué media usa
cada liga), `/salud`, `/actualizar?token=...&forzar=1`,
`/validar?token=...[&temporada=N]` (lanza el backtest) y `/api/validacion` (su
resultado).

**Efecto secundario de cada deploy:** el disco de Render free es efímero, cada
deploy borra `cache.json` y `data.json`. Justo después la web dice "Todavía no
hay datos" hasta la primera actualización, que paga el coste completo de API (~2
peticiones/equipo) porque la caché está vacía. Conviene forzarla con
`/actualizar?token=...&forzar=1` en vez de esperar al cron.

## Bugs ya encontrados y corregidos (no reabrir sin motivo nuevo)

1. **Normalizador equivocado en `calcular_xg_partido`** (crítico). La defensa del
   visitante se dividía entre `avg_visita`, pero los goles que encaja fuera son
   goles de local. Dos equipos medios daban xG 2.00-0.93 en vez de 1.55-1.20 —
   sesgo sistemático a favor del local en todos los partidos.
2. **`/v4/matches` global no sirve en plan free:** devuelve HTTP 200 con lista
   vacía en vez de 403. Se usa `/v4/competitions/{cod}/matches` con
   `dateFrom`/`dateTo`, inyectando a mano el bloque `competition`.
3. **Fallback todo-o-nada** (`n_local == 0 or n_visita == 0` → 1.3 fijo) producía
   predicciones idénticas a inicio de temporada. Sustituido por encogimiento
   bayesiano hacia la media de liga.
4. **Datos contaminados:** `/teams/{id}/matches` sin `competitions` mezclaba Copa
   del Rey, Champions y amistosos; `limit=20` sin orden no garantizaba los 20
   últimos.
5. **Prior de una liga aplicado a las cuatro** (sept 2026). `PRIOR_AVG_LOCAL` /
   `PRIOR_AVG_VISITA` salían de LaLiga y se usaban en todas. Con `K_LIGA=50`, a
   30 partidos jugados el prior pesa el 62% del valor estimado; Bundesliga (más
   goleadora) salía ~9-12% por debajo. Arreglado: cada liga se ancla en su propia
   temporada anterior (`obtener_prior_liga`), una petición por liga cacheada 30
   días. Las constantes quedan solo como último recurso. Verificado: BL1 pasó de
   -11.8% a +3.2% de sesgo.
6. **Zona horaria en Windows:** `zoneinfo` no encuentra `America/Lima` sin el
   paquete `tzdata` (en Linux viene con el SO). Añadido a `requirements.txt` +
   fallback a UTC-5 fijo (exacto para Perú todo el año).
7. **Poisson truncado en 5 goles** perdía hasta 6.5% de masa → límite subido a 10
   y normalizado. Añadidas dobles oportunidad X2 y 12. `Cache-Control: no-store`
   para que un deploy no deje al navegador con la interfaz vieja.

## Por qué la Champions se queda fuera

El modelo mide la fuerza de un equipo con sus partidos en esa misma competición.
En liga hay ~19 partidos en casa y ~19 fuera; en Champions, 4 y 4. Y la "media de
la liga" en Champions no significa nada: mezcla al Bayern con el campeón de
Kazajistán, así que dividir entre esa media no mide fuerza relativa. Hacerlo bien
exige tomar las stats de cada equipo de su liga doméstica y normalizarlas entre
ligas — proyecto aparte, no trivial.

## Validación

Backtest sobre LaLiga 2023+2024 (720 partidos evaluados):

```
Modelo corregido      Brier 0.6013   LogLoss 1.0072   Acierto 49.0%
Base "equipo medio"   Brier 0.6499   LogLoss 1.0749   Acierto 44.4%
```

Skill score del 7.5% sobre la base. PL, FL1 y BL1 no están validadas todavía
(correr `LIGA_BACKTEST=PL python backtest.py 2023 2024`, etc.).

`validacion.py` corre ese mismo backtest walk-forward **dentro de la app**
(`/validar?token=...`, resultado en `/api/validacion`): importa
`calcular_xg_partido` y `calcular_poisson` de `app` en vez de reimplementarlos,
para no validar una copia desincronizada del modelo desplegado. Cuesta 2
peticiones por liga y solo la primera vez — las temporadas terminadas no cambian,
así que quedan cacheadas en disco.

## Afinado del modelo — dos decisiones cerradas (sept 2026)

Datos disponibles: solo LaLiga 2023+2024 (2021/2022 dan 403 en plan free).

### 1. Hiperparámetros (`PSEUDO_PARTIDOS=6`, `rho=0`): se quedan como están

No porque estén demostrados óptimos, sino porque con 760 partidos no se puede
distinguir ninguna configuración de otra:

- Train 2023 → gana `pseudo=3, rho=-0.2`; validado en 2024, pierde.
- Train 2024 → gana `pseudo=6, rho=0` (la config actual).
- Mínimo global de LogLoss sobre las dos temporadas juntas: `(pseudo=4,
  rho=-0.1)` = 1.0052 vs 1.0073 actual — diferencia 0.0021, y el test pareado da
  `+0.0021 ± 0.0029`: no significativo. Ídem para las otras comparaciones
  probadas.
- Matiz para el futuro: en las 7 configuraciones de la tabla, `rho` entre -0.05 y
  -0.15 sale sistemáticamente algo mejor que `rho=0`, coherente con el sesgo de
  empates de la calibración (25.3% predicho vs 27.6% real). Pero son los mismos
  760 partidos reutilizados 7 veces, no pruebas independientes. Si algún día hay
  más temporadas, esta es la primera hipótesis a reprobar.

### 2. Prior de equipos ascendidos: medido, real, y aun así descartado

Ascendidos a 2024 (Espanyol, Leganés, Valladolid), 57 partidos local + 57
visitante: ataque local 0.688 vs 1.055 del resto, ataque visitante 0.722 vs
1.049, defensa visitante 1.425 vs 0.925 (3 de 4 efectos superan 2 errores
estándar — el fenómeno es real, el modelo no lo captura).

No se implementa. Razones: la magnitud solo se puede medir en 2024, que es
también el único set de validación disponible — ajustar y evaluar sobre los
mismos datos es circular (exactamente lo que el punto 1 mostró que no sirve). Son
3 equipos de una sola temporada; el 0.688 concreto casi seguro no se repite. La
web ya avisa "⚠ Pocos partidos previos" en predicciones con poca muestra, así que
el usuario tiene la señal aunque el número no la tenga.

Si se retoma: no hace falta lista de ascendidos. Un equipo con muy pocos partidos
en la ventana de 400 días es un recién llegado — basta con cambiar el objetivo del
encogimiento (`_encoger`) para esos equipos en vez de añadir un campo nuevo. El
efecto se diluye solo conforme acumulan partidos.

## Mejoras hechas a las herramientas de afinado

- `afinar.py` hace test pareado de LogLoss con su error estándar (antes solo
  decía cuál ganaba, no si la diferencia era real).
- `afinar.py` y `backtest.py` avisan a gritos si una temporada no carga (antes
  tragaban un 403 en silencio y reportaban 3 temporadas habiendo cargado 1 —
  peor que un fallo ruidoso).
- `backtest.py` captura `requests.RequestException` en vez de morir.

## Render: por qué los `git push` no desplegaban solos

Hecho observado (sept 2026): los 7 deploys del historial figuran en Events como
"Manually triggered by you via Dashboard" — ningún push disparó un deploy solo.
Pero Auto-Deploy (Settings → Deploy, no Build — Render partió el antiguo "Build &
Deploy" en dos secciones) aparece en On Commit. Sin confirmar si ya estaba así o
se cambió al investigar.

Si estaba en On Commit todo el tiempo, revisar en este orden:

1. Build Filters (Settings → Build): rutas ignoradas que bloquean el deploy.
2. Branch: que Render vigile `main` y no otra rama.
3. Webhook de GitHub: repo desconectado o permisos revocados.

Cómo comprobarlo en 5 segundos: Render → Events, comparar el hash del último
"Deploy live" con `git log --oneline -1` en local. Si no coinciden, no hay nada
que depurar en el código — es el deploy.

Caso real que costó tiempo: se desplegó `fbfb44b` pero `cc47e64` (pantalla de
inicio por ligas) se quedó sin desplegar. Se perdieron varios mensajes revisando
git, caché del navegador y cabeceras HTTP antes de mirar Events — mirar Events
primero la próxima vez.

Mientras no se confirme que el auto-deploy funciona: después de cada push, Manual
Deploy → Deploy latest commit, y esperar a "Live".

## Pendiente (por orden de lo que más mueve la aguja)

- **Webhook de GitHub** (cosmético pero es la causa raíz probable de que los push
  no desplieguen solos — ver sección Render arriba).
- **Validar el modelo en PL, FL1 y BL1** (solo comprobado en LaLiga).
- **Persistencia:** el disco de Render free borra `cache.json`/`data.json` en cada
  deploy. Bloquea el registro de predicciones. Variable `DATA_DIR` ya preparada
  para cuando se resuelva (¿disco persistente de pago? ¿DB externa gratuita?).
- **Registro de predicciones en vivo:** nadie mide si los pronósticos publicados
  aciertan. Guardarlos con su resultado real cerraría el círculo y acumularía
  datos propios que el plan free no vende — es lo único que puede sacar el `rho`
  del empate estadístico descrito arriba.
- **Navegación con 41 partidos:** falta vista por día cruzando ligas, orden por
  partido más igualado/desequilibrado, y búsqueda por equipo.
- **`test_migracion.py` está desincronizado:** prueba `app._parsear_standings` y
  `app.USAR_PRIOR_PREVIA`, que no existen en `app.py`. Es de una migración a
  `/standings` que no está en el código actual, así que el archivo revienta con
  `AttributeError` si se corre. O se completa la migración o se borra el test;
  tal como está no prueba nada.
- **Más temporadas de datos:** bloqueado por el plan free de football-data.org. Es
  lo único que convertiría el "empate estadístico" del afinado en una respuesta
  real.
- **xG real** (tier de pago): el techo de un modelo basado solo en goles
  marcados/encajados ronda un skill score del 9-10%; el actual ya está en 7.5%.

## Convenciones para seguir trabajando aquí

- No reabrir el debate de `PSEUDO_PARTIDOS`/`rho` ni el prior de ascendidos sin
  datos nuevos (más temporadas) — ya se demostró que con los datos actuales
  cualquier conclusión es ruido. Ver "Afinado del modelo" arriba.
- Cualquier cambio al modelo debe pasar por `backtest.py` sobre LaLiga 2023+2024
  como mínimo, y usar el test pareado de `afinar.py` para saber si una diferencia
  es real o ruido antes de adoptarla.
- Antes de depurar "la web no se actualiza", mirar Render → Events primero.
- Los hilos de fondo (keep-alive, actualizador) solo se activan si existe
  `RENDER_EXTERNAL_URL` — en local no consumen cuota de API al importar `app.py`.
