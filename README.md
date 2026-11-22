# Northline - E-Commerce Product Catalog and Interactive Shopping Cart

A complete demo online store built with plain HTML, CSS and JavaScript (no frameworks, no build step, no API key). Product data comes from [FakeStoreAPI](https://fakestoreapi.com/products).

## Features

**Catalog**
- Live product data fetched from FakeStoreAPI with `fetch()` and `async/await`
- Product cards with image, price, star rating, review count and badges ("Top rated", "Popular", "Under $25") worked out from the real data
- Category filters: Electronics, Jewelry, Clothing (men's and women's clothing are combined), with product counts
- Search across title, description and category, with a `/` keyboard shortcut
- Sort by featured, top rated, most reviewed, price (both ways) or name
- Max price slider, "Reset filters" button, and friendly empty states
- Quick-view popup with description and quantity picker
- Save-for-later hearts with a "saved only" view
- Loading skeletons while data downloads

**Cart**
- Slide-out cart drawer with a live item counter on the navbar
- `addToCart()`, `removeFromCart()`, `updateQuantity()` and `calculateTotal()`
- Quantity + and - (minus at 1 removes the item, with an Undo message)
- Subtotal, promo discount, shipping, 8% tax and total
- Free shipping over $100 with a progress bar
- Promo codes: `WELCOME10` (10% off items) and `FREESHIP`
- Cart, promo code, saved items and theme are remembered in `localStorage`

**Checkout**
- Checkout dialog with form validation (name, email, phone, address, city, postal code)
- Simulated payment (no card numbers are ever collected)
- Order confirmation with order number, delivery estimate and receipt summary

**Quality**
- Responsive CSS Grid layout for phone, tablet and desktop
- Light and dark mode
- Keyboard friendly: Esc closes popups, focus is trapped inside them, visible focus rings
- Error handling for network failure, timeout, server errors and unexpected data, with a Retry button
- If the API is down, the last good copy of the catalog is shown from the browser cache

## Run it

You do not need an API key.

1. Unzip the folder.
2. Double-click `index.html`, or open the folder in VS Code and use the **Live Server** extension (right-click `index.html`, then **Open with Live Server**).

Step-by-step help for beginners is in `START-HERE.txt`.

## Project structure

```
northline-store/
├── index.html      Page structure: header, hero, catalog, cart drawer, dialogs
├── style.css       Design tokens, light/dark themes, layout, animations
├── script.js       All logic (see sections below)
├── README.md       This file
└── START-HERE.txt  Beginner guide
```

`script.js` is divided into numbered sections:

| Section | What it does |
|---|---|
| 1. Configuration | API URL, tax rate, shipping rules, promo codes, category names |
| 2. Utilities | Safe HTML escaping, currency formatting, safe `localStorage` |
| 3. Catalog API | `fetchCatalog()` downloads data; `normalizeProduct()` cleans it |
| 4. App state | One `state` object holds products, filters, cart, saved items |
| 5. Cart logic | `addToCart`, `removeFromCart`, `updateQuantity`, `calculateTotal` |
| 6. Rendering | Builds the HTML for cards, hero, cart and summary |
| 7. Dialogs and toasts | Native `<dialog>` handling and small pop-up messages |
| 8. Checkout | Validation, fake order placement, confirmation screen |
| 9. Events | One delegated click handler per area |
| 10. Start-up | Loads saved data, then the catalog |

## How the data works

The store makes one request:

```
GET https://fakestoreapi.com/products
```

Each product looks like this:

```json
{ "id": 1, "title": "...", "price": 109.95, "description": "...",
  "category": "men's clothing", "image": "https://...",
  "rating": { "rate": 3.9, "count": 120 } }
```

FakeStoreAPI has four categories (`electronics`, `jewelery`, `men's clothing`, `women's clothing`). The shop maps them to three: Electronics, Jewelry and Clothing. You can change this in `CONFIG.CATEGORY_MAP`.

## How the money maths works

Prices are converted to whole **cents** (integers) before any calculation, so there are no floating point errors. The order is:

```
subtotal   = sum of (price x quantity)
discount   = subtotal x promo percent        (if a percent promo is applied)
shipping   = $9.99, or free if (subtotal - discount) >= $100 or FREESHIP is applied
tax        = (subtotal - discount) x 8%
total      = subtotal - discount + shipping + tax
```

Example: one item at $15.99 gives $15.99 + $9.99 shipping + $1.28 tax = **$27.26**.

## Customise it

All settings are at the top of `script.js` in `CONFIG`:

- `TAX_RATE`, `SHIPPING_FLAT_CENTS`, `FREE_SHIPPING_FROM_CENTS`
- `MAX_QTY_PER_ITEM`
- `PROMO_CODES` (add your own, for example `{ SAVE20: { type: "percent", value: 20, label: "20% off" } }`)
- `API_URL` (any API that returns the same product shape)

Colours and fonts are CSS variables at the top of `style.css`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "We could not load the catalog" | Check your internet connection and press **Try again** |
| Blue banner says "Showing a saved copy" | The live API failed, so the last good copy is used. Press **Try again** later |
| Product pictures are blank | Your network may block `fakestoreapi.com` images. A grey placeholder is shown instead |
| Page looks unstyled | `index.html`, `style.css` and `script.js` must be in the same folder |
| Cart is empty after reopening | Browser privacy mode or blocked site data stops `localStorage` from saving |
| Want a fresh start | Open DevTools (F12) > Application > Local Storage > clear the `northline.*` entries |

## Notes

- This is a demo. Orders are simulated, nothing is charged, and no personal data leaves the browser.
- Product images load from FakeStoreAPI and are used for demonstration only.
