(function () {
  'use strict';

  var state = {
    products: [], orders: [], customers: [], campaigns: [], automations: null,
    privacyRequests: [], selectedProduct: null, selectedOrder: null, selectedCustomer: null, selectedRequest: null
  };

  function one(selector, root) { return (root || document).querySelector(selector); }
  function all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function money(cents) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100); }
  function date(value) { return value ? new Date(value).toLocaleString() : '—'; }
  function dollars(cents) { return (Number(cents || 0) / 100).toFixed(2); }

  function api(url, options) {
    return fetch(url, options || {}).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok || body.ok === false) {
          var error = new Error(body.error || 'Request failed.'); error.status = response.status; throw error;
        }
        return body;
      });
    });
  }

  var loginView = one('[data-admin-login]');
  var loginForm = one('[data-admin-login-form]');
  var loginStatus = one('[data-admin-login-status]');
  var shell = one('[data-admin-shell]');
  var pageTitle = one('[data-admin-title]');
  var adminEmail = one('[data-admin-email]');

  function showLogin() { loginView.hidden = false; shell.hidden = true; }
  function showShell(email) { loginView.hidden = true; shell.hidden = false; adminEmail.textContent = email || ''; openPanel(location.hash.replace('#', '') || 'dashboard'); }

  function openPanel(name) {
    if (!one('[data-admin-panel="' + name + '"]')) name = 'dashboard';
    all('[data-admin-panel]').forEach(function (panel) { panel.hidden = panel.getAttribute('data-admin-panel') !== name; });
    all('[data-admin-nav]').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-admin-nav') === name); });
    pageTitle.textContent = ({ dashboard: 'Dashboard', products: 'Menu products', orders: 'Pickup orders', customers: 'Customers', campaigns: 'Campaigns', automations: 'Automations', compliance: 'Compliance' })[name] || 'Dashboard';
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'dashboard') loadDashboard();
    if (name === 'products') loadProducts();
    if (name === 'orders') loadOrders();
    if (name === 'customers') loadCustomers();
    if (name === 'campaigns') loadCampaigns();
    if (name === 'automations') loadAutomations();
    if (name === 'compliance') loadCompliance();
  }

  all('[data-admin-nav]').forEach(function (button) { button.addEventListener('click', function () { openPanel(button.getAttribute('data-admin-nav')); }); });
  one('[data-admin-logout]').addEventListener('click', function () { api('/api/admin/logout', { method: 'POST' }).finally(showLogin); });

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    loginStatus.textContent = 'Signing in…';
    var data = new FormData(loginForm);
    api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) })
      .then(function (body) { loginStatus.textContent = ''; showShell(body.email); })
      .catch(function (error) { loginStatus.textContent = error.message; loginStatus.className = 'status error'; });
  });

  function loadDashboard() {
    api('/api/admin/retail/summary').then(function (body) {
      Object.keys(body.summary || {}).forEach(function (key) {
        var target = one('[data-metric="' + key + '"]');
        if (target) target.textContent = key.indexOf('_cents') !== -1 ? money(body.summary[key]) : String(body.summary[key]);
      });
    }).catch(handleAuth);
  }

  function handleAuth(error) { if (error.status === 401) showLogin(); else console.error(error); }

  var productModal = one('[data-product-modal]');
  var productForm = one('[data-product-form]');
  var productStatus = one('[data-product-status]');
  var variantList = one('[data-variant-list]');

  function complianceMap(rows) {
    var products = {}; var variants = {};
    (rows || []).forEach(function (row) {
      products[Number(row.product_id)] = Boolean(row.advertising_reviewed);
      if (row.variant_id) variants[Number(row.variant_id)] = row;
    });
    return { products: products, variants: variants };
  }

  function loadProducts() {
    Promise.all([api('/api/admin/retail/products'), api('/api/admin/retail/product-compliance')]).then(function (results) {
      var compliance = complianceMap(results[1].rows);
      state.products = (results[0].products || []).map(function (product) {
        product.advertisingReviewed = compliance.products[Number(product.id)] || false;
        product.variants = (product.variants || []).map(function (variant) {
          var extra = compliance.variants[Number(variant.id)] || {};
          variant.acquisitionCostCents = Number(extra.acquisition_cost_cents || 0);
          variant.limitCategory = extra.limit_category || '';
          variant.limitAmount = Number(extra.limit_amount || 0);
          return variant;
        });
        return product;
      });
      one('[data-products-table]').innerHTML = state.products.map(function (product) {
        var inventory = (product.variants || []).reduce(function (sum, variant) { return sum + Number(variant.inventoryQty || 0); }, 0);
        return '<tr data-product-id="' + Number(product.id) + '"><td><strong>' + esc(product.name) + '</strong><br><small>' + esc(product.brand || '') + '</small></td><td>' + esc(product.category) + '</td><td>' + (product.variants || []).length + '</td><td>' + inventory + '</td><td>' + (product.advertisingReviewed ? 'Reviewed' : '<strong>Required</strong>') + '</td><td>' + (product.active ? 'Live' : 'Inactive') + '</td></tr>';
      }).join('') || '<tr><td colspan="6">No products yet.</td></tr>';
    }).catch(handleAuth);
  }

  function variantRow(data) {
    data = data || {};
    var row = document.createElement('div');
    row.className = 'panel';
    row.setAttribute('data-variant-row', '');
    row.innerHTML = '<div class="form-grid"><label class="field"><span>SKU</span><input data-v="sku" required value="' + esc(data.sku || '') + '"></label><label class="field"><span>Package label</span><input data-v="label" required value="' + esc(data.label || '') + '"></label><label class="field"><span>Barcode</span><input data-v="barcode" value="' + esc(data.barcode || '') + '"></label><label class="field"><span>Inventory units</span><input data-v="inventoryQty" type="number" min="0" step="1" required value="' + Number(data.inventoryQty || 0) + '"></label><label class="field"><span>Acquisition cost</span><input data-v="acquisitionCost" type="number" min="0" step="0.01" required value="' + dollars(data.acquisitionCostCents) + '"></label><label class="field"><span>Regular price</span><input data-v="price" type="number" min="0" step="0.01" required value="' + dollars(data.priceCents) + '"></label><label class="field"><span>Sale price</span><input data-v="salePrice" type="number" min="0" step="0.01" value="' + (data.salePriceCents == null ? '' : dollars(data.salePriceCents)) + '"></label><label class="field"><span>Purchase-limit category</span><select data-v="limitCategory" required><option value="">Choose</option><option value="USABLE_CANNABIS_GRAMS">Usable cannabis grams</option><option value="CONCENTRATE_GRAMS">Concentrate grams</option><option value="INFUSED_SOLID_OUNCES">Infused solid ounces</option><option value="INFUSED_LIQUID_OUNCES">Infused liquid ounces</option><option value="INFUSED_LIQUID_LOW_DOSE_THC_MG">Low-dose liquid THC mg</option></select></label><label class="field"><span>Amount per package</span><input data-v="limitAmount" type="number" min="0.0001" step="0.0001" required value="' + Number(data.limitAmount || 0) + '"></label><label class="check"><input data-v="active" type="checkbox"' + (data.active !== false ? ' checked' : '') + '><span>Active package</span></label></div><button class="button secondary" type="button" data-remove-variant>Remove package</button>';
    one('[data-v="limitCategory"]', row).value = data.limitCategory || '';
    return row;
  }

  function openProduct(product) {
    state.selectedProduct = product || null;
    productForm.reset(); variantList.innerHTML = ''; productStatus.textContent = '';
    one('[data-product-modal-title]').textContent = product ? 'Edit ' + product.name : 'New product';
    productForm.elements.productId.value = product ? product.id : '';
    ['name','slug','brand','category','description','imageUrl','labUrl','vendorName'].forEach(function (name) { productForm.elements[name].value = product ? (product[name] || product[name.replace(/[A-Z]/g, function (letter) { return '_' + letter.toLowerCase(); })] || '') : ''; });
    productForm.elements.productForm.value = product ? (product.product_form || '') : '';
    productForm.elements.strainType.value = product ? (product.strain_type || '') : '';
    productForm.elements.thcText.value = product ? (product.thc_text || '') : '';
    productForm.elements.cbdText.value = product ? (product.cbd_text || '') : '';
    productForm.elements.sortOrder.value = product ? Number(product.sort_order || 0) : 0;
    productForm.elements.advertisingReviewed.checked = product ? product.advertisingReviewed : false;
    productForm.elements.featured.checked = product ? Boolean(product.featured) : false;
    productForm.elements.active.checked = product ? Boolean(product.active) : true;
    (product && product.variants || [{}]).forEach(function (variant) { variantList.appendChild(variantRow(variant)); });
    productModal.hidden = false;
  }

  function closeProduct() { productModal.hidden = true; }
  one('[data-new-product]').addEventListener('click', function () { openProduct(null); });
  all('[data-close-product]').forEach(function (button) { button.addEventListener('click', closeProduct); });
  one('[data-add-variant]').addEventListener('click', function () { variantList.appendChild(variantRow({})); });
  variantList.addEventListener('click', function (event) { var button = event.target.closest('[data-remove-variant]'); if (button && all('[data-variant-row]', variantList).length > 1) button.closest('[data-variant-row]').remove(); });
  one('[data-products-table]').addEventListener('click', function (event) { var row = event.target.closest('[data-product-id]'); if (row) openProduct(state.products.find(function (item) { return Number(item.id) === Number(row.getAttribute('data-product-id')); })); });

  function productPayload() {
    var payload = {};
    ['name','slug','brand','category','productForm','strainType','thcText','cbdText','description','imageUrl','labUrl','vendorName','sortOrder'].forEach(function (name) { payload[name] = productForm.elements[name].value; });
    payload.featured = productForm.elements.featured.checked;
    payload.active = productForm.elements.active.checked;
    payload.advertisingReviewed = productForm.elements.advertisingReviewed.checked;
    payload.variants = all('[data-variant-row]', variantList).map(function (row) {
      var item = {}; all('[data-v]', row).forEach(function (field) { item[field.getAttribute('data-v')] = field.type === 'checkbox' ? field.checked : field.value; }); return item;
    });
    return payload;
  }

  productForm.addEventListener('submit', function (event) {
    event.preventDefault(); if (!productForm.reportValidity()) return;
    var id = productForm.elements.productId.value; productStatus.textContent = 'Saving…';
    api(id ? '/api/admin/retail/products/' + id : '/api/admin/retail/products', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(productPayload()) })
      .then(function () { closeProduct(); loadProducts(); loadDashboard(); })
      .catch(function (error) { productStatus.textContent = error.message; productStatus.className = 'status error'; });
  });

  one('[data-upload-product-image]').addEventListener('click', function () {
    var file = one('[data-product-image]').files[0]; var uploadStatus = one('[data-upload-status]');
    if (!file) { uploadStatus.textContent = 'Choose an image first.'; return; }
    var data = new FormData(); data.append('image', file); uploadStatus.textContent = 'Uploading…';
    api('/api/admin/retail/upload', { method: 'POST', body: data }).then(function (body) { productForm.elements.imageUrl.value = body.url; uploadStatus.textContent = 'Image uploaded.'; }).catch(function (error) { uploadStatus.textContent = error.message; });
  });

  function loadOrders() {
    var filter = one('[data-order-status-filter]').value;
    api('/api/admin/retail/orders' + (filter ? '?status=' + encodeURIComponent(filter) : '')).then(function (body) {
      state.orders = body.orders || [];
      one('[data-orders-table]').innerHTML = state.orders.map(function (order) { return '<tr data-order-id="' + Number(order.id) + '"><td><strong>' + esc(order.order_number) + '</strong></td><td>' + esc(order.first_name + ' ' + order.last_name) + '<br><small>' + esc(order.email) + '</small></td><td>' + esc(order.pickup_window) + '</td><td>' + money(order.total_cents) + '</td><td>' + esc(order.status) + '</td><td>' + date(order.created_at) + '</td></tr>'; }).join('') || '<tr><td colspan="6">No pickup orders.</td></tr>';
    }).catch(handleAuth);
  }
  one('[data-order-status-filter]').addEventListener('change', loadOrders);
  one('[data-orders-table]').addEventListener('click', function (event) { var row = event.target.closest('[data-order-id]'); if (row) openOrder(Number(row.getAttribute('data-order-id'))); });

  var orderModal = one('[data-order-modal]'); var orderForm = one('[data-order-form]'); var orderStatus = one('[data-order-status]');
  function openOrder(id) {
    api('/api/admin/retail/orders/' + id).then(function (body) {
      var order = body.order; state.selectedOrder = order; orderForm.reset();
      one('[data-order-modal-title]').textContent = order.order_number;
      one('[data-order-detail]').innerHTML = '<div class="info-grid"><div class="card"><strong>Customer</strong><p>' + esc(order.first_name + ' ' + order.last_name) + '<br>' + esc(order.email) + '<br>' + esc(order.phone) + '</p></div><div class="card"><strong>Pickup</strong><p>' + esc(order.pickup_window) + '<br>Status: ' + esc(order.status) + '</p></div><div class="card"><strong>Total</strong><p>' + money(order.total_cents) + '<br>Payment: in store</p></div></div><h3>Products</h3><div class="table-wrap"><table><tbody>' + (order.items || []).map(function (item) { return '<tr><td>' + esc(item.product_name) + '</td><td>' + esc(item.variant_label) + '</td><td>' + Number(item.quantity) + '</td><td>' + money(item.line_total_cents) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      orderForm.elements.orderId.value = order.id; orderForm.elements.status.value = order.status; orderForm.elements.internalNotes.value = order.internal_notes || ''; orderForm.elements.posReceiptNumber.value = order.pos_receipt_number || ''; orderForm.elements.paymentProvider.value = order.payment_provider || ''; orderForm.elements.idVerified.checked = Boolean(order.id_verified_at); orderStatus.textContent = ''; orderModal.hidden = false;
    }).catch(handleAuth);
  }
  all('[data-close-order]').forEach(function (button) { button.addEventListener('click', function () { orderModal.hidden = true; }); });
  orderForm.addEventListener('submit', function (event) {
    event.preventDefault(); var data = new FormData(orderForm); var target = data.get('status');
    if (target === 'COMPLETED' && (!data.get('idVerified') || !data.get('posReceiptNumber'))) { orderStatus.textContent = 'ID verification and POS receipt number are required before completion.'; orderStatus.className = 'status error'; return; }
    api('/api/admin/retail/orders/' + data.get('orderId'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: target, paymentProvider: data.get('paymentProvider'), posReceiptNumber: data.get('posReceiptNumber'), note: data.get('note'), internalNotes: data.get('internalNotes'), idVerified: data.get('idVerified') === 'on' }) })
      .then(function () { orderModal.hidden = true; loadOrders(); loadDashboard(); })
      .catch(function (error) { orderStatus.textContent = error.message; orderStatus.className = 'status error'; });
  });

  var customerTimer;
  function loadCustomers() {
    var query = one('[data-customer-search]').value.trim();
    api('/api/admin/retail/customers' + (query ? '?q=' + encodeURIComponent(query) : '')).then(function (body) {
      state.customers = body.customers || [];
      one('[data-customers-table]').innerHTML = state.customers.map(function (customer) { return '<tr data-customer-id="' + Number(customer.id) + '"><td><strong>' + esc(customer.first_name + ' ' + customer.last_name) + '</strong></td><td>' + esc(customer.email) + '<br><small>' + esc(customer.phone) + '</small></td><td>' + Number(customer.order_count || 0) + '</td><td>' + money(customer.total_spend_cents) + '</td><td>' + (customer.marketing_opt_in ? 'WA opted in' : 'Not opted in') + '</td><td>' + date(customer.last_order_at) + '</td></tr>'; }).join('') || '<tr><td colspan="6">No customers.</td></tr>';
    }).catch(handleAuth);
  }
  one('[data-customer-search]').addEventListener('input', function () { clearTimeout(customerTimer); customerTimer = setTimeout(loadCustomers, 250); });
  one('[data-customers-table]').addEventListener('click', function (event) { var row = event.target.closest('[data-customer-id]'); if (row) openCustomer(Number(row.getAttribute('data-customer-id'))); });

  var customerModal = one('[data-customer-modal]'); var customerForm = one('[data-customer-form]'); var customerStatus = one('[data-customer-status]');
  function openCustomer(id) {
    api('/api/admin/retail/customers/' + id).then(function (body) {
      var customer = body.customer; state.selectedCustomer = customer; customerForm.reset();
      one('[data-customer-modal-title]').textContent = customer.first_name + ' ' + customer.last_name;
      one('[data-customer-detail]').innerHTML = '<div class="info-grid"><div class="card"><strong>Contact</strong><p>' + esc(customer.email) + '<br>' + esc(customer.phone) + '</p></div><div class="card"><strong>Orders</strong><p>' + Number(customer.order_count || 0) + '<br>' + money(customer.total_spend_cents) + '</p></div><div class="card"><strong>Marketing</strong><p>' + (customer.marketing_opt_in ? 'Opted in · ' + esc(customer.marketing_state) : 'Not opted in') + '</p></div></div>';
      customerForm.elements.customerId.value = customer.id; customerForm.elements.notes.value = customer.notes || ''; customerForm.elements.marketingOptIn.checked = Boolean(customer.marketing_opt_in); customerForm.elements.marketingState.checked = customer.marketing_state === 'WA'; customerStatus.textContent = ''; customerModal.hidden = false;
    }).catch(handleAuth);
  }
  all('[data-close-customer]').forEach(function (button) { button.addEventListener('click', function () { customerModal.hidden = true; }); });
  customerForm.addEventListener('submit', function (event) {
    event.preventDefault(); var data = new FormData(customerForm);
    api('/api/admin/retail/customers/' + data.get('customerId'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: data.get('notes'), marketingOptIn: data.get('marketingOptIn') === 'on', marketingState: data.get('marketingState') === 'WA' ? 'WA' : '' }) })
      .then(function () { customerModal.hidden = true; loadCustomers(); })
      .catch(function (error) { customerStatus.textContent = error.message; customerStatus.className = 'status error'; });
  });

  function loadCampaigns() {
    api('/api/admin/retail/campaigns').then(function (body) {
      state.campaigns = body.campaigns || [];
      one('[data-campaigns-table]').innerHTML = state.campaigns.map(function (campaign) { return '<tr><td><strong>' + esc(campaign.name) + '</strong><br><small>' + esc(campaign.subject) + '</small></td><td>' + esc(campaign.segment) + '</td><td>' + esc(campaign.status) + '</td><td>' + Number(campaign.recipient_count || 0) + '</td><td>' + Number(campaign.sent_count || 0) + '</td><td>' + (campaign.status === 'DRAFT' ? '<button class="button secondary" type="button" data-send-campaign="' + Number(campaign.id) + '">Review and send</button>' : '—') + '</td></tr>'; }).join('') || '<tr><td colspan="6">No campaigns.</td></tr>';
    }).catch(handleAuth);
  }
  one('[data-campaign-form]').addEventListener('submit', function (event) {
    event.preventDefault(); var form = event.currentTarget; if (!form.reportValidity()) return; var data = new FormData(form); var campaignStatus = one('[data-campaign-status]');
    api('/api/admin/retail/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(data.entries())) })
      .then(function () { form.reset(); form.elements.ctaLabel.value = 'View menu'; form.elements.ctaUrl.value = '/menu'; campaignStatus.textContent = 'Draft saved.'; campaignStatus.className = 'status success'; loadCampaigns(); })
      .catch(function (error) { campaignStatus.textContent = error.message; campaignStatus.className = 'status error'; });
  });
  one('[data-campaigns-table]').addEventListener('click', function (event) {
    var button = event.target.closest('[data-send-campaign]'); if (!button) return;
    if (!window.confirm('Send this campaign now to its eligible Washington 21+ audience? This cannot be undone.')) return;
    button.disabled = true; button.textContent = 'Sending…';
    api('/api/admin/retail/campaigns/' + button.getAttribute('data-send-campaign') + '/send', { method: 'POST' }).then(loadCampaigns).catch(function (error) { window.alert(error.message); button.disabled = false; button.textContent = 'Review and send'; });
  });

  function loadAutomations() {
    api('/api/admin/retail/automations').then(function (body) {
      state.automations = body;
      one('[data-rules-list]').innerHTML = (body.rules || []).map(function (rule) { return '<div class="alert"><strong>' + esc(rule.name) + '</strong><p>' + esc(rule.rule_key) + ' · Last run ' + date(rule.last_run_at) + '</p><label class="check"><input type="checkbox" data-toggle-rule="' + esc(rule.rule_key) + '"' + (rule.enabled ? ' checked' : '') + '><span>Enabled</span></label><button class="button secondary" type="button" data-run-rule="' + esc(rule.rule_key) + '">Run now</button></div>'; }).join('');
      one('[data-alerts-list]').innerHTML = (body.alerts || []).map(function (alert) { return '<div class="alert ' + (alert.severity === 'URGENT' ? 'urgent' : '') + '"><strong>' + esc(alert.title) + '</strong><p>' + esc(alert.details) + '</p><button class="button secondary" type="button" data-dismiss-alert="' + Number(alert.id) + '">Dismiss</button></div>'; }).join('') || '<div class="empty-state">No open automation alerts.</div>';
    }).catch(handleAuth);
  }
  one('[data-refresh-automations]').addEventListener('click', loadAutomations);
  one('[data-rules-list]').addEventListener('change', function (event) { var input = event.target.closest('[data-toggle-rule]'); if (!input) return; var rule = (state.automations.rules || []).find(function (item) { return item.rule_key === input.getAttribute('data-toggle-rule'); }); api('/api/admin/retail/automations/' + encodeURIComponent(rule.rule_key), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: input.checked, settings: rule.settings || {} }) }).then(loadAutomations).catch(function (error) { window.alert(error.message); }); });
  one('[data-rules-list]').addEventListener('click', function (event) { var button = event.target.closest('[data-run-rule]'); if (!button) return; api('/api/admin/retail/automations/' + encodeURIComponent(button.getAttribute('data-run-rule')) + '/run', { method: 'POST' }).then(loadAutomations).catch(function (error) { window.alert(error.message); }); });
  one('[data-alerts-list]').addEventListener('click', function (event) { var button = event.target.closest('[data-dismiss-alert]'); if (!button) return; api('/api/admin/retail/alerts/' + button.getAttribute('data-dismiss-alert'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'DISMISSED' }) }).then(loadAutomations).catch(function (error) { window.alert(error.message); }); });

  function loadCompliance() {
    Promise.all([api('/api/admin/compliance/summary'), api('/api/admin/compliance/requests'), api('/api/admin/retail/legal-summary')]).then(function (results) {
      var summary = results[0].summary || {}; state.privacyRequests = results[1].requests || []; var legal = results[2].summary || {};
      Object.keys(summary).forEach(function (key) { var target = one('[data-compliance-metric="' + key + '"]'); if (target) target.textContent = String(summary[key]); });
      var legalClear = Object.keys(legal).every(function (key) { return Number(legal[key] || 0) === 0; });
      one('[data-compliance-ready]').textContent = results[0].indexingReady && legalClear ? 'Ready' : 'Blocked';
      one('[data-privacy-requests-table]').innerHTML = state.privacyRequests.map(function (request) { return '<tr><td>' + esc(request.request_number) + '</td><td>' + esc(request.request_type) + '</td><td>' + esc(request.name) + '<br><small>' + esc(request.email) + '</small></td><td>' + esc(request.status) + '</td><td>' + date(request.created_at) + '</td><td><button class="button secondary" type="button" data-open-request="' + Number(request.id) + '">Review</button></td></tr>'; }).join('') || '<tr><td colspan="6">No privacy requests.</td></tr>';
    }).catch(handleAuth);
  }
  one('[data-refresh-compliance]').addEventListener('click', loadCompliance);

  var requestModal = one('[data-request-modal]'); var requestForm = one('[data-request-form]'); var requestStatus = one('[data-request-status]');
  one('[data-privacy-requests-table]').addEventListener('click', function (event) { var button = event.target.closest('[data-open-request]'); if (!button) return; var request = state.privacyRequests.find(function (item) { return Number(item.id) === Number(button.getAttribute('data-open-request')); }); if (!request) return; state.selectedRequest = request; requestForm.reset(); one('[data-request-title]').textContent = request.request_number; one('[data-request-detail]').innerHTML = '<div class="card"><strong>' + esc(request.name) + '</strong><p>' + esc(request.email) + '</p><p>' + esc(request.details || 'No details provided.') + '</p></div>'; requestForm.elements.requestId.value = request.id; requestForm.elements.status.value = request.status; requestForm.elements.verificationNotes.value = request.verification_notes || ''; requestForm.elements.resolutionNotes.value = request.resolution_notes || ''; requestStatus.textContent = ''; requestModal.hidden = false; });
  all('[data-close-request]').forEach(function (button) { button.addEventListener('click', function () { requestModal.hidden = true; }); });
  requestForm.addEventListener('submit', function (event) { event.preventDefault(); var data = new FormData(requestForm); api('/api/admin/compliance/requests/' + data.get('requestId'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: data.get('status'), verificationNotes: data.get('verificationNotes'), resolutionNotes: data.get('resolutionNotes') }) }).then(function () { requestModal.hidden = true; loadCompliance(); }).catch(function (error) { requestStatus.textContent = error.message; requestStatus.className = 'status error'; }); });

  api('/api/admin/me').then(function (body) { showShell(body.email); }).catch(showLogin);
})();
