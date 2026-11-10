# Luxury Hunter v1.4.3

## Yahoo Auctions Japan: Mac primero, ReefAPI de reserva

Al activar «Japón» en una tarea, Luxury Hunter consulta las subastas de Yahoo Auctions en One Map, ordenadas por finalización. Lee la puja actual, número de pujas y tiempo restante, y analiza hasta 8 fichas por ejecución (`ONEMAP_DETAIL_LIMIT`). Cuando el Mac está despierto y Chrome con la extensión responde, usa esa búsqueda local. Si el Mac no está disponible o una consulta local falla, usa la búsqueda de ReefAPI para esa consulta. La reserva de ReefAPI solo lee resultados de búsqueda; no consume créditos en fichas detalladas. El bot no presenta pujas.

### Configuración del Mac

Ejecuta `bash scripts/install-onemap-mac.sh` en el Mac. El instalador crea un token local y una clave SSH restringida al túnel hacia el VPS; tendrás que escribir la contraseña del VPS en el terminal una vez. Instala dos LaunchAgents para iniciar el puente local y el túnel automáticamente al entrar en macOS. El token se guarda en `~/Library/Application Support/LuxuryHunter/OneMap/bridge-token` y como secreto `ONEMAP_MAC_BRIDGE_TOKEN` en GitHub Actions si `gh` está disponible. No publiques el token.

En Chrome abre `chrome://extensions/`, activa «Modo de desarrollador», pulsa «Cargar descomprimida» y selecciona la carpeta `extension/onemap-mac`. Abre las opciones de la extensión, pega el contenido de `~/Library/Application Support/LuxuryHunter/OneMap/bridge-token` y guarda. Chrome y el Mac deben permanecer encendidos y con acceso a One Map; si el equipo duerme, la siguiente tarea pasa a ReefAPI. No se copian cookies ni contraseñas de One Map al VPS.

Guarda la clave de ReefAPI como secreto `REEF_API_KEY` del repositorio de GitHub. `REEF_MONTHLY_SEARCH_LIMIT` limita los intentos a 500 por mes por defecto, hasta 1.000 créditos de búsqueda a la tarifa actual de 2 créditos por llamada correcta. Este contador se conserva con el estado SQLite del bot; si se pierde ese estado, se reinicia el contador. El saldo real y los cargos se consultan en ReefAPI. Si no se configura la clave, el bot conserva la búsqueda pública anterior como último recurso.

### Sesión personal de One Map (legado)

En el Mac, ejecuta `npm run onemap:login`. Inicia sesión tú mismo en la ventana de One Map y completa cualquier verificación. Al volver al terminal y pulsar Enter, el script comprueba que se puede abrir el área privada en un navegador nuevo. Guarda la sesión en `.onemap/storage-state.json`, con permisos de lectura solo para el usuario; el directorio está excluido de Git.

Para activar la sesión en GitHub Actions, guarda el contenido de ese archivo codificado en Base64 como secreto del repositorio `ONEMAP_STORAGE_STATE_B64`. Nunca subas el JSON ni su Base64 a un commit, una incidencia o un chat: cualquiera que tenga la sesión podría acceder a la cuenta. El workflow comprueba la sesión en Chromium con una pantalla virtual antes de cada ejecución; las búsquedas públicas también usan esa pantalla virtual. One Map responde HTTP 403 en Chromium sin pantalla en las pruebas locales. Si la comprobación falla, esa ejecución no usa la sesión y sigue con las búsquedas públicas; también envía un aviso por Telegram como máximo una vez cada 20 horas. Renueva el secreto si caduca; si el error solo ocurre en el VPS, revisa el acceso desde ese servidor. El estado de la cuenta se muestra en `/api/status` como `oneMapAccountStatus`.

El bot solo recomienda una puja máxima cuando encuentra comparables del mismo modelo y talla en la base de Vestiaire de Luxury Hunter. Calcula el límite para conservar al menos 300 € de beneficio neto (`AUCTION_MIN_PROFIT_EUR`), después de la compra, proxy, envíos, aduana, IVA de importación, comisión de reventa e IVA del margen. Si faltan comparables, la subasta queda en revisión sin precio máximo ni aviso de puja. Las cifras de envío y aduana son estimaciones editables en Ajustes → Costes → Yahoo Auctions vía One Map; confirma el coste final en One Map antes de pujar. El bot no presenta pujas automáticamente.

