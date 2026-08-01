(function () {
  'use strict';

  var form = document.querySelector('[data-privacy-form]');
  if (!form) return;
  var status = form.querySelector('[data-privacy-status]');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    var data = new FormData(form);
    var payload = {
      requestType: data.get('requestType'),
      name: data.get('name'),
      email: data.get('email'),
      details: data.get('details'),
      confirmed: data.get('confirmed') === 'true'
    };
    status.textContent = 'Submitting request…';
    status.className = 'status';

    fetch('/api/privacy-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || 'Request could not be submitted.');
        status.textContent = result.body.message + ' Reference: ' + result.body.requestNumber;
        status.className = 'status success';
        form.reset();
      })
      .catch(function (error) {
        status.textContent = error.message;
        status.className = 'status error';
      });
  });
})();
