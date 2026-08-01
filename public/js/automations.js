(function(){
  'use strict';

  var state={rules:[],alerts:[],runs:[],metrics:{},readiness:{}};
  var loginView=document.querySelector('[data-login-view]');
  var appView=document.querySelector('[data-automation-view]');
  var pageStatus=document.querySelector('[data-page-status]');

  function esc(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
  function api(url,options){return fetch(url,options||{}).then(function(response){return response.json().catch(function(){return{}}).then(function(body){if(!response.ok){var error=new Error(body.error||'Request failed.');error.status=response.status;throw error}return body})})}
  function formatDate(value){if(!value)return'Never';var date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleString()}
  function showLogin(){loginView.hidden=false;appView.hidden=true}
  function showApp(admin){loginView.hidden=true;appView.hidden=false;document.querySelector('[data-admin-email]').textContent=admin.email;load()}
  function authError(error){if(error&&error.status===401)showLogin();else{pageStatus.textContent=error.message||'Something went wrong.';pageStatus.className='page-status error'}}

  document.querySelector('[data-login-form]').addEventListener('submit',function(event){
    event.preventDefault();
    var status=document.querySelector('[data-login-status]');
    status.textContent='Signing in…';
    api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries()))})
      .then(function(result){status.textContent='';showApp(result.admin)})
      .catch(function(error){status.textContent=error.message});
  });
  document.querySelector('[data-logout]').addEventListener('click',function(){api('/api/admin/logout',{method:'POST'}).finally(showLogin)});
  document.querySelector('[data-refresh]').addEventListener('click',load);
  document.querySelector('[data-run-all]').addEventListener('click',function(event){
    var button=event.currentTarget;button.disabled=true;button.textContent='Running…';pageStatus.textContent='Running all enabled automations…';
    api('/api/admin/automations/run-all',{method:'POST'}).then(function(){pageStatus.textContent='Automation cycle completed.';return load()}).catch(authError).finally(function(){button.disabled=false;button.textContent='Run all now'});
  });

  function load(){
    pageStatus.textContent='Loading automation status…';
    return api('/api/admin/automations/summary').then(function(data){
      state=data;renderMetrics();renderReadiness();renderRules();renderAlerts();renderRuns();pageStatus.textContent='';
    }).catch(authError);
  }

  function renderMetrics(){
    Object.keys(state.metrics||{}).forEach(function(key){var node=document.querySelector('[data-metric="'+key+'"]');if(!node)return;node.textContent=key==='last_run_at'?formatDate(state.metrics[key]):String(state.metrics[key]==null?0:state.metrics[key])});
  }

  function renderReadiness(){
    var node=document.querySelector('[data-readiness-alert]');
    var readiness=state.readiness||{};
    if(readiness.emailReady){node.hidden=true;return}
    node.hidden=false;
    node.innerHTML='<strong>Internal email automation is not ready.</strong> Add '+esc((readiness.missing||[]).join(', '))+' in Railway. Tasks, alerts, and campaign drafts still run. Time zone: '+esc(readiness.timeZone||'America/Los_Angeles')+'.';
  }

  function fieldHtml(rule,field){
    var value=rule.config&&rule.config[field.key]!=null?rule.config[field.key]:'';
    if(field.type==='select')return'<label class="rule-field">'+esc(field.label)+'<select data-config-key="'+esc(field.key)+'">'+field.options.map(function(option){return'<option value="'+esc(option)+'"'+(String(value)===String(option)?' selected':'')+'>'+esc(option.replace(/_/g,' '))+'</option>'}).join('')+'</select></label>';
    return'<label class="rule-field">'+esc(field.label)+'<input type="number" value="'+esc(value)+'" min="'+esc(field.min)+'" max="'+esc(field.max)+'" data-config-key="'+esc(field.key)+'" /></label>';
  }

  function renderRules(){
    var grid=document.querySelector('[data-rule-grid]');
    if(!state.rules||!state.rules.length){grid.innerHTML='<div class="empty">No automation rules are available.</div>';return}
    grid.innerHTML=state.rules.map(function(rule){
      var definition=rule.definition||{};
      var fields=(definition.fields||[]).map(function(field){return fieldHtml(rule,field)}).join('');
      var lastResult=rule.last_result&&rule.last_result.error?'Last error: '+rule.last_result.error:'Last successful action count: '+String(rule.last_result&&rule.last_result.actions||0);
      return'<article class="rule-card'+(rule.enabled?' is-enabled':'')+'" data-rule-key="'+esc(rule.rule_key)+'">'
        +'<div class="rule-card-head"><div><span class="rule-category">'+esc(rule.category)+'</span><h3>'+esc(rule.name)+'</h3><p>'+esc(rule.description)+'</p></div>'
        +'<label class="switch" title="Enable or disable"><input type="checkbox" data-rule-enabled'+(rule.enabled?' checked':'')+' /><span class="slider"></span></label></div>'
        +'<div class="rule-fields">'+fields+'</div>'
        +'<div class="rule-meta"><span>Last run: '+esc(formatDate(rule.last_run_at))+'</span><span>'+esc(lastResult)+'</span></div>'
        +'<div class="rule-actions"><button class="secondary" type="button" data-run-rule>Run now</button><button class="primary" type="button" data-save-rule>Save rule</button></div>'
        +'<div class="rule-status" data-rule-status></div></article>';
    }).join('');

    grid.querySelectorAll('[data-rule-key]').forEach(function(card){
      card.querySelector('[data-rule-enabled]').addEventListener('change',function(event){card.classList.toggle('is-enabled',event.target.checked)});
      card.querySelector('[data-save-rule]').addEventListener('click',function(){saveRule(card)});
      card.querySelector('[data-run-rule]').addEventListener('click',function(){runRule(card)});
    });
  }

  function cardPayload(card){
    var config={};
    card.querySelectorAll('[data-config-key]').forEach(function(input){config[input.getAttribute('data-config-key')]=input.type==='number'?Number(input.value):input.value});
    return{enabled:card.querySelector('[data-rule-enabled]').checked,config:config};
  }

  function saveRule(card){
    var ruleKey=card.getAttribute('data-rule-key');
    var status=card.querySelector('[data-rule-status]');
    var button=card.querySelector('[data-save-rule]');
    button.disabled=true;status.textContent='Saving…';
    api('/api/admin/automations/rules/'+encodeURIComponent(ruleKey),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(cardPayload(card))})
      .then(function(){status.textContent='Saved.';setTimeout(function(){status.textContent=''},1400);return load()})
      .catch(function(error){status.textContent=error.message;status.className='rule-status error'})
      .finally(function(){button.disabled=false});
  }

  function runRule(card){
    var ruleKey=card.getAttribute('data-rule-key');
    var status=card.querySelector('[data-rule-status]');
    var button=card.querySelector('[data-run-rule]');
    button.disabled=true;status.textContent='Running…';
    api('/api/admin/automations/rules/'+encodeURIComponent(ruleKey)+'/run',{method:'POST'})
      .then(function(result){var r=result.result||{};status.textContent='Completed: '+String(r.matched||0)+' matched, '+String(r.actions||0)+' actions.';return load()})
      .catch(function(error){status.textContent=error.message;status.className='rule-status error'})
      .finally(function(){button.disabled=false});
  }

  function renderAlerts(){
    var body=document.querySelector('[data-alert-table]');
    if(!state.alerts||!state.alerts.length){body.innerHTML='<tr><td colspan="5" class="empty">No open automation alerts.</td></tr>';return}
    body.innerHTML=state.alerts.map(function(alert){return'<tr data-alert-id="'+alert.id+'"><td><span class="badge '+esc(alert.severity)+'">'+esc(alert.severity)+'</span></td><td><strong>'+esc(alert.title)+'</strong></td><td>'+esc(alert.details)+'</td><td>'+esc(formatDate(alert.created_at))+'</td><td><button class="secondary" type="button" data-dismiss-alert>Dismiss</button></td></tr>'}).join('');
    body.querySelectorAll('[data-dismiss-alert]').forEach(function(button){button.addEventListener('click',function(){var row=button.closest('[data-alert-id]');button.disabled=true;api('/api/admin/automations/alerts/'+row.getAttribute('data-alert-id'),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'DISMISSED'})}).then(load).catch(authError)})});
  }

  function renderRuns(){
    var body=document.querySelector('[data-run-table]');
    if(!state.runs||!state.runs.length){body.innerHTML='<tr><td colspan="6" class="empty">No automation runs recorded yet.</td></tr>';return}
    body.innerHTML=state.runs.map(function(run){return'<tr><td>'+esc(String(run.rule_key||'').replace(/_/g,' '))+'</td><td><span class="badge '+esc(run.status)+'">'+esc(run.status)+'</span></td><td>'+esc(run.matched_count)+'</td><td>'+esc(run.action_count)+'</td><td>'+esc(formatDate(run.started_at))+'</td><td class="'+(run.error_message?'error':'')+'">'+esc(run.error_message||'—')+'</td></tr>'}).join('');
  }

  api('/api/admin/me').then(function(result){showApp(result.admin)}).catch(function(error){if(error.status===401)showLogin();else authError(error)});
})();