## Novedad: coste importado a España

Cada anuncio muestra ahora dos precios separados:

- **Precio del producto**: conversión directa del anuncio a EUR con el FX de Luxury Hunter.
- **Precio final importado**: producto + envío doméstico + agente/proxy + envío internacional + arancel + IVA de importación + gestión aduanera/courier + autenticación + otros costes configurados.

Los costes se configuran por fuente en **Configuración → Coste de importación a España**. El cálculo es determinista y se hace en Luxury Hunter, no se deja a Gemini. Los valores iniciales son estimaciones editables. El arancel puede variar por clasificación/material/origen y debe verificarse antes de una compra real.

# Luxury Hunter v1.4 — Technical Execution Inspector

This update adds a technical inspector so every task/run can be audited from the UI.

## New in v1.4

- `Ver código` on each configured task: previews the exact generated marketplace queries, effective limits, filters, connector calls, Gemini model/instruction/criteria, scheduler and email thresholds.
- `Ver ejecución` on an active or historical run: shows the snapshot of the task that actually ran, not just the current edited task.
- Live source state while a run is executing. The inspector refreshes automatically every 2.5 seconds.
- Bunjang displays the exact CLI commands used.
- Xianyu displays the exact temporary-task HTTP payload and request sequence used by Luxury Hunter.
- Japan/Buyee displays the exact search URLs requested.
- Gemini displays the central instruction, selected model, image-analysis flag, and the task-specific AI criteria.
- Full technical execution manifest is available as JSON and can be copied.
- Secrets such as `GEMINI_API_KEY` and SMTP passwords are never exposed by the inspector.

## Update existing install

Stop Luxury Hunter, copy the update over `~/luxury-hunter`, then run `npm install` and `npm start`. Existing `.env`, database, tasks and results remain untouched.

## v1.4.1 fixes

- Fixes Xianyu ingestion for the current nested Chinese result schema (`商品信息`, `卖家信息`).
- Filters Xianyu result records to the temporary task name so historical records from the same keyword do not contaminate a live search.
- Adds per-query rejection counters for Xianyu (`staleTask`, `missingCoreFields`, `invalidPrice`, `belowMin`, `aboveMax`).
- Buyee zero-results now includes a warning when no product cards were actually extracted; a zero extraction is no longer treated as proof of zero inventory.
- Adds `npm run browsers:install` for the Chromium binary required by Bunjang/Playwright after dependency updates.


## v1.4.2 — Spanish rejection reasons

- Gemini now returns `decision_reasons_es`: 1–4 concise reasons in Spanish for every decision.
- REJECT results show a visible “Por qué se ha rechazado” box with bullet points.
- Existing REJECT analyses are backfilled on startup using their structured fields, so the section appears without having to re-run every old listing.
- Reanalyzing an existing listing asks Gemini for more specific Spanish reasons and replaces the fallback reasons.

## GitHub Actions mode (v1.5)

- `npm run cloud:export` exports task/economics configuration to `cloud/config.json`.
- `.github/workflows/luxury-hunter.yml` runs every 3 hours (minute 17) and can also be started manually.
- The SQLite state is persisted between ephemeral runners using a short-retention workflow artifact.
- `npm run cloud:encrypt-xianyu` encrypts the Xianyu login state before it is committed to a private repository.

## v1.6 — Velocidad y fiabilidad

