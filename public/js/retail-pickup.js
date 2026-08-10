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
  var pickupTimeWrap = app.querySelector('[data-pickup-time-wrap]');
  var pickupAt = app.querySelector('[data-pickup-at]');
  var originInput = app.querySelector('[data-drive-origin]');
  var placeSuggestions = app.querySelector('[data-place-suggestions]');
  var useLocation = app.querySelector('[data-use-location]');
  var estimateDrive = app.querySelector('[data-estimate-drive]');
  var driveResult = app.querySelector('[data-drive-result]');
  var selectedPlaceId = '';
  var selectedCoordinates = null;
  var autocompleteTimer = null;
  var autocompleteSession = requestId();
  var pendingReservationId = '';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function requestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'web-' + Date.now() + '-' + Math.random().toString(16).slice(2);
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

  function syncPickupTime() {
    var scheduled = String(pickupWindow.value || '').toUpperCase() !== 'ASAP';
    pickupTimeWrap.hidden = !scheduled;
    pickupAt.required = scheduled;
    if (!scheduled) pickupAt.value = '';
  }

  function clearSuggestions() {
    placeSuggestions.innerHTML = '';
    placeSuggestions.hidden = true;
  }

  function fetchSuggestions() {
    var query = originInput.value.trim();
    selectedPlaceId = '';
    selectedCoordinates = null;
    if (query.length < 3) return clearSuggestions();
    fetch('/api/retail/places/autocomplete?q=' + encodeURIComponent(query) + '&sessionToken=' + encodeURIComponent(autocompleteSession))
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || 'Address suggestions are unavailable.');
        var suggestions = result.body.suggestions || [];
        if (!suggestions.length) return clearSuggestions();
        placeSuggestions.innerHTML = suggestions.map(function (item) {
          return '<button type="button" class="place-suggestion" data-place-id="' + esc(item.placeId) + '">' + esc(item.label) + '</button>';
        }).join('');
        placeSuggestions.hidden = false;
      })
      .catch(clearSuggestions);
  }

  function drivePayload() {
    var payload = {};
    if (selectedPlaceId) payload.placeId = selectedPlaceId;
    else if (selectedCoordinates) {
      payload.latitude = selectedCoordinates.latitude;
      payload.longitude = selectedCoordinates.longitude;
    } else payload.address = originInput.value.trim();
    if (pickupAt.value) payload.pickupAt = new Date(pickupAt.value).toISOString();
    return payload;
  }

  function estimateDriveTime() {
    var payload = drivePayload();
    if (!payload.placeId && payload.latitude == null && !payload.address) {
      driveResult.textContent = 'Enter your starting address or use your current location.';
      return;
    }
    estimateDrive.disabled = true;
    driveResult.textContent = 'Checking traffic-aware drive time…';
    fetch('/api/retail/drive-time', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || 'Drive time is unavailable.');
        var value = result.body.estimate;
        var message = 'About ' + Number(value.durationMinutes) + ' min (' + Number(value.distanceMiles).toFixed(1) + ' miles) with current traffic.';
        if (value.suggestedDeparture) {
          message += ' Suggested departure: ' + new Date(value.suggestedDeparture).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
        }
        driveResult.textContent = message + ' This is an estimate, not a guarantee.';
      })
      .catch(function (error) { driveResult.textContent = error.message; })
      .finally(function () { estimateDrive.disabled = false; });
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

  pickupWindow.addEventListener('change', syncPickupTime);

  originInput.addEventListener('input', function () {
    window.clearTimeout(autocompleteTimer);
    autocompleteTimer = window.setTimeout(fetchSuggestions, 250);
  });

  placeSuggestions.addEventListener('click', function (event) {
    var button = event.target.closest('[data-place-id]');
    if (!button) return;
    selectedPlaceId = button.getAttribute('data-place-id') || '';
    selectedCoordinates = null;
    originInput.value = button.textContent;
    clearSuggestions();
  });

  useLocation.addEventListener('click', function () {
    if (!navigator.geolocation) {
      driveResult.textContent = 'Location access is not supported by this browser. Enter an address instead.';
      return;
    }
    useLocation.disabled = true;
    driveResult.textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(function (position) {
      selectedPlaceId = '';
      selectedCoordinates = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      originInput.value = 'Current location';
      useLocation.disabled = false;
      estimateDriveTime();
    }, function () {
      useLocation.disabled = false;
      driveResult.textContent = 'Location access was not available. Enter an address instead.';
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  });

  estimateDrive.addEventListener('click', estimateDriveTime);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var cart = window.RetailCart.get();
    if (!cart.length) return render();
    if (!form.reportValidity()) return;

    var data = new FormData(form);
    var marketingConsent = data.get('marketingConsent') === 'true';
    if (!pendingReservationId) pendingReservationId = requestId();
    var payload = {
      clientRequestId: pendingReservationId,
      firstName: data.get('firstName'),
      lastName: data.get('lastName'),
      email: data.get('email'),
      phone: data.get('phone'),
      pickupWindow: data.get('pickupWindow'),
      pickupAt: data.get('pickupAt') ? new Date(data.get('pickupAt')).toISOString() : null,
      notes: data.get('notes'),
      ageConfirmed: data.get('ageConfirmed') === 'true',
      privacyAccepted: data.get('privacyAccepted') === 'true',
      marketingConsent: marketingConsent,
      marketingState: marketingConsent ? 'WA' : '',
      items: cart.map(function (item) { return { variantId: Number(item.variantId), quantity: Number(item.quantity) }; })
    };

    submit.disabled = true;
    status.textContent = 'Submitting pickup request…';
    status.className = 'status';

    fetch('/api/retail/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pendingReservationId },
      body: JSON.stringify(payload)
    })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || 'Pickup request could not be submitted.');
        if (result.body.transactionType !== 'PICKUP_RESERVATION_REQUEST' || result.body.saleCompleted !== false || result.body.paymentDue !== 'IN_STORE') {
          throw new Error('The pickup request response did not preserve the required in-store-sale boundary.');
        }
        var code = esc(result.body.reservationCode || result.body.orderNumber);
        var windowLabel = esc(result.body.pickupWindow);
        window.RetailCart.clear();
        render();
        form.reset();
        pendingReservationId = '';
        syncPickupTime();
        if (result.body.status === 'CONFIRMED') {
          status.innerHTML = '<strong>Pickup request ' + code + ' received.</strong> A temporary inventory hold is active for <strong>' + windowLabel + '</strong> while store staff reviews the request. This is not a completed cannabis sale. Wait for the ready notification, then bring valid ID and pay inside the store.';
        } else {
          status.innerHTML = '<strong>Pickup request ' + code + ' received.</strong> No sale has occurred and inventory is not yet held. Store staff need your exact pickup time before they can continue.';
        }
        status.className = 'status success';
        status.focus();
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
      syncPickupTime();
    })
    .catch(function () {
      pickupWindow.innerHTML = '<option value="ASAP">ASAP</option>';
      syncPickupTime();
    });

  window.addEventListener('retail-cart-updated', render);
  render();
})();
