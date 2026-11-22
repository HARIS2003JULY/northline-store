/* ==========================================================
   Northline storefront - application logic (vanilla JavaScript)

   Sections
     1. Configuration (safe to edit)
     2. Utilities
     3. Catalog API (FakeStoreAPI) and data cleaning
     4. App state
     5. Cart logic   (addToCart, removeFromCart, updateQuantity, calculateTotal)
     6. Rendering
     7. Dialogs and toasts
     8. Checkout
     9. Events
    10. Start-up

   Money is kept in whole cents (integers) so quantity and tax maths never
   suffers from floating point errors such as 0.1 + 0.2 = 0.30000000000000004.
   ========================================================== */
"use strict";

(function () {
  /* ---------------------------------------------------------
     1. Configuration
     --------------------------------------------------------- */
  const CONFIG = {
    API_URL: "https://fakestoreapi.com/products",
    REQUEST_TIMEOUT_MS: 10000,

    TAX_RATE: 0.08,                  // 8% sales tax
    SHIPPING_FLAT_CENTS: 999,        // $9.99 shipping...
    FREE_SHIPPING_FROM_CENTS: 10000, // ...free once the items reach $100.00
    MAX_QTY_PER_ITEM: 10,

    PROMO_CODES: {
      WELCOME10: { type: "percent", value: 10, label: "10% off your items" },
      FREESHIP: { type: "shipping", label: "Free shipping" },
    },

    // FakeStoreAPI category names mapped to the three shop categories.
    CATEGORY_MAP: {
      "electronics": "Electronics",
      "jewelery": "Jewelry",
      "jewelry": "Jewelry",
      "men's clothing": "Clothing",
      "women's clothing": "Clothing",
    },
    CATEGORY_ORDER: ["Electronics", "Jewelry", "Clothing"],
  };

  const KEYS = {
    cart: "northline.cart",
    promo: "northline.promo",
    saved: "northline.saved",
    theme: "northline.theme",
    cache: "northline.catalog",
  };

  /* ---------------------------------------------------------
     2. Utilities
     --------------------------------------------------------- */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /** Escape text before it goes into HTML (text or attribute values). */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  }

  const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const fmt = (cents) => currency.format(cents / 100);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const prefersReducedMotion = () =>
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /** localStorage wrapper that never throws (private mode, quota, disabled). */
  const store = {
    get(key, fallback) {
      try {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
    },
    remove(key) {
      try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
    getJSON(key, fallback) {
      try {
        const parsed = JSON.parse(this.get(key, "null"));
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch (e) { return fallback; }
    },
    setJSON(key, value) { this.set(key, JSON.stringify(value)); },
  };

  const PLACEHOLDER_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#eef0f5"/>' +
    '<path d="M30 80l22-26 16 18 10-12 12 20z" fill="#c4c9d6"/><circle cx="44" cy="42" r="8" fill="#c4c9d6"/></svg>'
  );

  /* ---------------------------------------------------------
     3. Catalog API and data cleaning
     --------------------------------------------------------- */
  const CATALOG_ERRORS = {
    NETWORK: "We could not reach the catalog. Check your internet connection.",
    TIMEOUT: "The catalog took too long to answer.",
    SERVER: "The catalog service is having trouble right now.",
    UNEXPECTED: "The catalog came back in a format we did not expect.",
  };

  class CatalogError extends Error {
    constructor(code) {
      super(CATALOG_ERRORS[code] || CATALOG_ERRORS.UNEXPECTED);
      this.name = "CatalogError";
      this.code = CATALOG_ERRORS[code] ? code : "UNEXPECTED";
    }
  }

  /** Download the raw product list. Network and HTTP problems become CatalogError. */
  async function fetchCatalog() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new CatalogError("NETWORK");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(CONFIG.API_URL, { signal: controller.signal });
    } catch (err) {
      throw new CatalogError(err && err.name === "AbortError" ? "TIMEOUT" : "NETWORK");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new CatalogError(response.status >= 500 ? "SERVER" : "UNEXPECTED");

    let data;
    try { data = await response.json(); } catch (err) { throw new CatalogError("UNEXPECTED"); }
    if (!Array.isArray(data)) throw new CatalogError("UNEXPECTED");
    return data;
  }

  const titleCase = (text) => text.replace(/\b\w/g, (c) => c.toUpperCase());

  /** Turn one raw API product into the shape the UI uses. Returns null if unusable. */
  function normalizeProduct(raw, index) {
    const valid = raw && Number.isFinite(Number(raw.id)) && typeof raw.title === "string"
      && Number.isFinite(Number(raw.price)) && Number(raw.price) >= 0;
    if (!valid) return null;

    const rawCategory = String(raw.category || "").toLowerCase().trim();
    const price = Number(raw.price);
    const rate = Number(raw.rating && raw.rating.rate) || 0;
    const count = Number(raw.rating && raw.rating.count) || 0;
    const product = {
      id: Number(raw.id),
      title: raw.title.trim(),
      price,
      cents: Math.round(price * 100),
      description: String(raw.description || "No description available."),
      category: CONFIG.CATEGORY_MAP[rawCategory] || (rawCategory ? titleCase(rawCategory) : "Other"),
      image: /^https?:\/\//i.test(String(raw.image || "")) ? raw.image : PLACEHOLDER_IMG,
      rate,
      count,
      order: index,
    };
    product.badges = computeBadges(product);
    return product;
  }

  /** Badges are derived from real data, never invented. */
  function computeBadges(p) {
    const badges = [];
    if (p.rate >= 4.5) badges.push({ label: "Top rated", tone: "gold" });
    if (p.count >= 300) badges.push({ label: "Popular", tone: "brand" });
    if (p.cents < 2500) badges.push({ label: "Under $25", tone: "green" });
    return badges.slice(0, 2);
  }

  function normalizeCatalog(rawList) {
    const products = rawList.map(normalizeProduct).filter(Boolean);
    if (products.length === 0) throw new CatalogError("UNEXPECTED");
    return products;
  }

  /* ---------------------------------------------------------
     4. App state
     --------------------------------------------------------- */
  const state = {
    products: [],
    byId: new Map(),
    loaded: false,
    priceCeilCents: 0,
    filters: { category: "All", query: "", sort: "featured", maxCents: null, savedOnly: false },
    cart: [],          // [{ id, title, cents, image, qty }]
    promo: null,       // promo code string or null
    saved: new Set(),  // wishlist product ids
    lastRemoved: null, // for the Undo button
  };

  const SORTS = {
    featured: (a, b) => a.order - b.order,
    rating: (a, b) => b.rate - a.rate || b.count - a.count,
    reviews: (a, b) => b.count - a.count,
    "price-asc": (a, b) => a.cents - b.cents,
    "price-desc": (a, b) => b.cents - a.cents,
    name: (a, b) => a.title.localeCompare(b.title),
  };

  const els = {
    html: document.documentElement,
    searchForm: $("#searchForm"),
    searchInput: $("#searchInput"),
    clearSearch: $("#clearSearch"),
    savedBtn: $("#savedBtn"),
    savedCount: $("#savedCount"),
    themeBtn: $("#themeBtn"),
    cartBtn: $("#cartBtn"),
    cartCount: $("#cartCount"),
    topRatedBtn: $("#topRatedBtn"),
    heroStats: $("#heroStats"),
    heroStack: $("#heroStack"),
    resultMeta: $("#resultMeta"),
    chips: $("#categoryChips"),
    priceRange: $("#priceRange"),
    priceOut: $("#priceOut"),
    sortSelect: $("#sortSelect"),
    statusBanner: $("#statusBanner"),
    grid: $("#productGrid"),
    stateBox: $("#stateBox"),
    cartDrawer: $("#cartDrawer"),
    cartDrawerCount: $("#cartDrawerCount"),
    shipMeter: $("#shipMeter"),
    cartItems: $("#cartItems"),
    cartFooter: $("#cartFooter"),
    promoForm: $("#promoForm"),
    promoInput: $("#promoInput"),
    promoMsg: $("#promoMsg"),
    summary: $("#summary"),
    checkoutBtn: $("#checkoutBtn"),
    clearCartBtn: $("#clearCartBtn"),
    quickView: $("#quickView"),
    qvContent: $("#qvContent"),
    checkoutDialog: $("#checkoutDialog"),
    checkoutContent: $("#checkoutContent"),
    toasts: $("#toasts"),
  };

  /* ---------------------------------------------------------
     5. Cart logic
     --------------------------------------------------------- */
  const cartQuantity = () => state.cart.reduce((sum, line) => sum + line.qty, 0);
  const qtyInCart = (id) => {
    const line = state.cart.find((l) => l.id === id);
    return line ? line.qty : 0;
  };

  function persistCart() {
    store.setJSON(KEYS.cart, state.cart);
    if (state.promo) store.set(KEYS.promo, state.promo); else store.remove(KEYS.promo);
  }

  /** Add `qty` of a product. Returns true if something was added. */
  function addToCart(product, qty = 1) {
    const line = state.cart.find((l) => l.id === product.id);
    const current = line ? line.qty : 0;
    const next = clamp(current + qty, 1, CONFIG.MAX_QTY_PER_ITEM);
    if (next === current) {
      toast(`You can buy up to ${CONFIG.MAX_QTY_PER_ITEM} of each item.`);
      return false;
    }
    if (line) {
      line.qty = next;
    } else {
      state.cart.push({ id: product.id, title: product.title, cents: product.cents, image: product.image, qty: next });
    }
    cartChanged();
    bumpBadge();
    return true;
  }

  /** Set an exact quantity. Zero or less removes the item. */
  function updateQuantity(id, qty) {
    if (qty <= 0) { removeFromCart(id); return; }
    const line = state.cart.find((l) => l.id === id);
    if (!line) return;
    line.qty = clamp(qty, 1, CONFIG.MAX_QTY_PER_ITEM);
    cartChanged();
  }

  /** Remove an item and offer Undo. */
  function removeFromCart(id) {
    const index = state.cart.findIndex((l) => l.id === id);
    if (index === -1) return;
    const [line] = state.cart.splice(index, 1);
    state.lastRemoved = { line, index };
    cartChanged();
    toast(`Removed "${shorten(line.title, 30)}"`, { action: { label: "Undo", onClick: undoRemove }, duration: 6000 });
  }

  function undoRemove() {
    if (!state.lastRemoved) return;
    const { line, index } = state.lastRemoved;
    state.lastRemoved = null;
    if (!state.cart.some((l) => l.id === line.id)) state.cart.splice(Math.min(index, state.cart.length), 0, line);
    cartChanged();
  }

  function clearCart() {
    state.cart = [];
    state.promo = null;
    cartChanged();
  }

  /**
   * Work out every figure in the order summary, in whole cents.
   * Order of operations: subtotal -> promo discount -> shipping -> tax -> total.
   */
  function calculateTotal(cart = state.cart, promoCode = state.promo) {
    const subtotal = cart.reduce((sum, l) => sum + l.cents * l.qty, 0);
    const promo = promoCode ? CONFIG.PROMO_CODES[promoCode] : null;
    const discount = promo && promo.type === "percent" ? Math.round((subtotal * promo.value) / 100) : 0;
    const discounted = subtotal - discount;
    const freeShipping = (promo && promo.type === "shipping") || discounted >= CONFIG.FREE_SHIPPING_FROM_CENTS;
    const shipping = subtotal === 0 || freeShipping ? 0 : CONFIG.SHIPPING_FLAT_CENTS;
    const tax = Math.round(discounted * CONFIG.TAX_RATE);
    return {
      subtotal, discount, discounted, shipping, tax,
      total: discounted + shipping + tax,
      freeShipping,
      remainingForFree: Math.max(0, CONFIG.FREE_SHIPPING_FROM_CENTS - discounted),
      itemCount: cart.reduce((sum, l) => sum + l.qty, 0),
    };
  }

  function applyPromo(rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!code) return { ok: false, message: "Enter a promo code first." };
    const promo = CONFIG.PROMO_CODES[code];
    if (!promo) return { ok: false, message: "That code is not valid. Try WELCOME10 or FREESHIP." };
    state.promo = code;
    cartChanged();
    return { ok: true, message: `${code} applied: ${promo.label}.` };
  }

  /** Everything that must refresh after the cart changes. */
  function cartChanged() {
    persistCart();
    renderCart();
    syncCardStates();
  }

  function shorten(text, max) {
    return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
  }

  /* ---------------------------------------------------------
     6. Rendering
     --------------------------------------------------------- */
  const ICON = {
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    minus: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    heart: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 20s-7-4.6-9-9.2C1.6 7.3 3.7 4 7 4c2 0 3.4 1 5 3 1.6-2 3-3 5-3 3.3 0 5.4 3.3 4 6.8-2 4.6-9 9.2-9 9.2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function starsHtml(rate) {
    const pct = clamp((rate / 5) * 100, 0, 100).toFixed(0);
    return `<span class="stars" style="--r:${pct}%" role="img" aria-label="${rate.toFixed(1)} out of 5 stars">★★★★★</span>`;
  }

  const ratingHtml = (p) =>
    `<div class="rating">${starsHtml(p.rate)}<b>${p.rate.toFixed(1)}</b><span>(${p.count})</span></div>`;

  const badgesHtml = (p) => p.badges.map((b) => `<span class="badge badge-${b.tone}">${escapeHtml(b.label)}</span>`).join("");

  function cardHtml(p) {
    const saved = state.saved.has(p.id);
    return `
      <article class="card" data-id="${p.id}">
        <div class="card-media">
          <button type="button" class="wish${saved ? " on" : ""}" data-action="wish" aria-pressed="${saved}" aria-label="${saved ? "Remove from saved" : "Save"}: ${escapeHtml(p.title)}">${ICON.heart}</button>
          <div class="badges">${badgesHtml(p)}</div>
          <button type="button" class="media-btn" data-action="quick" aria-label="Quick view: ${escapeHtml(p.title)}">
            <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy" width="240" height="240" data-fallback />
          </button>
        </div>
        <div class="card-body">
          <span class="card-cat">${escapeHtml(p.category)}</span>
          <h3 class="card-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</h3>
          ${ratingHtml(p)}
          <div class="card-foot">
            <span class="price">${fmt(p.cents)}</span>
            <button type="button" class="btn btn-add" data-action="add">Add to cart</button>
          </div>
        </div>
      </article>`;
  }

  function skeletonHtml(count = 8) {
    return Array.from({ length: count }, () => `
      <article class="card skeleton" aria-hidden="true">
        <div class="card-media"></div>
        <div class="card-body"><div class="sk w60"></div><div class="sk w90"></div><div class="sk w90"></div><div class="sk w40"></div></div>
      </article>`).join("");
  }

  /** Apply category, search, price, saved-only filters and the chosen sort. */
  function getVisibleProducts() {
    const { category, query, sort, maxCents, savedOnly } = state.filters;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return state.products
      .filter((p) => category === "All" || p.category === category)
      .filter((p) => maxCents === null || p.cents <= maxCents)
      .filter((p) => !savedOnly || state.saved.has(p.id))
      .filter((p) => {
        if (!terms.length) return true;
        const haystack = `${p.title} ${p.description} ${p.category}`.toLowerCase();
        return terms.every((t) => haystack.includes(t));
      })
      .sort(SORTS[sort] || SORTS.featured);
  }

  function filtersAreActive() {
    const f = state.filters;
    return f.category !== "All" || f.query !== "" || f.savedOnly
      || (f.maxCents !== null && f.maxCents < state.priceCeilCents);
  }

  function renderChips() {
    const counts = new Map();
    state.products.forEach((p) => counts.set(p.category, (counts.get(p.category) || 0) + 1));
    const names = [
      ...CONFIG.CATEGORY_ORDER.filter((c) => counts.has(c)),
      ...[...counts.keys()].filter((c) => !CONFIG.CATEGORY_ORDER.includes(c)),
    ];
    const chip = (name, count) =>
      `<button type="button" class="chip" data-category="${escapeHtml(name)}" aria-pressed="${state.filters.category === name}">${escapeHtml(name)} <span>${count}</span></button>`;
    els.chips.innerHTML = chip("All", state.products.length) + names.map((n) => chip(n, counts.get(n))).join("");
  }

  function renderMeta(shown) {
    if (!state.loaded) { els.resultMeta.textContent = ""; return; }
    els.resultMeta.innerHTML = `Showing ${shown} of ${state.products.length} products` +
      (filtersAreActive() ? ' <button type="button" class="link-btn" data-reset>Reset filters</button>' : "");
  }

  function renderGrid() {
    if (!state.loaded) return;
    const list = getVisibleProducts();
    renderMeta(list.length);

    if (list.length === 0) {
      els.grid.innerHTML = "";
      const onlySaved = state.filters.savedOnly && state.saved.size === 0;
      showStateBox(
        onlySaved ? "Nothing saved yet" : "No products match",
        onlySaved ? "Tap the heart on any product to save it for later." : "Try a different search, category or price limit.",
        { label: onlySaved ? "Browse all products" : "Reset filters", action: "reset" }
      );
      return;
    }
    els.stateBox.hidden = true;
    els.grid.innerHTML = list.map(cardHtml).join("");
    syncCardStates();
  }

  function showStateBox(title, text, button) {
    els.stateBox.hidden = false;
    els.stateBox.innerHTML = `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>` +
      (button ? `<button type="button" class="btn btn-primary" data-state-action="${button.action}">${escapeHtml(button.label)}</button>` : "");
  }

  /** Update add-to-cart labels and wishlist hearts without rebuilding the grid. */
  function syncCardStates() {
    $$(".card[data-id]", els.grid).forEach((card) => {
      const id = Number(card.dataset.id);
      const qty = qtyInCart(id);
      const btn = $(".btn-add", card);
      if (btn) {
        btn.textContent = qty > 0 ? `In cart (${qty})` : "Add to cart";
        btn.classList.toggle("in-cart", qty > 0);
      }
      const wish = $(".wish", card);
      if (wish) {
        const on = state.saved.has(id);
        wish.classList.toggle("on", on);
        wish.setAttribute("aria-pressed", String(on));
      }
    });
    const n = state.saved.size;
    els.savedCount.textContent = n;
    els.savedCount.hidden = n === 0;
  }

  function renderHero() {
    const top = [...state.products].sort(SORTS.rating).slice(0, 3);
    els.heroStack.innerHTML = top.map((p) => `
      <button type="button" class="hero-item" data-id="${p.id}" aria-label="Quick view: ${escapeHtml(p.title)}">
        <div class="thumb"><img src="${escapeHtml(p.image)}" alt="" data-fallback /></div>
        <strong>${escapeHtml(p.title)}</strong>
        <div class="row"><b>${fmt(p.cents)}</b><span>${p.rate.toFixed(1)} ★</span></div>
      </button>`).join("");

    const avg = state.products.reduce((s, p) => s + p.rate, 0) / state.products.length;
    const categories = new Set(state.products.map((p) => p.category)).size;
    els.heroStats.innerHTML = `
      <div><dt>Products</dt><dd>${state.products.length}</dd></div>
      <div><dt>Average rating</dt><dd>${avg.toFixed(1)} / 5</dd></div>
      <div><dt>Categories</dt><dd>${categories}</dd></div>`;
  }

  function renderPriceRange() {
    const ceilDollars = Math.max(1, Math.ceil(Math.max(...state.products.map((p) => p.cents)) / 100));
    state.priceCeilCents = ceilDollars * 100;
    state.filters.maxCents = state.priceCeilCents;
    els.priceRange.max = String(ceilDollars);
    els.priceRange.value = String(ceilDollars);
    els.priceRange.disabled = false;
    els.priceOut.textContent = fmt(state.priceCeilCents);
  }

  function bumpBadge() {
    els.cartCount.classList.remove("bump");
    void els.cartCount.offsetWidth; // restart the animation
    els.cartCount.classList.add("bump");
  }

  /** Cart badge, drawer lines, shipping meter and order summary. */
  function renderCart() {
    const t = calculateTotal();
    els.cartCount.textContent = t.itemCount;
    els.cartCount.hidden = t.itemCount === 0;
    els.cartDrawerCount.textContent = t.itemCount ? `(${t.itemCount})` : "";
    els.cartBtn.setAttribute("aria-label", `Open cart, ${t.itemCount} item${t.itemCount === 1 ? "" : "s"}`);

    if (state.cart.length === 0) {
      els.shipMeter.hidden = true;
      els.cartFooter.hidden = true;
      els.cartItems.innerHTML = `
        <li class="cart-empty">
          <h3>Your cart is empty</h3>
          <p>Add something you like and it will show up here.</p>
          <button type="button" class="btn btn-primary" data-close>Start shopping</button>
        </li>`;
      return;
    }

    // Free shipping progress
    els.shipMeter.hidden = false;
    const pct = clamp((t.discounted / CONFIG.FREE_SHIPPING_FROM_CENTS) * 100, 0, 100);
    els.shipMeter.innerHTML = t.freeShipping
      ? `<strong>You have free shipping.</strong><div class="meter-track"><div class="meter-fill done" style="width:100%"></div></div>`
      : `Add <strong>${fmt(t.remainingForFree)}</strong> more for free shipping.<div class="meter-track"><div class="meter-fill" style="width:${pct.toFixed(0)}%"></div></div>`;

    els.cartItems.innerHTML = state.cart.map((l) => `
      <li class="line" data-id="${l.id}">
        <img src="${escapeHtml(l.image)}" alt="" data-fallback />
        <div>
          <button type="button" class="line-title" data-action="quick">${escapeHtml(l.title)}</button>
          <p class="line-each">${fmt(l.cents)} each</p>
          <div class="stepper" role="group" aria-label="Quantity for ${escapeHtml(l.title)}">
            <button type="button" data-action="dec" aria-label="${l.qty === 1 ? "Remove item" : "Decrease quantity"}">${l.qty === 1 ? ICON.trash : ICON.minus}</button>
            <output aria-live="polite">${l.qty}</output>
            <button type="button" data-action="inc" aria-label="Increase quantity" ${l.qty >= CONFIG.MAX_QTY_PER_ITEM ? "disabled" : ""}>${ICON.plus}</button>
          </div>
        </div>
        <div class="line-side">
          <strong>${fmt(l.cents * l.qty)}</strong>
          <button type="button" class="link-btn" data-action="remove" aria-label="Remove ${escapeHtml(l.title)}">Remove</button>
        </div>
      </li>`).join("");

    els.cartFooter.hidden = false;
    els.summary.innerHTML = summaryRowsHtml(t);

    if (state.promo && CONFIG.PROMO_CODES[state.promo]) {
      els.promoMsg.className = "promo-msg ok";
      els.promoMsg.innerHTML = `${escapeHtml(state.promo)} applied: ${escapeHtml(CONFIG.PROMO_CODES[state.promo].label)}. <button type="button" class="link-btn" data-remove-promo>Remove</button>`;
    } else if (els.promoMsg.classList.contains("ok")) {
      els.promoMsg.className = "promo-msg";
      els.promoMsg.textContent = "";
    }
  }

  function summaryRowsHtml(t) {
    return `
      <div><dt>Subtotal (${t.itemCount} item${t.itemCount === 1 ? "" : "s"})</dt><dd>${fmt(t.subtotal)}</dd></div>
      ${t.discount ? `<div class="discount"><dt>Discount</dt><dd>-${fmt(t.discount)}</dd></div>` : ""}
      <div><dt>Shipping</dt><dd>${t.shipping === 0 ? "Free" : fmt(t.shipping)}</dd></div>
      <div><dt>Tax (${(CONFIG.TAX_RATE * 100).toFixed(0)}%)</dt><dd>${fmt(t.tax)}</dd></div>
      <div class="total"><dt>Total</dt><dd>${fmt(t.total)}</dd></div>`;
  }

  function showStatus(message, withRetry) {
    els.statusBanner.hidden = false;
    els.statusBanner.innerHTML = `<span>${escapeHtml(message)}</span>` +
      (withRetry ? '<button type="button" class="btn btn-ghost" data-retry>Try again</button>' : "");
  }

  function renderQuickView(product) {
    const qty = 1;
    els.qvContent.dataset.id = String(product.id);
    const saved = state.saved.has(product.id);
    els.qvContent.innerHTML = `
      <button type="button" class="icon-btn modal-close" data-close aria-label="Close quick view">&times;</button>
      <div class="qv">
        <div class="qv-media"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" data-fallback /></div>
        <div class="qv-info">
          <span class="card-cat">${escapeHtml(product.category)}</span>
          <h2 id="qvTitle">${escapeHtml(product.title)}</h2>
          ${ratingHtml(product)}
          <div class="qv-badges">${badgesHtml(product)}</div>
          <div class="qv-price">${fmt(product.cents)}</div>
          <p class="qv-desc">${escapeHtml(product.description)}</p>
          <div class="qv-actions">
            <div class="stepper" role="group" aria-label="Quantity">
              <button type="button" data-qv="dec" aria-label="Decrease quantity">${ICON.minus}</button>
              <output id="qvQty" aria-live="polite">${qty}</output>
              <button type="button" data-qv="inc" aria-label="Increase quantity">${ICON.plus}</button>
            </div>
            <button type="button" class="btn btn-primary btn-lg" data-qv="add">Add to cart</button>
            <button type="button" class="btn btn-ghost" data-qv="wish" aria-pressed="${saved}">${saved ? "Saved" : "Save for later"}</button>
          </div>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------
     7. Dialogs and toasts
     --------------------------------------------------------- */
  const openers = new WeakMap();

  function openDialog(dialog) {
    if (dialog.open) return;
    openers.set(dialog, document.activeElement);
    dialog.classList.remove("closing");
    dialog.showModal();
    els.html.classList.add("scroll-lock");
    // Toasts already on screen must stay above the new dialog
    if (els.toasts.children.length) raiseToastLayer();
  }

  /** Close with a short exit animation (or instantly). */
  function closeDialog(dialog, { instant = false, restoreFocus = true } = {}) {
    if (!dialog.open) return;
    if (!restoreFocus) dialog.dataset.skipRestore = "1";
    if (instant || prefersReducedMotion()) { dialog.close(); return; }
    dialog.classList.add("closing");
    setTimeout(() => {
      dialog.classList.remove("closing");
      if (dialog.open) dialog.close();
    }, 220);
  }

  function setupDialog(dialog) {
    // Esc key: use our animated close
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(dialog); });
    // Click on the dark backdrop closes the dialog
    dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(dialog); });
    dialog.addEventListener("close", () => {
      if ($$("dialog[open]").length === 0) els.html.classList.remove("scroll-lock");
      if (dialog.dataset.skipRestore) { delete dialog.dataset.skipRestore; return; }
      const opener = openers.get(dialog);
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    });
  }

  /** Small message at the bottom right, with an optional action button. */
  function toast(message, { action, duration = 3500 } = {}) {
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.innerHTML = `<span>${escapeHtml(message)}</span>`;

    const remove = () => {
      if (!el.isConnected) return;
      el.classList.add("out");
      setTimeout(() => {
        el.remove();
        if (!els.toasts.children.length) hideToastLayer();
      }, prefersReducedMotion() ? 0 : 200);
    };

    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = action.label;
      btn.addEventListener("click", () => { action.onClick(); remove(); });
      el.appendChild(btn);
    }

    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) els.toasts.firstElementChild.remove();
    raiseToastLayer();
    setTimeout(remove, duration);
  }

  // The toast box is a popover so it renders above any open dialog.
  function raiseToastLayer() {
    try {
      if (typeof els.toasts.showPopover !== "function") return;
      if (els.toasts.matches(":popover-open")) els.toasts.hidePopover();
      els.toasts.showPopover();
    } catch (e) { /* older browsers: the box is simply position:fixed */ }
  }
  function hideToastLayer() {
    try {
      if (typeof els.toasts.hidePopover === "function" && els.toasts.matches(":popover-open")) els.toasts.hidePopover();
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------
     8. Checkout
     --------------------------------------------------------- */
  function validateCheckout(data) {
    const errors = {};
    const v = (key) => String(data[key] || "").trim();
    if (v("fullName").length < 2) errors.fullName = "Enter your full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v("email"))) errors.email = "Enter a valid email address, like name@example.com.";
    const digits = v("phone").replace(/\D/g, "");
    if (v("phone") && (digits.length < 7 || digits.length > 15)) errors.phone = "Use 7 to 15 digits, or leave this blank.";
    if (v("address").length < 5) errors.address = "Enter your street address.";
    if (v("city").length < 2) errors.city = "Enter your city.";
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(v("postal"))) errors.postal = "Enter a valid postal code (3 to 10 letters or numbers).";
    if (!["card", "cod"].includes(v("payment"))) errors.payment = "Choose a payment method.";
    return errors;
  }

  function fieldHtml({ id, label, type = "text", autocomplete, placeholder = "", required = true }) {
    return `
      <div class="field">
        <label for="co-${id}">${label}${required ? "" : " (optional)"}</label>
        <input id="co-${id}" name="${id}" type="${type}" autocomplete="${autocomplete}" placeholder="${placeholder}" aria-describedby="co-${id}-err" />
        <p class="err" id="co-${id}-err" hidden></p>
      </div>`;
  }

  function orderLinesHtml(lines) {
    return lines.map((l) => `
      <div class="co-line">
        <img src="${escapeHtml(l.image)}" alt="" data-fallback />
        <span>${escapeHtml(l.title)} <small class="muted">x ${l.qty}</small></span>
        <b>${fmt(l.cents * l.qty)}</b>
      </div>`).join("");
  }

  function openCheckout() {
    if (state.cart.length === 0) return;
    renderCheckoutForm();
    closeDialog(els.cartDrawer, { instant: true, restoreFocus: false });
    openDialog(els.checkoutDialog);
    openers.set(els.checkoutDialog, els.cartBtn);
  }

  function renderCheckoutForm() {
    const t = calculateTotal();
    els.checkoutContent.innerHTML = `
      <div class="modal-head">
        <h2 id="coTitle">Checkout</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close checkout">&times;</button>
      </div>
      <div class="checkout-grid">
        <form id="checkoutForm" novalidate>
          <fieldset>
            <legend>Contact</legend>
            ${fieldHtml({ id: "fullName", label: "Full name", autocomplete: "name", placeholder: "Alex Morgan" })}
            <div class="row2">
              ${fieldHtml({ id: "email", label: "Email", type: "email", autocomplete: "email", placeholder: "alex@example.com" })}
              ${fieldHtml({ id: "phone", label: "Phone", type: "tel", autocomplete: "tel", placeholder: "0300 1234567", required: false })}
            </div>
          </fieldset>
          <fieldset>
            <legend>Delivery address</legend>
            ${fieldHtml({ id: "address", label: "Street address", autocomplete: "street-address", placeholder: "12 Garden Road" })}
            <div class="row2">
              ${fieldHtml({ id: "city", label: "City", autocomplete: "address-level2", placeholder: "Karachi" })}
              ${fieldHtml({ id: "postal", label: "Postal code", autocomplete: "postal-code", placeholder: "75500" })}
            </div>
          </fieldset>
          <fieldset>
            <legend>Payment</legend>
            <label class="pay-opt"><input type="radio" name="payment" value="card" checked /><span>Card <small>Simulated. No card details are collected.</small></span></label>
            <label class="pay-opt"><input type="radio" name="payment" value="cod" /><span>Cash on delivery <small>Pay when the order arrives.</small></span></label>
            <p class="err" id="co-payment-err" hidden></p>
          </fieldset>
          <button type="submit" class="btn btn-primary btn-lg btn-block">Place order, ${fmt(t.total)}</button>
        </form>
        <aside class="co-summary" aria-label="Order summary">
          <h3>Order summary</h3>
          <div class="co-lines">${orderLinesHtml(state.cart)}</div>
          <dl class="summary">${summaryRowsHtml(t)}</dl>
        </aside>
      </div>`;
  }

  function showFieldErrors(form, errors) {
    $$(".field input", form).forEach((input) => {
      const msg = errors[input.name];
      const out = $(`#co-${input.name}-err`, form);
      input.setAttribute("aria-invalid", msg ? "true" : "false");
      if (out) { out.hidden = !msg; out.textContent = msg || ""; }
    });
    const payErr = $("#co-payment-err", form);
    if (payErr) { payErr.hidden = !errors.payment; payErr.textContent = errors.payment || ""; }
  }

  async function placeOrder(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    const errors = validateCheckout(data);
    showFieldErrors(form, errors);
    const firstBad = Object.keys(errors)[0];
    if (firstBad) {
      const input = $(`[name="${firstBad}"]`, form);
      if (input) input.focus();
      return;
    }

    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    submit.textContent = "Placing your order...";
    await sleep(prefersReducedMotion() ? 0 : 1200); // pretend to talk to a payment service

    // Snapshot the order before the cart is emptied
    const order = {
      number: `NL-${Date.now().toString(36).toUpperCase().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`,
      lines: state.cart.map((l) => ({ ...l })),
      totals: calculateTotal(),
      email: String(data.email).trim(),
      name: String(data.fullName).trim(),
      address: `${String(data.address).trim()}, ${String(data.city).trim()} ${String(data.postal).trim().toUpperCase()}`,
      payment: data.payment === "cod" ? "Cash on delivery" : "Card (simulated)",
    };
    clearCart();
    renderCheckoutSuccess(order);
  }

  function renderCheckoutSuccess(order) {
    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    };
    els.checkoutContent.innerHTML = `
      <div class="success">
        <div class="success-ico">${ICON.check}</div>
        <h2 id="coTitle">Thank you, ${escapeHtml(order.name.split(" ")[0])}!</h2>
        <p>Your order is confirmed. A receipt would be sent to <strong>${escapeHtml(order.email)}</strong>.</p>
        <span class="order-no">Order ${escapeHtml(order.number)}</span>
        <div class="co-summary">
          <h3>Delivery</h3>
          <p>${escapeHtml(order.address)}<br />Estimated arrival ${day(3)} to ${day(5)}<br />Paid with ${escapeHtml(order.payment)}</p>
          <div class="co-lines" style="margin-top:14px">${orderLinesHtml(order.lines)}</div>
          <dl class="summary">${summaryRowsHtml(order.totals)}</dl>
        </div>
        <button type="button" class="btn btn-primary btn-lg" data-close>Continue shopping</button>
        <p style="font-size:0.8rem;margin-top:14px">This is a demo store. Nothing was charged and nothing will ship.</p>
      </div>`;
  }

  /* ---------------------------------------------------------
     9. Events
     --------------------------------------------------------- */
  function applyTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    els.html.setAttribute("data-theme", next);
    store.set(KEYS.theme, next);
    const target = next === "dark" ? "light" : "dark";
    els.themeBtn.title = `Switch to ${target} mode`;
    els.themeBtn.setAttribute("aria-label", `Switch to ${target} mode`);
  }

  function openQuickView(id) {
    const product = state.byId.get(id);
    if (!product) return;
    renderQuickView(product);
    openDialog(els.quickView);
  }

  function toggleSaved(id) {
    if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
    store.setJSON(KEYS.saved, [...state.saved]);
    if (state.filters.savedOnly) renderGrid(); else syncCardStates();
    els.savedBtn.setAttribute("aria-pressed", String(state.filters.savedOnly));
  }

  function resetFilters() {
    state.filters.category = "All";
    state.filters.query = "";
    state.filters.savedOnly = false;
    state.filters.maxCents = state.priceCeilCents;
    els.searchInput.value = "";
    els.clearSearch.hidden = true;
    els.priceRange.value = String(state.priceCeilCents / 100);
    els.priceOut.textContent = fmt(state.priceCeilCents);
    els.savedBtn.setAttribute("aria-pressed", "false");
    renderChips();
    renderGrid();
  }

  function bindEvents() {
    [els.cartDrawer, els.quickView, els.checkoutDialog].forEach(setupDialog);

    // Any [data-close] button closes the dialog it lives in
    document.addEventListener("click", (event) => {
      const closer = event.target.closest("[data-close]");
      if (!closer) return;
      const dialog = closer.closest("dialog");
      if (dialog) closeDialog(dialog);
    });

    // Broken product images fall back to a neutral placeholder
    document.addEventListener("error", (event) => {
      const img = event.target;
      if (img && img.tagName === "IMG" && img.hasAttribute("data-fallback") && img.src !== PLACEHOLDER_IMG) {
        img.src = PLACEHOLDER_IMG;
      }
    }, true);

    // Header
    els.cartBtn.addEventListener("click", () => openDialog(els.cartDrawer));
    els.themeBtn.addEventListener("click", () => applyTheme(els.html.getAttribute("data-theme") === "dark" ? "light" : "dark"));
    els.savedBtn.addEventListener("click", () => {
      state.filters.savedOnly = !state.filters.savedOnly;
      els.savedBtn.setAttribute("aria-pressed", String(state.filters.savedOnly));
      renderGrid();
      if (state.filters.savedOnly) $("#catalog").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });

    // Search
    const runSearch = debounce(() => {
      state.filters.query = els.searchInput.value.trim();
      renderGrid();
    }, 200);
    els.searchInput.addEventListener("input", () => {
      els.clearSearch.hidden = els.searchInput.value === "";
      runSearch();
    });
    els.searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.filters.query = els.searchInput.value.trim();
      renderGrid();
      $("#catalog").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
    els.clearSearch.addEventListener("click", () => {
      els.searchInput.value = "";
      els.clearSearch.hidden = true;
      state.filters.query = "";
      renderGrid();
      els.searchInput.focus();
    });
    document.addEventListener("keydown", (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (event.key === "/" && !typing && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        els.searchInput.focus();
      }
    });

    // Filters
    els.chips.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-category]");
      if (!chip) return;
      state.filters.category = chip.dataset.category;
      renderChips();
      renderGrid();
    });
    els.sortSelect.addEventListener("change", () => { state.filters.sort = els.sortSelect.value; renderGrid(); });
    els.priceRange.addEventListener("input", () => {
      state.filters.maxCents = Number(els.priceRange.value) * 100;
      els.priceOut.textContent = fmt(state.filters.maxCents);
      renderGrid();
    });
    els.topRatedBtn.addEventListener("click", () => {
      state.filters.sort = "rating";
      els.sortSelect.value = "rating";
      if (state.loaded) resetFilters();
      $("#catalog").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
    els.resultMeta.addEventListener("click", (event) => { if (event.target.closest("[data-reset]")) resetFilters(); });
    els.stateBox.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-state-action]");
      if (!btn) return;
      if (btn.dataset.stateAction === "reset") resetFilters();
      if (btn.dataset.stateAction === "retry") loadCatalog();
    });
    els.statusBanner.addEventListener("click", (event) => { if (event.target.closest("[data-retry]")) loadCatalog(); });

    // Product grid (one handler for every card)
    els.grid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      const card = event.target.closest(".card[data-id]");
      if (!button || !card) return;
      const id = Number(card.dataset.id);
      const product = state.byId.get(id);
      if (!product) return;
      if (button.dataset.action === "add") {
        if (addToCart(product)) {
          toast(`Added "${shorten(product.title, 28)}"`, { action: { label: "View cart", onClick: () => openDialog(els.cartDrawer) } });
        }
      }
      if (button.dataset.action === "wish") toggleSaved(id);
      if (button.dataset.action === "quick") openQuickView(id);
    });
    els.heroStack.addEventListener("click", (event) => {
      const item = event.target.closest("[data-id]");
      if (item) openQuickView(Number(item.dataset.id));
    });

    // Quick view
    els.qvContent.addEventListener("click", (event) => {
      const button = event.target.closest("[data-qv]");
      if (!button) return;
      const id = Number(els.qvContent.dataset.id);
      const product = state.byId.get(id);
      const out = $("#qvQty", els.qvContent);
      let qty = Number(out.textContent);
      const room = CONFIG.MAX_QTY_PER_ITEM - qtyInCart(id);
      if (button.dataset.qv === "inc") out.textContent = String(clamp(qty + 1, 1, Math.max(1, room)));
      if (button.dataset.qv === "dec") out.textContent = String(clamp(qty - 1, 1, CONFIG.MAX_QTY_PER_ITEM));
      if (button.dataset.qv === "add" && product) {
        if (addToCart(product, qty)) {
          toast(`Added ${qty} to your cart`, { action: { label: "View cart", onClick: () => { closeDialog(els.quickView, { instant: true, restoreFocus: false }); openDialog(els.cartDrawer); } } });
          out.textContent = "1";
        }
      }
      if (button.dataset.qv === "wish") {
        toggleSaved(id);
        const on = state.saved.has(id);
        button.setAttribute("aria-pressed", String(on));
        button.textContent = on ? "Saved" : "Save for later";
      }
    });

    // Cart drawer
    els.cartItems.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      const line = event.target.closest(".line[data-id]");
      if (!button || !line) return;
      const id = Number(line.dataset.id);
      const item = state.cart.find((l) => l.id === id);
      if (!item) return;
      if (button.dataset.action === "inc") updateQuantity(id, item.qty + 1);
      if (button.dataset.action === "dec") updateQuantity(id, item.qty - 1);
      if (button.dataset.action === "remove") removeFromCart(id);
      if (button.dataset.action === "quick") {
        closeDialog(els.cartDrawer, { instant: true, restoreFocus: false });
        openQuickView(id);
      }
    });
    els.promoForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const result = applyPromo(els.promoInput.value);
      els.promoMsg.className = `promo-msg ${result.ok ? "ok" : "bad"}`;
      if (!result.ok) els.promoMsg.textContent = result.message;
      if (result.ok) els.promoInput.value = "";
    });
    els.promoMsg.addEventListener("click", (event) => {
      if (!event.target.closest("[data-remove-promo]")) return;
      state.promo = null;
      els.promoMsg.className = "promo-msg";
      els.promoMsg.textContent = "";
      cartChanged();
    });
    els.clearCartBtn.addEventListener("click", () => {
      const snapshot = { cart: state.cart.map((l) => ({ ...l })), promo: state.promo };
      clearCart();
      toast("Cart emptied", { action: { label: "Undo", onClick: () => { state.cart = snapshot.cart; state.promo = snapshot.promo; cartChanged(); } }, duration: 6000 });
    });
    els.checkoutBtn.addEventListener("click", openCheckout);

    // Checkout form
    els.checkoutContent.addEventListener("submit", (event) => {
      if (event.target.id !== "checkoutForm") return;
      event.preventDefault();
      placeOrder(event.target);
    });
    els.checkoutContent.addEventListener("input", (event) => {
      const input = event.target;
      if (input.matches && input.matches(".field input") && input.getAttribute("aria-invalid") === "true") {
        input.setAttribute("aria-invalid", "false");
        const out = $(`#co-${input.name}-err`, els.checkoutContent);
        if (out) { out.hidden = true; out.textContent = ""; }
      }
    });

    // Keep several tabs in sync
    window.addEventListener("storage", (event) => {
      if (event.key === KEYS.cart) { state.cart = loadCart(); cartChanged(); }
    });

    window.addEventListener("online", () => { if (!state.loaded) loadCatalog(); });
  }

  /* ---------------------------------------------------------
     10. Start-up
     --------------------------------------------------------- */
  function loadCart() {
    const saved = store.getJSON(KEYS.cart, []);
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((l) => l && Number.isFinite(l.id) && typeof l.title === "string" && Number.isInteger(l.cents) && l.cents >= 0 && Number.isInteger(l.qty) && l.qty > 0)
      .map((l) => ({ id: l.id, title: l.title, cents: l.cents, image: typeof l.image === "string" ? l.image : PLACEHOLDER_IMG, qty: Math.min(l.qty, CONFIG.MAX_QTY_PER_ITEM) }));
  }

  /** Use a normalized catalog: build lookups, filters, hero and grid. */
  function applyCatalog(products) {
    state.products = products;
    state.byId = new Map(products.map((p) => [p.id, p]));
    state.loaded = true;

    // Refresh cart snapshots in case prices or titles changed
    state.cart = state.cart
      .map((l) => {
        const p = state.byId.get(l.id);
        return p ? { ...l, title: p.title, cents: p.cents, image: p.image } : l;
      });
    persistCart();

    renderPriceRange();
    renderChips();
    renderHero();
    els.grid.setAttribute("aria-busy", "false");
    renderGrid();
    renderCart();
  }

  function showCatalogError(err) {
    state.loaded = false;
    els.grid.innerHTML = "";
    els.grid.setAttribute("aria-busy", "false");
    els.resultMeta.textContent = "";
    const message = err instanceof CatalogError ? err.message : CATALOG_ERRORS.UNEXPECTED;
    showStateBox("We could not load the catalog", message, { label: "Try again", action: "retry" });
  }

  async function loadCatalog() {
    els.statusBanner.hidden = true;
    els.stateBox.hidden = true;
    els.grid.setAttribute("aria-busy", "true");
    els.grid.innerHTML = skeletonHtml();

    try {
      const raw = await fetchCatalog();
      const products = normalizeCatalog(raw);
      store.setJSON(KEYS.cache, { savedAt: Date.now(), data: raw });
      applyCatalog(products);
    } catch (err) {
      // Fall back to the last good copy so the shop is still usable
      const cached = store.getJSON(KEYS.cache, null);
      if (cached && Array.isArray(cached.data)) {
        try {
          applyCatalog(normalizeCatalog(cached.data));
          const when = new Date(cached.savedAt).toLocaleString();
          showStatus(`Showing a saved copy of the catalog from ${when}. ${err.message || ""}`, true);
          return;
        } catch (cacheErr) { /* cache unusable, show the error below */ }
      }
      showCatalogError(err);
    }
  }

  function init() {
    const savedTheme = store.get(KEYS.theme, "");
    const prefersDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(savedTheme || (prefersDark ? "dark" : "light"));

    state.cart = loadCart();
    const promo = store.get(KEYS.promo, "");
    state.promo = promo && CONFIG.PROMO_CODES[promo] ? promo : null;
    const savedIds = store.getJSON(KEYS.saved, []);
    state.saved = new Set(Array.isArray(savedIds) ? savedIds.filter(Number.isFinite) : []);

    bindEvents();
    renderCart();
    syncCardStates();
    loadCatalog();
  }

  init();
})();
