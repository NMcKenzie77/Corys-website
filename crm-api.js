'use strict';

const { pool, withTransaction } = require('./db');
const { requireAdmin } = require('./auth');

const STAGES=['UNCONTACTED','RESEARCHING','CONTACTED','FOLLOW_UP','SAMPLE_REQUESTED','NEGOTIATING','CUSTOMER','NOT_A_FIT','DO_NOT_CONTACT'];
const PRIORITIES=['LOW','NORMAL','HIGH','URGENT'];
const ACTIVITY_TYPES=['CALL','EMAIL','VISIT','MEETING','SAMPLE','NOTE','ORDER','OTHER'];
const TASK_STATUSES=['OPEN','DONE','CANCELLED'];

function text(value,max=500){return String(value==null?'':value).trim().slice(0,max)}
function email(value){const v=text(value,200).toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)?v:''}
function bool(value){return value===true||value==='true'||value===1||value==='1'||String(value).toLowerCase()==='yes'}
function dateOrNull(value){const v=text(value,40);return /^\d{4}-\d{2}-\d{2}/.test(v)?v:null}
function httpError(message,status=400){const e=new Error(message);e.status=status;return e}
function validateEnum(value,allowed,fallback){const v=text(value,50).toUpperCase();return allowed.includes(v)?v:fallback}
function pick(source,keys){const normalized=Object.fromEntries(Object.entries(source||{}).map(([key,value])=>[String(key).toLowerCase().replace(/[^a-z0-9]/g,''),value]));for(const key of keys){const value=normalized[String(key).toLowerCase().replace(/[^a-z0-9]/g,'')];if(value!=null&&String(value).trim()!=='')return value}return''}
function normalizeLicenseStatus(value){const raw=text(value,100)||'Unknown';const upper=raw.toUpperCase();return{raw,active:upper==='ACTIVE'||upper==='PENDING (ISSUED)'}}

