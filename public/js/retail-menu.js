(function () {
  'use strict';

  var app = document.querySelector('[data-menu-app]');
  if (!app || !window.RetailCart) return;

  var products = [];
  var search = app.querySelector('[data-menu-search]');
  var category = app.querySelector('[data-menu-category]');
  var clear = app.querySelector('[data-menu-clear]');
  var grid = app.querySelector('[data-product-grid]');
  var status = app.querySelector('[data-menu-status]');

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function effectivePrice(variant) {
    return variant.salePriceCents == null
      ? Number(variant.priceCents || 0)
      : Math.min(Number(variant.priceCents || 0), Number(variant.salePriceCents || 0));
  }

  function render() {
    var query = String(search.value || '').trim().toLowerCase();
    var selected = String(category.value || '');
    var filtered = products.filter(function (product) {
      var haystack = [product.name, product.brand, product.category, product.productForm, product.strainType, product.description]
        .join(' ').toLowerCase();
      return (!query || haystack.indexOf(query) !== -1) && (!selected || product.category === selected);
    });

    if (!filtered.length) {
      grid.innerHTML = '<div class="empty-state">No current products match those filters.</div>';
      status.textContent = '';
      return;
    }

    grid.innerHTML = filtered.map(function (product) {
      var image = product.imageUrl
        ? '<img src="' + esc(product.imageUrl) + '" alt="' + esc(product.name) + ' product package">'
        : '<span>Product image pending</span>';
      var meta = [product.brand, product.category, product.productForm, product.strainType].filter(Boolean)
        .map(function (item) { return '<span class="pill">' + esc(item) + '</span>'; }).join('');
      var cannabinoids = [product.thcText ? 'THC ' + product.thcText : '', product.cbdText ? 'CBD ' + product.cbdText : ''].filter(Boolean).join(' · ');
      var variants = (product.variants || []).map(function (variant) {
        var price = effectivePrice(variant);
        var pricing = variant.salePriceCents == null
          ? '<span class="price">' + window.RetailCart.money(price) + '</span>'
          : '<span class="old-price">' + window.RetailCart.money(variant.priceCents) + '</span><span class="price sale">' + window.RetailCart.money(price) + '</span>';
        var disabled = Number(variant.inventoryQty || 0) < 1;
        var stock = variant.status === 'LOW STOCK' ? 'LOW STOCK' : 'AVAILABLE';
        return '<div class="package-row"><div><strong>' + esc(variant.label) + '</strong><small>' + esc(cannabinoids || 'See package label in store') + ' · <span class="stock-text ' + (stock === 'LOW STOCK' ? 'low-stock' : 'available') + '">' + stock + '</span></small></div><div>' + pricing + '<button class="button primary" type="button" data-add-product="' + Number(product.id) + '" data-add-variant="' + Number(variant.id) + '"' + (disabled ? ' disabled' : '') + '>' + (disabled ? 'Unavailable' : 'Add') + '</button></div></div>';
      }).join('');
      return '<article class="product-card"><div class="product-image">' + image + '</div><div class="product-body"><div class="product-meta">' + meta + '</div><div><h3>' + esc(product.name) + '</h3><p class="product-copy">' + esc(product.description || '') + '</p></div>' + variants + '</div></article>';
    }).join('');

    status.textContent = filtered.length + ' current product' + (filtered.length === 1 ? '' : 's');
  }

  app.addEventListener('click', function (event) {
    var button = event.target.closest('[data-add-variant]');
    if (!button) return;
    var product = products.find(function (item) { return Number(item.id) === Number(button.getAttribute('data-add-product')); });
    var variant = product && (product.variants || []).find(function (item) { return Number(item.id) === Number(button.getAttribute('data-add-variant')); });
    if (!product || !variant || Number(variant.inventoryQty || 0) < 1) return;
    window.RetailCart.add({
      variantId: variant.id,
      productId: product.id,
      productName: product.name,
      variantLabel: variant.label,
      priceCents: effectivePrice(variant),
      imageUrl: product.imageUrl,
      quantity: 1
    });
    button.textContent = 'Added';
    setTimeout(function () { button.textContent = 'Add'; }, 900);
  });

  search.addEventListener('input', render);
  category.addEventListener('change', render);
  clear.addEventListener('click', function () { search.value = ''; category.value = ''; render(); });

  fetch('/api/retail/products')
    .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
    .then(function (result) {
      if (!result.ok || !result.data.ok) throw new Error(result.data.error || 'Menu unavailable.');
      products = result.data.products || [];
      Array.from(new Set(products.map(function (product) { return product.category; }).filter(Boolean))).sort().forEach(function (name) {
        var option = document.createElement('option'); option.value = name; option.textContent = name; category.appendChild(option);
      });
      render();
    })
    .catch(function (error) { status.textContent = error.message; status.className = 'status error'; });
})();
