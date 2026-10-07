# Zara add-to-cart feasibility — 2026-10-06

В MVP add-to-cart и автоматическая покупка не выполняются. В интерфейсе StoreProvider оставлена опциональная точка расширения `addToCart(session, variantId)`.

## Что установлено

- Storefront route корзины: `https://www.zara.com/pl/pl/shop/cart` (реальная ссылка сайта).
- Product variant identifier — `detail.colors[].sizes[].sku`, не size name, не parent product ID. Пример SKU M у анорка: 545467254.
- Web frontend config: WCS base URL `itxrest`, default version 1; storefront base URL `api/storefront`, clientId `web-za`.
- Исследованные reference-проекты не реализуют HTTP добавление в корзину; турецкий проект проверяет только DOM-кнопку add-to-cart.

## Что требует отдельного наблюдения сетевого запроса

POST endpoint добавления, точный body, список обязательных cookies, CSRF/header tokens и срок серверной сессии не установлены. Route `/shop/cart` нельзя считать POST API. Не следует придумывать `/cart/add` или использовать неподтверждённый WCS endpoint. Для следующей фазы нужен захват штатного добавления собственного тестового товара через Zara UI, затем проверка HTTP replay без оплаты. Содержимое персональной корзины и credentials не сохраняются в репозиторий.

Обычная корзина может иметь гостевой контекст, но наличие конкретного guest HTTP flow, необходимость login и возможность повторно использовать session для POST здесь не подтверждены. В отличие от чтения product details, мутация может требовать additional CSRF/session tokens. Срок жизни cookies не равен сроку жизни серверной корзины; его нужно проверять экспериментально.

Сохранение пользовательской сессии технически возможно только отдельным opt-in механизмом с шифрованием, истечением и отзывом; передавать одну общую сессию разным пользователям нельзя. Активные cookies следует рассматривать как credentials. Anti-bot: реально наблюдались 403 на HTTP/headless и в последовательном чтении API; это препятствует обещанию стабильного POST replay. Proxy/IP и browser context могут влиять на доступ.

До подтверждения endpoint, auth, CSRF и срока сессии provider метод addToCart не реализует. Банковские карты, CVV и платёжные данные не принимаются и не хранятся.
