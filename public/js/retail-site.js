(function () {
  'use strict';

  var AGE_KEY = 'dispensary_age_21_v1';
  var CART_KEY = 'dispensary_pickup_cart_v1';
  var gate = document.querySelector('[data-age-gate]');
  var enter = document.querySelector('[data-age-enter]');

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

  var verified = false;
  try { verified = localStorage.getItem(AGE_KEY) === 'yes'; } catch (_error) { /* storage unavailable */ }
  if (verified && gate) gate.hidden = true;
  if (!verified) document.body.classList.add('gated');

  if (enter) {
    enter.addEventListener('click', function () {
      try { localStorage.setItem(AGE_KEY, 'yes'); } catch (_error) { /* storage unavailable */ }
      if (gate) gate.hidden = true;
      document.body.classList.remove('gated');
    });
  }

  updateCounts();
})();
