(function () {
  'use strict';

  var state = { customers: [], selectedId: null, adminEmail: '' };

  function one(selector, root) { return (root || document).querySelector(selector); }
  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function money(cents) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100); }
  function date(value) { return value ? new Date(value).toLocaleString() : '—'; }

  function api(url, options) {
    return fetch(url, options || {}).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok || body.ok === false) {
          var error = new Error(body.error || 'Request failed.');
          error.status = response.status;
          throw error;
        }
        return body;
      });
    });
  }

  var loginView = one('[data-crm-login]');
  var loginForm = one('[data-crm-login-form]');
  var loginStatus = one('[data-crm-login-status]');
  var shell = one('[data-crm-shell]');
  var adminEmail = one('[data-crm-admin-email]');
  var search = one('[data-crm-search]');
  var table = one('[data-crm-customers-table]');
  var profile = one('[data-crm-profile]');
  var pageStatus = one('[data-crm-page-status]');
  var profileTemplate = one('[data-crm-profile-template]');
  var searchTimer;

  function customerIdFromUrl() {
    var value = new URLSearchParams(window.location.search).get('customer');
    var id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function profileUrl(id) {
    var url = new URL('/admin/customers/', window.location.origin);
    url.searchParams.set('customer', String(id));
    return url.toString();
  }

  function setProfileUrl(id, replace) {
    var url = id ? profileUrl(id) : new URL('/admin/customers/', window.location.origin).toString();
    window.history[replace ? 'replaceState' : 'pushState']({ customerId: id || null }, '', url);
  }

  function showLogin() {
    loginView.hidden = false;
    shell.hidden = true;
    state.selectedId = null;
  }

  function showShell(email) {
    state.adminEmail = email || '';
    adminEmail.textContent = state.adminEmail;
    loginView.hidden = true;
    shell.hidden = false;
  }

  function handleError(error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    pageStatus.textContent = error.message;
    pageStatus.className = 'status error';
  }

  function loadStore() {
    return api('/api/retail/store').then(function (body) {
      var name = body.store && body.store.name ? body.store.name : 'Dispensary';
      all('[data-site-name]').forEach(function (target) { target.textContent = name; });
      document.title = name + ' Customer CRM';
    }).catch(function () {});
  }

  function renderMetrics() {
    var repeat = state.customers.filter(function (customer) { return Number(customer.order_count || 0) > 1; }).length;
    var subscribers = state.customers.filter(function (customer) { return customer.marketing_opt_in && !customer.unsubscribed_at; }).length;
    var spend = state.customers.reduce(function (sum, customer) { return sum + Number(customer.total_spend_cents || 0); }, 0);
    one('[data-crm-metric="customers"]').textContent = String(state.customers.length);
    one('[data-crm-metric="repeat"]').textContent = String(repeat);
    one('[data-crm-metric="subscribers"]').textContent = String(subscribers);
    one('[data-crm-metric="spend"]').textContent = money(spend);
  }

  function renderDirectory() {
    table.innerHTML = state.customers.map(function (customer) {
      var active = Number(customer.id) === Number(state.selectedId) ? ' class="active"' : '';
      var marketing = customer.marketing_opt_in && !customer.unsubscribed_at ? 'WA opted in' : (customer.unsubscribed_at ? 'Unsubscribed' : 'Not opted in');
      return '<tr data-customer-id="' + Number(customer.id) + '"' + active + '>' +
        '<td><strong>' + esc(customer.first_name + ' ' + customer.last_name) + '</strong><br><small>Customer #' + Number(customer.id) + '</small></td>' +
        '<td>' + esc(customer.email) + '<br><small>' + esc(customer.phone || '') + '</small></td>' +
        '<td>' + Number(customer.order_count || 0) + '</td>' +
        '<td>' + money(customer.total_spend_cents) + '</td>' +
        '<td>' + esc(marketing) + '</td>' +
        '<td>' + date(customer.last_order_at) + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="6">No customers match this search.</td></tr>';
  }

  function loadCustomers() {
    var query = search.value.trim();
    pageStatus.textContent = 'Loading customers…';
    pageStatus.className = 'status';
    return api('/api/admin/retail/customers' + (query ? '?q=' + encodeURIComponent(query) : '')).then(function (body) {
      state.customers = body.customers || [];
      renderMetrics();
      renderDirectory();
      pageStatus.textContent = '';
      return state.customers;
    }).catch(function (error) {
      handleError(error);
      return [];
    });
  }

  function emptyProfile() {
    state.selectedId = null;
    profile.innerHTML = '<div class="crm-empty-profile"><p class="eyebrow">Customer profile</p><h2>Select a customer</h2><p>Open a record to review contact information, order history, internal notes, and consent status.</p></div>';
    renderDirectory();
  }

  function renderProfile(customer, orders) {
    profile.innerHTML = '';
    profile.appendChild(profileTemplate.content.cloneNode(true));
    one('[data-profile-name]', profile).textContent = customer.first_name + ' ' + customer.last_name;
    one('[data-profile-contact]', profile).innerHTML =
      '<p><strong>Email:</strong> ' + esc(customer.email) + '</p>' +
      '<p><strong>Phone:</strong> ' + esc(customer.phone || '—') + '</p>' +
      '<p><strong>Created:</strong> ' + date(customer.created_at) + '</p>' +
      '<p><strong>Marketing state:</strong> ' + esc(customer.marketing_state || 'Not documented') + '</p>' +
      '<p><strong>Unsubscribed:</strong> ' + (customer.unsubscribed_at ? date(customer.unsubscribed_at) : 'No') + '</p>';
    one('[data-profile-stats]', profile).innerHTML =
      '<article><span>Orders</span><strong>' + Number(customer.order_count || 0) + '</strong></article>' +
      '<article><span>Spend</span><strong>' + money(customer.total_spend_cents) + '</strong></article>' +
      '<article><span>Last order</span><strong>' + (customer.last_order_at ? new Date(customer.last_order_at).toLocaleDateString() : '—') + '</strong></article>';

    var form = one('[data-crm-customer-form]', profile);
    form.elements.customerId.value = customer.id;
    form.elements.notes.value = customer.notes || '';
    form.elements.marketingOptIn.checked = Boolean(customer.marketing_opt_in && !customer.unsubscribed_at);
    form.elements.marketingState.checked = customer.marketing_state === 'WA';

    one('[data-profile-orders]', profile).innerHTML = (orders || []).map(function (order) {
      return '<tr><td><strong>' + esc(order.order_number) + '</strong></td><td>' + esc(order.status) + '</td><td>' + money(order.total_cents) + '</td><td>' + esc(order.pickup_window) + '</td><td>' + date(order.created_at) + '</td></tr>';
    }).join('') || '<tr><td colspan="5">No pickup history.</td></tr>';

    one('[data-copy-profile-url]', profile).addEventListener('click', function (event) {
      var button = event.currentTarget;
      var url = profileUrl(customer.id);
      var copy = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(url) : Promise.reject(new Error('Clipboard unavailable'));
      copy.then(function () { button.textContent = 'URL copied'; }).catch(function () {
        window.prompt('Copy this customer profile URL:', url);
      });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = one('[data-profile-save-status]', profile);
      var optedIn = form.elements.marketingOptIn.checked;
      status.textContent = 'Saving…';
      status.className = 'status';
      api('/api/admin/retail/customers/' + customer.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: form.elements.notes.value,
          marketingOptIn: optedIn,
          marketingState: optedIn && form.elements.marketingState.checked ? 'WA' : ''
        })
      }).then(function () {
        status.textContent = 'Customer saved.';
        status.className = 'status success';
        return loadCustomers().then(function () { return selectCustomer(customer.id, false); });
      }).catch(function (error) {
        if (error.status === 401) return showLogin();
        status.textContent = error.message;
        status.className = 'status error';
      });
    });
  }

  function selectCustomer(id, updateUrl) {
    id = Number(id);
    if (!Number.isInteger(id) || id < 1) {
      emptyProfile();
      if (updateUrl) setProfileUrl(null, false);
      return Promise.resolve();
    }
    state.selectedId = id;
    renderDirectory();
    profile.innerHTML = '<div class="crm-empty-profile"><p class="eyebrow">Customer profile</p><h2>Loading…</h2></div>';
    return api('/api/admin/retail/customers/' + id).then(function (body) {
      state.selectedId = id;
      renderDirectory();
      renderProfile(body.customer, body.orders || []);
      if (updateUrl) setProfileUrl(id, false);
    }).catch(function (error) {
      if (error.status === 404) {
        emptyProfile();
        pageStatus.textContent = 'Customer not found.';
        pageStatus.className = 'status error';
        setProfileUrl(null, true);
        return;
      }
      handleError(error);
    });
  }

  table.addEventListener('click', function (event) {
    var row = event.target.closest('[data-customer-id]');
    if (row) selectCustomer(Number(row.getAttribute('data-customer-id')), true);
  });

  search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCustomers, 250);
  });

  one('[data-crm-clear-search]').addEventListener('click', function () {
    search.value = '';
    search.focus();
    loadCustomers();
  });

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = new FormData(loginForm);
    loginStatus.textContent = 'Signing in…';
    loginStatus.className = 'status';
    api('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: data.get('email'), password: data.get('password') })
    }).then(function (body) {
      loginStatus.textContent = '';
      showShell(body.email);
      return loadCustomers();
    }).then(function () {
      var id = customerIdFromUrl();
      if (id) return selectCustomer(id, false);
    }).catch(function (error) {
      loginStatus.textContent = error.message;
      loginStatus.className = 'status error';
    });
  });

  one('[data-crm-logout]').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).finally(function () {
      loginForm.reset();
      showLogin();
    });
  });

  window.addEventListener('popstate', function () {
    var id = customerIdFromUrl();
    if (id) selectCustomer(id, false); else emptyProfile();
  });

  loadStore();
  api('/api/admin/me').then(function (body) {
    showShell(body.email);
    return loadCustomers();
  }).then(function () {
    var id = customerIdFromUrl();
    if (id) return selectCustomer(id, false);
  }).catch(function (error) {
    if (error.status === 401) showLogin(); else handleError(error);
  });
}());
