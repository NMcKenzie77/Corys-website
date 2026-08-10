(function () {
  'use strict';

  var AGE_KEY = 'dispensary_age_21_v1';
  var CART_KEY = 'dispensary_pickup_cart_v1';
  var gate = document.querySelector('[data-age-gate]');
  var gateCard = gate && gate.querySelector('.age-card');
  var enter = document.querySelector('[data-age-enter]');
  var exit = document.querySelector('[data-age-exit]');
  var siteShell = document.querySelector('[data-site-shell]');

  function readCart() {
    try {
      var parsed = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function writeCart(items) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch (_error) { /* storage unavailable */ }
    updateCounts();
    window.dispatchEvent(new CustomEvent('retail-cart-updated', { detail: items }));
  }

  function updateCounts() {
    var count = readCart().reduce(function (sum, item) { return sum + Number(item.quantity || 0); }, 0);
    document.querySelectorAll('[data-cart-count]').forEach(function (element) { element.textContent = String(count); });
  }

  function addItem(item) {
    var cart = readCart();
    var found = cart.find(function (entry) { return Number(entry.variantId) === Number(item.variantId); });
    if (found) found.quantity = Math.min(99, Number(found.quantity || 0) + Number(item.quantity || 1));
    else cart.push({
      variantId: Number(item.variantId),
      productId: Number(item.productId),
      productName: String(item.productName || ''),
      variantLabel: String(item.variantLabel || ''),
      priceCents: Number(item.priceCents || 0),
      imageUrl: String(item.imageUrl || ''),
      quantity: Math.max(1, Number(item.quantity || 1))
    });
    writeCart(cart);
    return cart;
  }

  function updateItem(variantId, quantity) {
    var cart = readCart();
    var next = cart.map(function (item) {
      if (Number(item.variantId) === Number(variantId)) item.quantity = Math.max(0, Math.min(99, Number(quantity || 0)));
      return item;
    }).filter(function (item) { return item.quantity > 0; });
    writeCart(next);
    return next;
  }

  function clearCart() { writeCart([]); }
  function money(cents) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100); }

  window.RetailCart = { get: readCart, set: writeCart, add: addItem, update: updateItem, clear: clearCart, money: money };

  function setSiteAvailable(available) {
    if (!siteShell) return;
    if (available) {
      siteShell.removeAttribute('inert');
      siteShell.setAttribute('aria-hidden', 'false');
    } else {
      siteShell.setAttribute('inert', '');
      siteShell.setAttribute('aria-hidden', 'true');
    }
  }

  function focusableInGate() {
    return gate ? Array.prototype.slice.call(gate.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')) : [];
  }

  function trapGateFocus(event) {
    if (!gate || gate.hidden || event.key !== 'Tab') return;
    var focusable = focusableInGate();
    if (!focusable.length) {
      event.preventDefault();
      if (gateCard) gateCard.focus();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function passAgeGate() {
    try { sessionStorage.setItem(AGE_KEY, 'yes'); } catch (_error) { /* storage unavailable */ }
    if (gate) gate.hidden = true;
    setSiteAvailable(true);
    document.body.classList.remove('gated');
    var target = document.querySelector('[data-site-shell] a, [data-site-shell] button, [data-site-shell] input, [data-site-shell] select, [data-site-shell] textarea');
    if (target) target.focus();
  }

  var verified = false;
  try { verified = sessionStorage.getItem(AGE_KEY) === 'yes'; } catch (_error) { /* storage unavailable */ }
  if (verified) {
    if (gate) gate.hidden = true;
    setSiteAvailable(true);
  } else {
    setSiteAvailable(false);
    document.body.classList.add('gated');
    window.setTimeout(function () {
      if (enter) enter.focus();
      else if (gateCard) gateCard.focus();
    }, 0);
  }

  if (enter) enter.addEventListener('click', passAgeGate);
  if (exit) {
    exit.addEventListener('click', function () {
      try { sessionStorage.removeItem(AGE_KEY); } catch (_error) { /* storage unavailable */ }
    });
  }
  document.addEventListener('keydown', trapGateFocus);

  updateCounts();
})();
