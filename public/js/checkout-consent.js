(function () {
  'use strict';

  var form = document.querySelector('[data-checkout-form]');
  if (!form) return;

  form.addEventListener('submit', function () {
    if (!form.elements.marketingConsent || !form.elements.marketingConsent.checked) return;

    fetch('/api/marketing/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: form.elements.businessName.value,
        contactName: form.elements.contactName.value,
        email: form.elements.email.value,
        licenseNumber: form.elements.licenseNumber.value,
        state: 'WA',
        emailOptIn: true
      })
    }).catch(function (error) {
      console.error('Marketing subscription failed:', error);
    });
  });
})();