- **Avisos inmediatos**: cada STRONG BUY / BUY verificado se avisa al momento por email (y por Telegram si existen los secretos `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`), sin esperar al resumen de 3 h. Nunca se repite el aviso de un mismo anuncio. Variables: `INSTANT_ALERT_DECISIONS` (por defecto `STRONG BUY,BUY`), `INSTANT_ALERT_MIN_PROFIT_EUR`, `INSTANT_ALERTS=0` para desactivar.
- **Alertas de salud**: si Gemini se queda sin créditos/cuota, si todos los análisis fallan o si una fuente deja de responder, llega un email "⚠️ Luxury Hunter necesita atención" (Gemini: como mucho cada 6 h; fuentes: cada 24 h). El resumen de 3 h marca en rojo las ejecuciones fallidas.
- **Frescura**: los anuncios sin fecha de publicación (Komehyo, Rakuma...) ya no se descartan si Luxury Hunter los ve por primera vez dentro de la ventana.
- **IA con OpenAI**: si existe `OPENAI_API_KEY` se usa OpenAI (Responses API); si no, Gemini (`AI_PROVIDER=openai|gemini` para forzar). Análisis completo con `OPENAI_MODEL` (por defecto `gpt-6.1-sol`) y triaje con `OPENAI_TRIAGE_MODEL` (por defecto `gpt-6-luna`). La búsqueda de mercado usa la búsqueda web de OpenAI limitada a las webs de reventa de confianza. Google Lens (SerpApi) y Cloud Vision no cambian.
- **Coste mínimo**: primero un *triaje* barato (una sola llamada de texto por tarea con hasta 40 anuncios) puntúa cada anuncio; solo los que superan `AI_TRIAGE_MIN_SCORE` (60) pasan al análisis completo, como mucho `AI_MAX_ITEMS_PER_TASK_RUN` (5) por ejecución, ordenados por puntuación y precio frente a la mediana de la tarea. Lo descartado en el triaje no se vuelve a pagar. `AI_TRIAGE=0` lo desactiva.
- **Informe diario**: el resumen se envía una vez al día, en la primera ejecución a partir de `DIGEST_DAILY_HOUR` (9:00, Europe/Madrid). `DIGEST_SCHEDULE=interval` vuelve al modo de cada 3 h. Los avisos inmediatos de STRONG BUY/BUY siguen llegando al momento.
- **Pre-filtro**: títulos con términos de réplica o "solo accesorio" se descartan sin llamar a Gemini.
- **Nube más rápida**: `TASK_CONCURRENCY` (por defecto 3) ejecuta varias tareas a la vez. `LOOP_MINUTES` repite ciclos dentro de una misma ejecución (cada `CYCLE_MIN_MINUTES`, por defecto 20) y `SELF_CHAIN=true` encadena la siguiente ejecución al terminar. Se configuran como *variables* del repositorio en GitHub.
- **Sesión de Xianyu que se renueva sola**: `npm run xianyu:login` abre Chromium para iniciar sesión una vez en Goofish y cifra la sesión en `cloud/xianyu-state.enc`. En cada ejecución en la nube, `scripts/xianyu-keepalive.mjs` visita Goofish con la sesión, guarda las cookies renovadas (cifradas) en el estado persistente y la siguiente ejecución usa la más reciente. Si caduca o Goofish pide verificación anti-bot, llega una alerta "⚠️ Luxury Hunter necesita atención" con el comando para renovarla.

### Varias cuentas de Xianyu

La cuenta actual `Nil` sigue siendo la principal. Para añadir otra cuenta, ejecuta
`npm run xianyu:login -- cuenta-02` en tu Mac y completa tú mismo el inicio de
sesión en la ventana de Chromium. Repite con `cuenta-03`, etc. Cada nombre usa
un perfil y un fichero de sesión separados. El script guarda el estado local en
`~/ai-goofish-monitor-wangdaguo/state/<nombre>.json` y cifra una copia en
`cloud/xianyu-accounts/<nombre>.enc`. Usa la misma contraseña de cifrado que
`XIANYU_STATE_PASSWORD` de GitHub y sube solo los ficheros `.enc`.

En modo directo, Luxury Hunter usa la cuenta activa mientras funcione. Si la
sesión caduca, prueba la siguiente cuenta disponible una sola vez y conserva
la que responde. En tareas `Automática`, si todas las sesiones caducan, intenta
la búsqueda pública de Goofish sin sesión; solo devuelve los anuncios que la web
muestre públicamente y no garantiza acceso a todos los anuncios. Si la búsqueda
pública exige iniciar sesión, Xianyu se pausa y pide renovar una cuenta. Una
verificación de seguridad pausa las búsquedas de Xianyu; no activa una reserva
para eludirla. Las tareas con cuenta fija siguen usando solo esa cuenta. Las
demás fuentes continúan funcionando.
`Configuración` muestra las cuentas detectadas sin mostrar cookies. La opción
de cuenta fija en una tarea usa solo esa cuenta; `Automática` permite la reserva.

