# Luxury Hunter v1.4.3

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

### Just One API para Xianyu

Luxury Hunter usa [Product Search V1](https://docs.justoneapi.com/en/api/xianyu-goofish/product-search-v1)
y [Product Details V1](https://docs.justoneapi.com/en/api/xianyu-goofish/product-details-v1)
de Just One API para buscar anuncios y consultar sus fichas. La búsqueda envía
`keyword`, `page` y `sort`; la ficha envía `itemId`. Ambas usan un token privado.

En GitHub, crea el secreto de Actions `JUSTONEAPI_TOKEN` con el token de tu cuenta.
El workflow selecciona Just One API por defecto y no inicia las sesiones de
navegador de Xianyu. Si ya existe una variable `XIANYU_PROVIDER`, ponla en
`justoneapi`. Para usar el flujo local con sesión, establece `XIANYU_PROVIDER=direct`.

En una instalación local, añade a `.env`:

```dotenv
XIANYU_PROVIDER=justoneapi
JUSTONEAPI_TOKEN=tu_token
```

Con Just One API, Luxury Hunter hace por defecto una consulta cada seis horas
y abre hasta cuatro fichas por hora. El modo directo en la nube conserva su
ritmo anterior de dos consultas cada tres horas. Ajusta `XIANYU_MIN_INTERVAL_MIN`,
`XIANYU_MAX_QUERIES`, `XIANYU_DETAIL_PER_HOUR` y `XIANYU_JUSTONE_SORT` según tu
plan. Just One API es un proveedor externo: consulta sus cuotas y cargos antes
de activarlo. Los errores se registran sin detener las demás fuentes.

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
