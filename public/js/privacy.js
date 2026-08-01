(function () {
  'use strict';

  var form = document.querySelector('[data-privacy-request-form]');
  if (!form) return;

  var status = form.querySelector('[data-privacy-status]');
  var button = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!form.reportValidity()) return;

    var data = Object.fromEntries(new FormData(form).entries());
    data.confirmed = Boolean(form.elements.confirmed && form.elements.confirmed.checked);

    button.disabled = true;
    status.textContent = 'Submitting request…';
    status.className = 'form-status';

    fetch('/api/privacy-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'The request could not be submitted.');
        status.textContent = result.body.message + ' Reference: ' + result.body.requestNumber + '.';
        status.className = 'form-status success';
        form.reset();
      })
      .catch(function (error) {
        status.textContent = error.message;
        status.className = 'form-status error';
      })
      .finally(function () {
        button.disabled = false;
      });
  });
})();
