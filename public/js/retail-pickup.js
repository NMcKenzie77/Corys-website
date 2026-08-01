(function () {
  'use strict';

  var app = document.querySelector('[data-pickup-app]');
  if (!app || !window.RetailCart) return;

  var itemsRoot = app.querySelector('[data-pickup-items]');
  var totalRoot = app.querySelector('[data-pickup-total]');
  var form = app.querySelector('[data-pickup-form]');
  var status = app.querySelector('[data-pickup-status]');
  var submit = app.querySelector('[data-pickup-submit]');
  var pickupWindow = app.querySelector('[data-pickup-window]');

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function render() {
    var cart = window.RetailCart.get();
    if (!cart.length) {
      itemsRoot.innerHTML = '<div class="empty-state">Your pickup reservation is empty. <a href="/menu">Browse the menu</a>.</div>';
      totalRoot.textContent = window.RetailCart.money(0);
      submit.disabled = true;
      return;
    }

    itemsRoot.innerHTML = cart.map(function (item) {
      return '<div class="cart-item"><div><strong>' + esc(item.productName) + '</strong><div class="small">' + esc(item.variantLabel) + '</div></div><div class="qty-controls"><button type="button" aria-label="Decrease quantity" data-qty-change="-1" data-variant-id="' + Number(item.variantId) + '">−</button><strong>' + Number(item.quantity) + '</strong><button type="button" aria-label="Increase quantity" data-qty-change="1" data-variant-id="' + Number(item.variantId) + '">+</button><button type="button" aria-label="Remove product" data-remove-item data-variant-id="' + Number(item.variantId) + '">×</button></div><span class="price">' + window.RetailCart.money(Number(item.priceCents) * Number(item.quantity)) + '</span></div>';
    }).join('');
    var total = cart.reduce(function (sum, item) { return sum + Number(item.priceCents || 0) * Number(item.quantity || 0); }, 0);
    totalRoot.textContent = window.RetailCart.money(total);
    submit.disabled = false;
  }

  itemsRoot.addEventListener('click', function (event) {
    var button = event.target.closest('[data-variant-id]');
    if (!button) return;
    var variantId = Number(button.getAttribute('data-variant-id'));
    var current = window.RetailCart.get().find(function (item) { return Number(item.variantId) === variantId; });
    if (!current) return;
    if (button.hasAttribute('data-remove-item')) window.RetailCart.update(variantId, 0);
    else window.RetailCart.update(variantId, Number(current.quantity) + Number(button.getAttribute('data-qty-change') || 0));
    render();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var cart = window.RetailCart.get();
    if (!cart.length) return render();
    if (!form.reportValidity()) return;

    var data = new FormData(form);
    var marketingConsent = data.get('marketingConsent') === 'true';
    var payload = {
      firstName: data.get('firstName'),
      lastName: data.get('lastName'),
      email: data.get('email'),
      phone: data.get('phone'),
      pickupWindow: data.get('pickupWindow'),
      notes: data.get('notes'),
      ageConfirmed: data.get('ageConfirmed') === 'true',
      privacyAccepted: data.get('privacyAccepted') === 'true',
      marketingConsent: marketingConsent,
      marketingState: marketingConsent ? 'WA' : '',
      items: cart.map(function (item) { return { variantId: Number(item.variantId), quantity: Number(item.quantity) }; })
    };

    submit.disabled = true;
    status.textContent = 'Submitting pickup reservation…';
    status.className = 'status';

    fetch('/api/retail/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || 'Reservation could not be submitted.');
        window.RetailCart.clear();
        render();
        form.reset();
        status.innerHTML = 'Reservation <strong>' + esc(result.body.orderNumber) + '</strong> was received for <strong>' + esc(result.body.pickupWindow) + '</strong>. Wait for store confirmation, then bring valid ID and pay inside the store.';
        status.className = 'status success';
      })
      .catch(function (error) {
        status.textContent = error.message;
        status.className = 'status error';
        submit.disabled = false;
      });
  });

  fetch('/api/retail/store')
    .then(function (response) { return response.json(); })
    .then(function (data) {
      pickupWindow.innerHTML = '';
      (data.store && data.store.pickupWindows || ['ASAP']).forEach(function (windowLabel) {
        var option = document.createElement('option');
        option.value = windowLabel;
        option.textContent = windowLabel;
        pickupWindow.appendChild(option);
      });
    })
    .catch(function () { pickupWindow.innerHTML = '<option value="ASAP">ASAP</option>'; });

  window.addEventListener('retail-cart-updated', render);
  render();
})();