async function ensureCrmSchema(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_import_batches(
      id BIGSERIAL PRIMARY KEY,source_name TEXT NOT NULL,source_url TEXT NOT NULL DEFAULT '',source_as_of DATE,
      usage_basis TEXT NOT NULL,commercial_use_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,row_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,updated_count INTEGER NOT NULL DEFAULT 0,rejected_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS crm_accounts(
      id BIGSERIAL PRIMARY KEY,license_number TEXT NOT NULL UNIQUE,legal_name TEXT NOT NULL DEFAULT '',trade_name TEXT NOT NULL,
      privilege_status TEXT NOT NULL DEFAULT 'Unknown',license_active BOOLEAN NOT NULL DEFAULT FALSE,license_type TEXT NOT NULL DEFAULT 'Cannabis Retailer',
      address1 TEXT NOT NULL DEFAULT '',address2 TEXT NOT NULL DEFAULT '',city TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'WA',
      postal_code TEXT NOT NULL DEFAULT '',county TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',general_email TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',medical_endorsed BOOLEAN NOT NULL DEFAULT FALSE,stage TEXT NOT NULL DEFAULT 'UNCONTACTED',
      priority TEXT NOT NULL DEFAULT 'NORMAL',do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,assigned_to TEXT NOT NULL DEFAULT '',
      last_contact_at TIMESTAMPTZ,next_action TEXT NOT NULL DEFAULT '',next_action_at TIMESTAMPTZ,notes TEXT NOT NULL DEFAULT '',
      source_name TEXT NOT NULL DEFAULT '',source_url TEXT NOT NULL DEFAULT '',source_as_of DATE,source_usage_basis TEXT NOT NULL DEFAULT '',
      source_import_batch_id BIGINT REFERENCES crm_import_batches(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS crm_contacts(
      id BIGSERIAL PRIMARY KEY,account_id BIGINT NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',email TEXT,phone TEXT NOT NULL DEFAULT '',is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,consent_source TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(account_id,email)
    );
    ALTER TABLE crm_contacts ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE crm_contacts ALTER COLUMN email DROP DEFAULT;
    CREATE TABLE IF NOT EXISTS crm_activities(
      id BIGSERIAL PRIMARY KEY,account_id BIGINT NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
      contact_id BIGINT REFERENCES crm_contacts(id) ON DELETE SET NULL,activity_type TEXT NOT NULL,direction TEXT NOT NULL DEFAULT 'OUTBOUND',
      subject TEXT NOT NULL DEFAULT '',details TEXT NOT NULL DEFAULT '',outcome TEXT NOT NULL DEFAULT '',occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS crm_tasks(
      id BIGSERIAL PRIMARY KEY,account_id BIGINT NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
      contact_id BIGINT REFERENCES crm_contacts(id) ON DELETE SET NULL,title TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',due_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'OPEN',priority TEXT NOT NULL DEFAULT 'NORMAL',assigned_to TEXT NOT NULL DEFAULT '',completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_crm_accounts_stage ON crm_accounts(stage,priority,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_accounts_license_active ON crm_accounts(license_active,privilege_status);
    CREATE INDEX IF NOT EXISTS idx_crm_accounts_location ON crm_accounts(county,city);
    CREATE INDEX IF NOT EXISTS idx_crm_tasks_due ON crm_tasks(status,due_at);
    CREATE INDEX IF NOT EXISTS idx_crm_activities_account ON crm_activities(account_id,occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_account ON crm_contacts(account_id);
  `);
}

function accountPayload(body){
  const licenseNumber=text(body.licenseNumber,120);const tradeName=text(body.tradeName||body.legalName,200);
  if(!licenseNumber||!tradeName)throw httpError('License number and shop name are required.');
  const status=normalizeLicenseStatus(body.privilegeStatus);
  return{licenseNumber,legalName:text(body.legalName,200),tradeName,privilegeStatus:status.raw,
    licenseActive:body.licenseActive==null?status.active:bool(body.licenseActive),licenseType:text(body.licenseType,120)||'Cannabis Retailer',
    address1:text(body.address1,240),address2:text(body.address2,120),city:text(body.city,120),state:text(body.state,2).toUpperCase()||'WA',
    postalCode:text(body.postalCode,20),county:text(body.county,120),phone:text(body.phone,60),generalEmail:email(body.generalEmail),
    website:text(body.website,500),medicalEndorsed:bool(body.medicalEndorsed),stage:validateEnum(body.stage,STAGES,'UNCONTACTED'),
    priority:validateEnum(body.priority,PRIORITIES,'NORMAL'),doNotContact:bool(body.doNotContact),assignedTo:text(body.assignedTo,200),
    nextAction:text(body.nextAction,500),nextActionAt:dateOrNull(body.nextActionAt),notes:text(body.notes,10000),sourceName:text(body.sourceName,240),
    sourceUrl:text(body.sourceUrl,1000),sourceAsOf:dateOrNull(body.sourceAsOf),sourceUsageBasis:text(body.sourceUsageBasis,1000)};
}
function importPayload(row){
  const status=normalizeLicenseStatus(pick(row,['privilegeStatus','privilege status','status']));
  return{licenseNumber:text(pick(row,['licenseNumber','license number','license#','license']),120),
    legalName:text(pick(row,['legalName','legal name','applicantName','applicant name','businessName']),200),
    tradeName:text(pick(row,['tradeName','trade name','storeName','retail store name','businessName','business name']),200),
    privilegeStatus:status.raw,licenseActive:status.active,licenseType:text(pick(row,['licenseType','license type','privilege']),120)||'Cannabis Retailer',
    address1:text(pick(row,['address1','address','streetAddress','street address']),240),address2:text(pick(row,['address2','suite','unit']),120),
    city:text(pick(row,['city']),120),state:text(pick(row,['state']),2).toUpperCase()||'WA',postalCode:text(pick(row,['postalCode','zip','zipCode','postal code']),20),
    county:text(pick(row,['county']),120),phone:text(pick(row,['phone','telephone']),60),generalEmail:email(pick(row,['email','generalEmail','general email'])),
    website:text(pick(row,['website','url']),500),medicalEndorsed:bool(pick(row,['medicalEndorsed','medical endorsed']))};
}

function registerCrm(app){
  app.get('/api/admin/crm/summary',requireAdmin,async(_req,res,next)=>{try{
    const result=await pool.query(`SELECT COUNT(*)::int total_accounts,COUNT(*) FILTER(WHERE license_active=TRUE)::int active_accounts,
      COUNT(*) FILTER(WHERE stage='UNCONTACTED')::int uncontacted,COUNT(*) FILTER(WHERE stage='CUSTOMER')::int customers,
      COUNT(*) FILTER(WHERE general_email='')::int missing_email,
      (SELECT COUNT(*)::int FROM crm_accounts a WHERE (a.next_action_at IS NOT NULL AND a.next_action_at<=NOW()) OR EXISTS(SELECT 1 FROM crm_tasks t WHERE t.account_id=a.id AND t.status='OPEN' AND t.due_at IS NOT NULL AND t.due_at<=NOW())) followups_due
      FROM crm_accounts`);
    const stages=await pool.query('SELECT stage,COUNT(*)::int count FROM crm_accounts GROUP BY stage ORDER BY stage');
    res.json({ok:true,summary:result.rows[0],stages:stages.rows});
  }catch(error){next(error)}});

  app.get('/api/admin/crm/accounts',requireAdmin,async(req,res,next)=>{try{
    const where=[];const values=[];const param=(value)=>{values.push(value);return`$${values.length}`};
    const q=text(req.query.q,120);if(q){const p=param(q);where.push(`(a.trade_name ILIKE '%'||${p}||'%' OR a.legal_name ILIKE '%'||${p}||'%' OR a.license_number ILIKE '%'||${p}||'%' OR a.city ILIKE '%'||${p}||'%' OR a.county ILIKE '%'||${p}||'%')`)}
    const stage=validateEnum(req.query.stage,STAGES,'');if(stage)where.push(`a.stage=${param(stage)}`);
    const status=text(req.query.status,30).toUpperCase();if(status==='ACTIVE')where.push(`a.license_active=${param(true)}`);if(status==='INACTIVE')where.push(`a.license_active=${param(false)}`);
    const county=text(req.query.county,120);if(county)where.push(`a.county=${param(county)}`);
    if(req.query.due==='true')where.push(`((a.next_action_at IS NOT NULL AND a.next_action_at<=NOW()) OR EXISTS(SELECT 1 FROM crm_tasks t WHERE t.account_id=a.id AND t.status='OPEN' AND t.due_at IS NOT NULL AND t.due_at<=NOW()))`);
    const result=await pool.query(`SELECT a.*,COALESCE(os.order_count,0)::int order_count,COALESCE(os.order_value_cents,0)::bigint order_value_cents,
      pc.name primary_contact_name,pc.email primary_contact_email,pc.phone primary_contact_phone,ot.title next_task_title,ot.due_at next_task_due_at
      FROM crm_accounts a
      LEFT JOIN LATERAL(SELECT COUNT(*) order_count,COALESCE(SUM(o.total_cents),0) order_value_cents FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.license_number=a.license_number AND o.status<>'CANCELLED')os ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM crm_contacts c WHERE c.account_id=a.id ORDER BY c.is_primary DESC,c.id LIMIT 1)pc ON TRUE
      LEFT JOIN LATERAL(SELECT * FROM crm_tasks t WHERE t.account_id=a.id AND t.status='OPEN' ORDER BY t.due_at NULLS LAST,t.id LIMIT 1)ot ON TRUE
      ${where.length?`WHERE ${where.join(' AND ')}`:''}
      ORDER BY CASE a.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,a.next_action_at NULLS LAST,a.updated_at DESC LIMIT 1000`,values);
    const counties=await pool.query("SELECT DISTINCT county FROM crm_accounts WHERE county<>'' ORDER BY county");
    res.json({ok:true,accounts:result.rows,counties:counties.rows.map(row=>row.county)});
  }catch(error){next(error)}});

  app.get('/api/admin/crm/accounts/:id',requireAdmin,async(req,res,next)=>{try{
    const id=Number(req.params.id);const account=await pool.query('SELECT * FROM crm_accounts WHERE id=$1',[id]);if(!account.rowCount)throw httpError('Shop not found.',404);
    const [contacts,activities,tasks,orders]=await Promise.all([
      pool.query('SELECT * FROM crm_contacts WHERE account_id=$1 ORDER BY is_primary DESC,name,id',[id]),
      pool.query('SELECT a.*,c.name contact_name FROM crm_activities a LEFT JOIN crm_contacts c ON c.id=a.contact_id WHERE a.account_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 250',[id]),
      pool.query("SELECT t.*,c.name contact_name FROM crm_tasks t LEFT JOIN crm_contacts c ON c.id=t.contact_id WHERE t.account_id=$1 ORDER BY CASE t.status WHEN 'OPEN' THEN 0 ELSE 1 END,t.due_at NULLS LAST,t.id DESC",[id]),
      pool.query('SELECT o.order_number,o.status,o.total_cents,o.created_at FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.license_number=$1 ORDER BY o.created_at DESC',[account.rows[0].license_number])]);
    res.json({ok:true,account:account.rows[0],contacts:contacts.rows,activities:activities.rows,tasks:tasks.rows,orders:orders.rows});
  }catch(error){next(error)}});

  app.post('/api/admin/crm/accounts',requireAdmin,async(req,res,next)=>{try{
    const a=accountPayload(req.body||{});const result=await pool.query(`INSERT INTO crm_accounts(license_number,legal_name,trade_name,privilege_status,license_active,license_type,address1,address2,city,state,postal_code,county,phone,general_email,website,medical_endorsed,stage,priority,do_not_contact,assigned_to,next_action,next_action_at,notes,source_name,source_url,source_as_of,source_usage_basis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,[a.licenseNumber,a.legalName,a.tradeName,a.privilegeStatus,a.licenseActive,a.licenseType,a.address1,a.address2,a.city,a.state,a.postalCode,a.county,a.phone,a.generalEmail,a.website,a.medicalEndorsed,a.stage,a.priority,a.doNotContact,a.assignedTo,a.nextAction,a.nextActionAt,a.notes,a.sourceName,a.sourceUrl,a.sourceAsOf,a.sourceUsageBasis]);
    res.status(201).json({ok:true,account:result.rows[0]});
  }catch(error){next(error)}});

  app.put('/api/admin/crm/accounts/:id',requireAdmin,async(req,res,next)=>{try{
    const a=accountPayload(req.body||{});const id=Number(req.params.id);const result=await pool.query(`UPDATE crm_accounts SET license_number=$1,legal_name=$2,trade_name=$3,privilege_status=$4,license_active=$5,license_type=$6,address1=$7,address2=$8,city=$9,state=$10,postal_code=$11,county=$12,phone=$13,general_email=$14,website=$15,medical_endorsed=$16,stage=$17,priority=$18,do_not_contact=$19,assigned_to=$20,next_action=$21,next_action_at=$22,notes=$23,source_name=$24,source_url=$25,source_as_of=$26,source_usage_basis=$27,updated_at=NOW() WHERE id=$28 RETURNING *`,[a.licenseNumber,a.legalName,a.tradeName,a.privilegeStatus,a.licenseActive,a.licenseType,a.address1,a.address2,a.city,a.state,a.postalCode,a.county,a.phone,a.generalEmail,a.website,a.medicalEndorsed,a.stage,a.priority,a.doNotContact,a.assignedTo,a.nextAction,a.nextActionAt,a.notes,a.sourceName,a.sourceUrl,a.sourceAsOf,a.sourceUsageBasis,id]);
    if(!result.rowCount)throw httpError('Shop not found.',404);res.json({ok:true,account:result.rows[0]});
  }catch(error){next(error)}});

  app.post('/api/admin/crm/import',requireAdmin,async(req,res,next)=>{try{
    const body=req.body||{};const rows=Array.isArray(body.accounts)?body.accounts.slice(0,5000):[];const sourceName=text(body.sourceName,240);const usageBasis=text(body.usageBasis,1000);
    if(!rows.length||!sourceName||!usageBasis||body.commercialUseConfirmed!==true)throw httpError('Provide rows, source details, and confirm lawful commercial use.');
    const saved=await withTransaction(async client=>{const batch=await client.query('INSERT INTO crm_import_batches(source_name,source_url,source_as_of,usage_basis,commercial_use_acknowledged,row_count,created_by) VALUES($1,$2,$3,$4,TRUE,$5,$6) RETURNING *',[sourceName,text(body.sourceUrl,1000),dateOrNull(body.sourceAsOf),usageBasis,rows.length,req.admin.email]);let inserted=0,updated=0;const errors=[];
      for(let index=0;index<rows.length;index++){try{const a=importPayload(rows[index]);if(!a.licenseNumber||!a.tradeName)throw httpError('License number and shop name are required.');const result=await client.query(`INSERT INTO crm_accounts(license_number,legal_name,trade_name,privilege_status,license_active,license_type,address1,address2,city,state,postal_code,county,phone,general_email,website,medical_endorsed,source_name,source_url,source_as_of,source_usage_basis,source_import_batch_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT(license_number) DO UPDATE SET legal_name=EXCLUDED.legal_name,trade_name=EXCLUDED.trade_name,privilege_status=EXCLUDED.privilege_status,license_active=EXCLUDED.license_active,license_type=EXCLUDED.license_type,address1=EXCLUDED.address1,address2=EXCLUDED.address2,city=EXCLUDED.city,state=EXCLUDED.state,postal_code=EXCLUDED.postal_code,county=EXCLUDED.county,phone=CASE WHEN EXCLUDED.phone<>'' THEN EXCLUDED.phone ELSE crm_accounts.phone END,general_email=CASE WHEN EXCLUDED.general_email<>'' THEN EXCLUDED.general_email ELSE crm_accounts.general_email END,website=CASE WHEN EXCLUDED.website<>'' THEN EXCLUDED.website ELSE crm_accounts.website END,medical_endorsed=EXCLUDED.medical_endorsed,source_name=EXCLUDED.source_name,source_url=EXCLUDED.source_url,source_as_of=EXCLUDED.source_as_of,source_usage_basis=EXCLUDED.source_usage_basis,source_import_batch_id=EXCLUDED.source_import_batch_id,updated_at=NOW() RETURNING(xmax=0)inserted`,[a.licenseNumber,a.legalName,a.tradeName,a.privilegeStatus,a.licenseActive,a.licenseType,a.address1,a.address2,a.city,a.state,a.postalCode,a.county,a.phone,a.generalEmail,a.website,a.medicalEndorsed,sourceName,text(body.sourceUrl,1000),dateOrNull(body.sourceAsOf),usageBasis,batch.rows[0].id]);if(result.rows[0].inserted)inserted++;else updated++}catch(error){errors.push({row:index+2,error:error.message})}}
      await client.query('UPDATE crm_import_batches SET inserted_count=$1,updated_count=$2,rejected_count=$3 WHERE id=$4',[inserted,updated,errors.length,batch.rows[0].id]);return{batchId:batch.rows[0].id,inserted,updated,rejected:errors.length,errors:errors.slice(0,100)}});
    res.json({ok:true,...saved});
  }catch(error){next(error)}});

  app.post('/api/admin/crm/accounts/:id/contacts',requireAdmin,async(req,res,next)=>{try{
    const accountId=Number(req.params.id);const body=req.body||{};const contactEmail=email(body.email);if(!text(body.name,200)&&!contactEmail&&!text(body.phone,60))throw httpError('Add a name, email, or phone.');
    const saved=await withTransaction(async client=>{if(bool(body.isPrimary))await client.query('UPDATE crm_contacts SET is_primary=FALSE WHERE account_id=$1',[accountId]);let result;
      if(contactEmail){result=await client.query(`INSERT INTO crm_contacts(account_id,name,title,email,phone,is_primary,do_not_contact,consent_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id,email) DO UPDATE SET name=EXCLUDED.name,title=EXCLUDED.title,phone=EXCLUDED.phone,is_primary=EXCLUDED.is_primary,do_not_contact=EXCLUDED.do_not_contact,consent_source=EXCLUDED.consent_source,updated_at=NOW() RETURNING *`,[accountId,text(body.name,200),text(body.title,160),contactEmail,text(body.phone,60),bool(body.isPrimary),bool(body.doNotContact),text(body.consentSource,500)])}
      else result=await client.query('INSERT INTO crm_contacts(account_id,name,title,email,phone,is_primary,do_not_contact,consent_source) VALUES($1,$2,$3,NULL,$4,$5,$6,$7) RETURNING *',[accountId,text(body.name,200),text(body.title,160),text(body.phone,60),bool(body.isPrimary),bool(body.doNotContact),text(body.consentSource,500)]);
      if(contactEmail&&bool(body.marketingOptIn)&&bool(body.consentConfirmed)){const account=await client.query('SELECT trade_name,license_number,state FROM crm_accounts WHERE id=$1',[accountId]);if(account.rowCount)await client.query(`INSERT INTO marketing_contacts(business_name,contact_name,email,license_number,state,status,source,consent_at,unsubscribed_at) VALUES($1,$2,$3,$4,$5,'SUBSCRIBED','crm-explicit-consent',NOW(),NULL) ON CONFLICT(email) DO UPDATE SET business_name=EXCLUDED.business_name,contact_name=EXCLUDED.contact_name,license_number=EXCLUDED.license_number,state=EXCLUDED.state,status='SUBSCRIBED',source='crm-explicit-consent',consent_at=NOW(),unsubscribed_at=NULL,updated_at=NOW()`,[account.rows[0].trade_name,text(body.name,200),contactEmail,account.rows[0].license_number,account.rows[0].state])}
      return result.rows[0]});res.status(201).json({ok:true,contact:saved});
  }catch(error){next(error)}});

  app.put('/api/admin/crm/contacts/:id',requireAdmin,async(req,res,next)=>{try{
    const id=Number(req.params.id);const body=req.body||{};const existing=await pool.query('SELECT * FROM crm_contacts WHERE id=$1',[id]);if(!existing.rowCount)throw httpError('Contact not found.',404);if(bool(body.isPrimary))await pool.query('UPDATE crm_contacts SET is_primary=FALSE WHERE account_id=$1',[existing.rows[0].account_id]);
    const result=await pool.query('UPDATE crm_contacts SET name=$1,title=$2,email=$3,phone=$4,is_primary=$5,do_not_contact=$6,updated_at=NOW() WHERE id=$7 RETURNING *',[text(body.name,200),text(body.title,160),email(body.email)||null,text(body.phone,60),bool(body.isPrimary),bool(body.doNotContact),id]);res.json({ok:true,contact:result.rows[0]});
  }catch(error){next(error)}});

  app.post('/api/admin/crm/accounts/:id/activities',requireAdmin,async(req,res,next)=>{try{
    const accountId=Number(req.params.id);const body=req.body||{};const type=validateEnum(body.activityType,ACTIVITY_TYPES,'NOTE');const explicitStage=validateEnum(body.stage,STAGES,'');const nextAction=text(body.nextAction,500);const nextActionAt=dateOrNull(body.nextActionAt);
    const saved=await withTransaction(async client=>{const activity=await client.query('INSERT INTO crm_activities(account_id,contact_id,activity_type,direction,subject,details,outcome,occurred_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,NOW()),$9) RETURNING *',[accountId,Number(body.contactId)||null,type,text(body.direction,30).toUpperCase()||'OUTBOUND',text(body.subject,300),text(body.details,5000),text(body.outcome,1000),dateOrNull(body.occurredAt),req.admin.email]);
      await client.query(`UPDATE crm_accounts SET last_contact_at=CASE WHEN $1='NOTE' THEN last_contact_at ELSE NOW() END,
        stage=CASE WHEN $2<>'' THEN $2 WHEN $1<>'NOTE' AND stage IN('UNCONTACTED','RESEARCHING') THEN 'CONTACTED' ELSE stage END,
        next_action=CASE WHEN $3<>'' THEN $3 ELSE next_action END,next_action_at=COALESCE($4,next_action_at),updated_at=NOW() WHERE id=$5`,[type,explicitStage,nextAction,nextActionAt,accountId]);
      if(nextAction)await client.query('INSERT INTO crm_tasks(account_id,contact_id,title,due_at,priority,assigned_to) VALUES($1,$2,$3,$4,$5,$6)',[accountId,Number(body.contactId)||null,nextAction,nextActionAt,validateEnum(body.priority,PRIORITIES,'NORMAL'),req.admin.email]);return activity.rows[0]});
    res.status(201).json({ok:true,activity:saved});
  }catch(error){next(error)}});

  app.post('/api/admin/crm/accounts/:id/tasks',requireAdmin,async(req,res,next)=>{try{
    const accountId=Number(req.params.id);const body=req.body||{};const title=text(body.title,500);if(!title)throw httpError('Task title is required.');const result=await pool.query("INSERT INTO crm_tasks(account_id,contact_id,title,details,due_at,status,priority,assigned_to) VALUES($1,$2,$3,$4,$5,'OPEN',$6,$7) RETURNING *",[accountId,Number(body.contactId)||null,title,text(body.details,3000),dateOrNull(body.dueAt),validateEnum(body.priority,PRIORITIES,'NORMAL'),text(body.assignedTo,200)||req.admin.email]);res.status(201).json({ok:true,task:result.rows[0]});
  }catch(error){next(error)}});

  app.put('/api/admin/crm/tasks/:id',requireAdmin,async(req,res,next)=>{try{
    const id=Number(req.params.id);const status=validateEnum(req.body.status,TASK_STATUSES,'OPEN');const result=await pool.query("UPDATE crm_tasks SET status=$1,completed_at=CASE WHEN $1='DONE' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$2 RETURNING *",[status,id]);if(!result.rowCount)throw httpError('Task not found.',404);res.json({ok:true,task:result.rows[0]});
  }catch(error){next(error)}});

  app.get('/api/admin/crm/export.csv',requireAdmin,async(_req,res,next)=>{try{
    const result=await pool.query('SELECT license_number,trade_name,legal_name,privilege_status,license_active,address1,address2,city,state,postal_code,county,phone,general_email,website,stage,priority,last_contact_at,next_action,next_action_at,source_name,source_as_of FROM crm_accounts ORDER BY trade_name');const headers=Object.keys(result.rows[0]||{license_number:'',trade_name:''});const quote=value=>`"${String(value==null?'':value).replace(/"/g,'""')}"`;res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename="washington-retailer-crm.csv"');res.send([headers.map(quote).join(','),...result.rows.map(row=>headers.map(header=>quote(row[header])).join(','))].join('\n'));
  }catch(error){next(error)}});
}

module.exports={ensureCrmSchema,registerCrm,STAGES};
