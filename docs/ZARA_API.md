# Zara Poland API research — 2026-10-06

Источники изучены до реализации:

- https://github.com/diwakarbhatt123/ZaraPriceNotifier — `src/services/zaraClient.js`, `stockService.js`: product details + availability, Puppeteer с постоянной сессией, SQLite. Для нашего проекта не копировался код. Не перенесены logging cookies/body и process.exit на 403.
- https://github.com/enesdolgun10/Zara-Firsat-Avcisi — `helpers/price_extractor.py`, `stock_checker.py`, `analyser.py`: Selenium, чтение DOM цены и размеров, новая browser session для товара. Полезна логика сравнения baseline/price/restock; для масштабирования не подходит.

## Наблюдения в реальной Zara PL

В браузере получены HTTP 200:

- `GET /pl/pl/category/2417772/products?ajax=true` — каталог курток: названия, SEO URL, color product IDs, цена и изображения; размеров в каталоговом ответе нет.
- `GET /pl/pl/products-details?productIds=545470428&ajax=true` — полная карточка с цветами и SKU, цена 21900 (219 PLN), XS–XXL, `coming_soon` и `in_stock`.
- `GET /pl/pl/skorzana-kurtka-bomberka-ze-stojka-p06318252.html?v1=599226858&v2=2417772&ajax=true` — JSON страницы с полем `product`; позволяет разрешить ссылки без `v1`.
- `GET /pl/pl/product/id/599226858/extra-detail?ajax=true` — дополнительные описания, не нужен мониторингу.

Реальный обезличенный ответ details сохранён в `tests/fixtures/zara-details.json`. Он не содержит cookies или auth. `clientAppConfig.formatterConfig.currencyDecimals=-2`, currency=PLN. Product parent `id` отличается от color `productId`; именно `v1` / color productId — внешняя идентичность отслеживаемого товара. SKU: `detail.colors[].sizes[].sku`. Price: color.price, затем size.price; oldPrice опционально. URL изображения: xmedia[].extraInfo.deliveryUrl. Доступны статусы `in_stock`, `low_on_stock`, `out_of_stock`, `coming_soon`, `back_soon`; неизвестные статусы приводят к ошибке, а не ложному отсутствию.

В первом reference также найден endpoint:
`GET /itxrest/1/catalog/store/{storeId}/product/id/{colorProductId}/availability`.
Он не нужен, пока full details возвращает актуальное `sizes[].availability`; не добавляем второй запрос каждому товару. Его работоспособность для текущего PL storefront отдельно не подтверждена. Не следует копировать UK storeId 10706. Public storefront имеет `/api/storefront` и clientId `web-za`; это обнаруженные настройки, не готовый контракт интеграции.

## HTTP и browser

Прямой curl / Node fetch получил 403, включая HTTP с browser cookies. Обычный Chromium с локальной сессией первоначально получил details HTTP 200; headless — 403. Provider поддерживает HTTP и browser transport (один Chromium на процесс), а также источники API и page. Первоначальная попытка browser + API выполняла JSON-запросы через fetch, но оказалась нестабильной. Итоговая проверенная конфигурация browser + page описана ниже и открывает карточки в переиспользуемых страницах.

403: global cooldown 5 min, не завершать процесс. 429: global exponential cooldown + Retry-After. 5xx/timeouts: до 3 попыток с jitter/backoff. Invalid JSON и schema changes не перезаписывают состояние. Ограничиваются скорость, concurrency и timeout. Дополнительно product-level backoff сохраняется в PostgreSQL.

## Проверка стабильности

Первый проход: 5 продуктов успешно, шестой — 403; после этого запросы прекращены. Это не считается прохождением теста 20 товаров. Актуальный машинный отчёт: `live-test-results.json`. Mock load показывает производительность внутреннего pipeline, не пропускную способность Zara. Cookies ограничены временем/IP/браузером; текущая сессия не обещает долгосрочную стабильность на другом VPS.

## Рабочий способ — 2026-10-07

Прямой HTML GET тоже может вернуть HTTP 200 с `_sec/verify` вместо товара. Проверка статуса недостаточна. В HTML настоящей карточки обнаружено `window.zara.viewPayload = { ... }` с полным `product`, color price и size availability. Обычный Playwright Chromium с оригинальным User-Agent и пустой сессией успешно открывает карточки. Provider берёт HTML после появления payload и извлекает JSON сбалансированным parser, не выполняя script. Это browser fallback после подтверждённых отказов HTTP/API; Chrome не запускается заново для каждого товара, pages переиспользуются.

Native browser + page проверил 20/20 реальных продуктов с действующими ценами и SKU. Cookies больше не требуются в тестовой конфигурации. `ZARA_DATA_SOURCE=page`, `ZARA_TRANSPORT=browser`, `ZARA_BROWSER_HEADLESS=false`. В контейнере обычный Chromium использует Xvfb. Прямая API batch-проверка `productIds=id1,id2,...` получила 403; поддержку batch не считаем установленной и не заявляем как работающую. Реальный HTML fixture (только product, без сессии) сохранён в `tests/fixtures/zara-page-product.json`.

Текущий `/health` содержит lastSuccessAt, lastError, lastHttpStatus и nextRetryAt отдельно для Zara. HTTP 200 с challenge не становится успешным состоянием.

Docker + page также проверил 20/20 товаров. Пул ограничен двумя параллельными страницами (`ZARA_MAX_BROWSER_PAGES=2`), чтобы холодный запуск десяти страниц не перегружал Chromium. При непрерывном мониторинге каждый из 20 товаров успешно проверен минимум четыре раза: 84 успешные проверки, ноль ошибок в зафиксированном интервале. Интервалы между проверками составили 61–89 секунд при настройке 60 секунд; время запроса и ожидание пула добавляются к интервалу. После рестарта app все 20 подписок сохранились, все 20 товаров снова проверены. Это проверка локального Docker; нагрузка на 200 товаров проверена отдельно с mock provider и не доказывает такую пропускную способность реальной Zara.