### Xianyu: búsquedas desde el Chrome del Mac

Xianyu es hoy la única fuente activa (`ACTIVE_SOURCES=xianyu`). Con `XIANYU_VIA_MAC` el bot busca desde el Chrome del Mac mediante la extensión «Luxury Hunter Mac local»: `only` (solo el Mac; si Xianyu pide una verificación, el bot espera `XIANYU_MAC_HOLD_MIN` minutos sin insistir), `prefer` (el Mac y, si no está conectado, la cuenta del servidor) u `off`.

El bot ordena por «más nuevos», aplica el rango de precio de la tarea y una ventana máxima de 24 horas por fecha real de publicación (`XIANYU_SEARCH_MAX_AGE_HOURS`). Descarta resultados sin imagen, señal de vendedor o fecha de publicación, y no sustituye una fecha desconocida por la hora en que se encontró el anuncio. La etiqueta `验货宝` se comprueba en cada anuncio; el texto libre del vendedor no cuenta como prueba. Los anuncios añadidos manualmente solo se pueden abrir si ya aparecieron en una búsqueda.

## v1.7 — Más mercados y costes por origen

- **Rakuten Ichiba** (API oficial; secretos `RAKUTEN_APP_ID`, `RAKUTEN_ACCESS_KEY`): tiendas japonesas de lujo de segunda mano (Brand Off, Komehyo, Daikokuya, 2nd Street…). Usa las consultas en japonés de cada tarea.
- **eBay** (Browse API oficial; secretos `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`): Alemania, Francia, Italia, España, Reino Unido y EE. UU. (`EBAY_MARKETPLACES`). Solo artículos de segunda mano; la aduana se calcula según el país desde el que se envía.
- **Costes por origen**: eBay UE sin aduana ni IVA de importación (+30 € de autenticación estimada); Reino Unido y EE. UU. como país tercero; arancel 3,7 % automático para lona/nailon (Monogram, Damier, Tessuto…). `IMPORT_VAT_MODE=deductible` deja de sumar el IVA de importación al coste (solo si tu empresa lo deduce; confírmalo con tu gestor).
- Bunjang ya no bloquea el servidor, Xianyu se ejecuta de una búsqueda en una, el estado persistente vuelve a guardarse (`lh-upload/`) y el workflow muestra los logs del buscador de Xianyu.
- Vinted, Vestiaire, Wallapop y Catawiki no tienen API pública y prohíben bots: se cubren con sus alertas de búsqueda guardada (ver `private/busquedas-guardadas.md`, que no se sube al repo público).

## Control de gasto de IA

- Triaje y análisis previo con `gpt-6-luna` (razonamiento `none`/`low`, fotos en baja resolución); solo la verificación de candidatos serios (BUY/STRONG BUY o WATCH ≥ `VERIFY_WATCH_MIN_SCORE`) usa `gpt-6.1-sol` con razonamiento `low`.
- `AI_DAILY_BUDGET_USD` (por defecto 1 $/día, hora de Madrid): al alcanzarlo se deja de analizar hasta el día siguiente y llega un aviso. El gasto del día aparece en el informe diario.
- Ajustes finos: `OPENAI_SCREEN_MODEL`, `OPENAI_SCREEN_EFFORT`, `OPENAI_VERIFY_EFFORT`, `OPENAI_TRIAGE_EFFORT`, `OPENAI_IMAGE_DETAIL`.

## Modelos y avisos estrictos (2026-10)

- 21 modelos: los 11 originales + Louis Vuitton Pochette Accessoires, LV × Murakami Multicolore, Fendi Spy, Miu Miu Wander/Arcadie, Balenciaga Rodeo, Alaïa Le Teckel, Lady Dior, Loewe Puzzle, Hermès Evelyne y Gucci Horsebit.
- El aviso inmediato solo salta si el anuncio supera la puntuación y el beneficio mínimos de su modelo (`notify_min_score`, `notify_min_profit_eur`), deja al menos `INSTANT_ALERT_MIN_MARGIN_PCT` (30 %) de margen sobre el coste puesto en España y su reventa está contrastada con anuncios reales del mercado (`INSTANT_ALERT_REQUIRE_MARKET`). El resto aparece solo en el informe diario.
