'use strict';

const crypto = require('crypto');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { pool, withTransaction } = require('./db');
const { verifyAdminCredentials, setSessionCookie, clearSessionCookie, requireAdmin, verifySession, COOKIE_NAME } = require('./auth');

const STATUSES = ['NEW', 'APPROVED', 'PACKING', 'READY_FOR_CARRIER', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Only JPG, PNG, WEBP, and GIF images are accepted.'))
});

function text(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function email(value) { const v = text(value, 200).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : ''; }
function slug(value) { return text(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function cents(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 100) : NaN; }
function esc(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function orderNumber() { return `CB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }

const buckets = new Map();
function limit(windowMs, max) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) return res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });
    next();
  };
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !to) return;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

function orderHtml(order, items, heading) {
  const rows = items.map(i => `<tr><td style="padding:8px;border-bottom:1px solid #ddd">${esc(i.product_name)} — ${esc(i.variant_label)}</td><td>${i.quantity}</td><td>$${(i.line_total_cents / 100).toFixed(2)}</td></tr>`).join('');
  return `<h2>${esc(heading)}</h2><p><b>Order:</b> ${esc(order.order_number)}</p><p><b>Status:</b> ${esc(order.status)}</p><p><b>Retailer:</b> ${esc(order.ship_business_name)}</p><p><b>Destination:</b><br>${esc(order.ship_address1)} ${esc(order.ship_address2)}<br>${esc(order.ship_city)}, ${esc(order.ship_state)} ${esc(order.ship_postal_code)}</p><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table><p><b>Total:</b> $${(order.total_cents / 100).toFixed(2)}</p><p>This wholesale request requires license verification, inventory confirmation, and lawful Washington business-to-business fulfillment.</p>`;
}

async function products(includeInactive = false) {
  const result = await pool.query(`
    SELECT p.*, COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
      'id',v.id,'sku',v.sku,'label',v.label,'priceCents',v.price_cents,
      'salePriceCents',v.sale_price_cents,'inventoryQty',v.inventory_qty,'active',v.active
    ) ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL ${includeInactive ? '' : 'AND v.active=TRUE'}),'[]'::json) variants
    FROM products p LEFT JOIN product_variants v ON v.product_id=p.id
    ${includeInactive ? '' : 'WHERE p.active=TRUE'}
    GROUP BY p.id ORDER BY p.featured DESC,p.updated_at DESC
  `);
  return result.rows.map(p => ({ id:Number(p.id), name:p.name, slug:p.slug, category:p.category, description:p.description, imageUrl:p.image_url, featured:p.featured, active:p.active, variants:p.variants || [] }));
}

function productPayload(body) {
  const p = {
    name:text(body.name,160), slug:slug(body.slug || body.name), category:text(body.category,100),
    description:text(body.description,5000), imageUrl:text(body.imageUrl,1000), featured:body.featured===true,
    active:body.active!==false, variants:Array.isArray(body.variants)?body.variants.slice(0,50):[]
  };
  if (!p.name || !p.slug || !p.category || !p.variants.length) { const e=new Error('Name, category, and at least one variant are required.'); e.status=400; throw e; }
  p.variants = p.variants.map((v,i) => {
    const out={ label:text(v.label,100), sku:text(v.sku,100).toUpperCase(), priceCents:cents(v.price), salePriceCents:text(v.salePrice,30)===''?null:cents(v.salePrice), inventoryQty:Number(v.inventoryQty), active:v.active!==false };
    if (!out.label || !out.sku || !Number.isInteger(out.priceCents) || out.priceCents<0 || !Number.isInteger(out.inventoryQty) || out.inventoryQty<0) { const e=new Error(`Variant ${i+1} is invalid.`); e.status=400; throw e; }
    if (out.salePriceCents!=null && (!Number.isInteger(out.salePriceCents) || out.salePriceCents<0 || out.salePriceCents>out.priceCents)) { const e=new Error(`Variant ${i+1} sale price is invalid.`); e.status=400; throw e; }
    return out;
  });
  return p;
}

function registerCommerce(app, options = {}) {
  const salesEmail = options.salesEmail || process.env.SALES_EMAIL || process.env.ADMIN_EMAIL || '';

  app.get('/api/products', async (_req,res,next) => { try { res.json({ok:true,products:await products(false)}); } catch(e){next(e);} });

  app.post('/api/orders', limit(15*60*1000,8), async (req,res,next) => {
    try {
      const b=req.body||{}; const state=text(b.state,2).toUpperCase(); const items=Array.isArray(b.items)?b.items.slice(0,50):[];
      const c={ businessName:text(b.businessName,160),contactName:text(b.contactName,160),email:email(b.email),phone:text(b.phone,50),licenseNumber:text(b.licenseNumber,100),ubiNumber:text(b.ubiNumber,100),address1:text(b.address1,200),address2:text(b.address2,200),city:text(b.city,100),state,postalCode:text(b.postalCode,20),notes:text(b.notes,2000) };
      if (!c.businessName||!c.contactName||!c.email||!c.phone||!c.licenseNumber||!c.address1||!c.city||!c.postalCode||!items.length) return res.status(400).json({ok:false,error:'Complete all required retailer, delivery, and product fields.'});
      if (state!=='WA') return res.status(400).json({ok:false,error:'Only licensed Washington business destinations are supported.'});
      if (b.licenseConfirmed!==true) return res.status(400).json({ok:false,error:'License confirmation is required.'});

      const saved=await withTransaction(async client => {
        const requested=items.map(i=>({variantId:Number(i.variantId),quantity:Math.max(1,Math.min(999,Number(i.quantity)||0))}));
        if(requested.some(i=>!Number.isInteger(i.variantId)||i.variantId<1||!i.quantity)){const e=new Error('Invalid order item.');e.status=400;throw e;}
        const ids=[...new Set(requested.map(i=>i.variantId))];
        const vr=await client.query(`SELECT v.*,p.name product_name,p.id product_id,p.active product_active FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=ANY($1::bigint[]) FOR UPDATE`,[ids]);
        const map=new Map(vr.rows.map(r=>[Number(r.id),r])); let total=0;
        const resolved=requested.map(i=>{const r=map.get(i.variantId);if(!r||!r.active||!r.product_active){const e=new Error('A product is no longer available.');e.status=409;throw e;}if(r.inventory_qty<i.quantity){const e=new Error(`${r.product_name} (${r.label}) has only ${r.inventory_qty} available.`);e.status=409;throw e;}const unit=r.sale_price_cents==null?r.price_cents:Math.min(r.price_cents,r.sale_price_cents);const line=unit*i.quantity;total+=line;return{r,quantity:i.quantity,unit,line};});
        const cr=await client.query(`INSERT INTO customers(business_name,contact_name,email,phone,license_number,ubi_number,ship_address1,ship_address2,city,state,postal_code,delivery_notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(email) DO UPDATE SET business_name=EXCLUDED.business_name,contact_name=EXCLUDED.contact_name,phone=EXCLUDED.phone,license_number=EXCLUDED.license_number,ubi_number=EXCLUDED.ubi_number,ship_address1=EXCLUDED.ship_address1,ship_address2=EXCLUDED.ship_address2,city=EXCLUDED.city,state=EXCLUDED.state,postal_code=EXCLUDED.postal_code,delivery_notes=EXCLUDED.delivery_notes,updated_at=NOW() RETURNING *`,[c.businessName,c.contactName,c.email,c.phone,c.licenseNumber,c.ubiNumber,c.address1,c.address2,c.city,c.state,c.postalCode,c.notes]);
        const or=await client.query(`INSERT INTO orders(order_number,customer_id,subtotal_cents,total_cents,ship_business_name,ship_contact_name,ship_address1,ship_address2,ship_city,ship_state,ship_postal_code,customer_notes) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[orderNumber(),cr.rows[0].id,total,c.businessName,c.contactName,c.address1,c.address2,c.city,c.state,c.postalCode,c.notes]);
        for(const i of resolved){await client.query(`INSERT INTO order_items(order_id,product_id,variant_id,product_name,variant_label,sku,quantity,unit_price_cents,line_total_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[or.rows[0].id,i.r.product_id,i.r.id,i.r.product_name,i.r.label,i.r.sku,i.quantity,i.unit,i.line]);await client.query('UPDATE product_variants SET inventory_qty=inventory_qty-$1,updated_at=NOW() WHERE id=$2',[i.quantity,i.r.id]);}
        await client.query(`INSERT INTO order_status_history(order_id,status,note) VALUES($1,'NEW','Order submitted by retailer.')`,[or.rows[0].id]);
        const ir=await client.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id',[or.rows[0].id]);
        return{order:or.rows[0],customer:cr.rows[0],items:ir.rows};
      });
      Promise.allSettled([sendEmail(salesEmail,`New wholesale order ${saved.order.order_number}`,orderHtml(saved.order,saved.items,'New wholesale order')),sendEmail(saved.customer.email,`Order request received: ${saved.order.order_number}`,orderHtml(saved.order,saved.items,'Your wholesale order request was received'))]).then(rs=>rs.forEach(r=>r.status==='rejected'&&console.error(r.reason)));
      res.status(201).json({ok:true,orderNumber:saved.order.order_number,status:saved.order.status,totalCents:saved.order.total_cents});
    } catch(e){next(e);}
  });

  app.post('/api/inquiry',limit(15*60*1000,10),async(req,res,next)=>{try{const b=req.body||{};const em=email(b.email);if(!text(b.businessName)||!text(b.contactName)||!em)return res.status(400).json({ok:false,error:'Business name, contact name, and email are required.'});const r=await pool.query('INSERT INTO inquiries(business_name,contact_name,license_number,email,phone,message) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[text(b.businessName,160),text(b.contactName,160),text(b.licenseNumber,100),em,text(b.phone,50),text(b.message,2000)]);res.status(201).json({ok:true,id:r.rows[0].id});}catch(e){next(e);}});

  app.post('/api/admin/login',limit(15*60*1000,8),async(req,res,next)=>{try{const em=email(req.body.email);if(!await verifyAdminCredentials(em,req.body.password))return res.status(401).json({ok:false,error:'Invalid email or password.'});setSessionCookie(res,em);res.json({ok:true,admin:{email:em}});}catch(e){next(e);}});
  app.post('/api/admin/logout',(_req,res)=>{clearSessionCookie(res);res.json({ok:true});});
  app.get('/api/admin/me',(req,res)=>{try{const s=verifySession(req.cookies&&req.cookies[COOKIE_NAME]);if(!s)return res.status(401).json({ok:false});res.json({ok:true,admin:{email:s.email}});}catch(_e){res.status(401).json({ok:false});}});

  app.get('/api/admin/summary',requireAdmin,async(_req,res,next)=>{try{const r=await pool.query(`SELECT (SELECT COUNT(*) FROM products WHERE active=TRUE) active_products,(SELECT COALESCE(SUM(inventory_qty),0) FROM product_variants WHERE active=TRUE) units_available,(SELECT COUNT(*) FROM orders WHERE status='NEW') new_orders,(SELECT COUNT(*) FROM orders WHERE created_at>=NOW()-INTERVAL '30 days') orders_30d,(SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status<>'CANCELLED' AND created_at>=NOW()-INTERVAL '30 days') gross_30d`);res.json({ok:true,summary:r.rows[0]});}catch(e){next(e);}});
  app.get('/api/admin/products',requireAdmin,async(_req,res,next)=>{try{res.json({ok:true,products:await products(true)});}catch(e){next(e);}});

  app.post('/api/admin/products',requireAdmin,async(req,res,next)=>{try{const p=productPayload(req.body||{});const saved=await withTransaction(async c=>{const r=await c.query('INSERT INTO products(name,slug,category,description,image_url,featured,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[p.name,p.slug,p.category,p.description,p.imageUrl,p.featured,p.active]);for(const v of p.variants)await c.query('INSERT INTO product_variants(product_id,sku,label,price_cents,sale_price_cents,inventory_qty,active) VALUES($1,$2,$3,$4,$5,$6,$7)',[r.rows[0].id,v.sku,v.label,v.priceCents,v.salePriceCents,v.inventoryQty,v.active]);return r.rows[0];});res.status(201).json({ok:true,product:saved});}catch(e){next(e);}});
  app.put('/api/admin/products/:id',requireAdmin,async(req,res,next)=>{try{const id=Number(req.params.id),p=productPayload(req.body||{});const saved=await withTransaction(async c=>{const r=await c.query('UPDATE products SET name=$1,slug=$2,category=$3,description=$4,image_url=$5,featured=$6,active=$7,updated_at=NOW() WHERE id=$8 RETURNING *',[p.name,p.slug,p.category,p.description,p.imageUrl,p.featured,p.active,id]);if(!r.rowCount){const e=new Error('Product not found.');e.status=404;throw e;}await c.query('DELETE FROM product_variants WHERE product_id=$1',[id]);for(const v of p.variants)await c.query('INSERT INTO product_variants(product_id,sku,label,price_cents,sale_price_cents,inventory_qty,active) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,v.sku,v.label,v.priceCents,v.salePriceCents,v.inventoryQty,v.active]);return r.rows[0];});res.json({ok:true,product:saved});}catch(e){next(e);}});

  app.post('/api/admin/upload',requireAdmin,upload.single('image'),async(req,res,next)=>{try{if(!req.file)return res.status(400).json({ok:false,error:'Choose an image.'});if(!process.env.CLOUDINARY_CLOUD_NAME||!process.env.CLOUDINARY_API_KEY||!process.env.CLOUDINARY_API_SECRET)return res.status(503).json({ok:false,error:'Cloudinary is not configured. Paste an image URL or add Cloudinary variables.'});cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});const result=await new Promise((resolve,reject)=>{const s=cloudinary.uploader.upload_stream({folder:process.env.CLOUDINARY_FOLDER||'cory-wholesale-products',resource_type:'image',transformation:[{width:1400,height:1400,crop:'limit'},{quality:'auto',fetch_format:'auto'}]},(e,r)=>e?reject(e):resolve(r));s.end(req.file.buffer);});res.status(201).json({ok:true,url:result.secure_url});}catch(e){next(e);}});

  app.get('/api/admin/orders',requireAdmin,async(req,res,next)=>{try{const st=text(req.query.status,40).toUpperCase();const valid=STATUSES.includes(st);const r=await pool.query(`SELECT o.*,c.email,c.phone,c.license_number,c.ubi_number,COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id',oi.id,'productName',oi.product_name,'variantLabel',oi.variant_label,'sku',oi.sku,'quantity',oi.quantity,'unitPriceCents',oi.unit_price_cents,'lineTotalCents',oi.line_total_cents) ORDER BY oi.id) FILTER(WHERE oi.id IS NOT NULL),'[]'::json) items FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items oi ON oi.order_id=o.id ${valid?'WHERE o.status=$1':''} GROUP BY o.id,c.id ORDER BY o.created_at DESC LIMIT 500`,valid?[st]:[]);res.json({ok:true,orders:r.rows});}catch(e){next(e);}});

  app.put('/api/admin/orders/:id',requireAdmin,async(req,res,next)=>{try{const id=Number(req.params.id),st=text(req.body.status,40).toUpperCase();if(!Number.isInteger(id)||!STATUSES.includes(st))return res.status(400).json({ok:false,error:'Invalid order or status.'});const saved=await withTransaction(async c=>{const er=await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id]);if(!er.rowCount){const e=new Error('Order not found.');e.status=404;throw e;}const old=er.rows[0];if(st==='CANCELLED'&&old.status!=='CANCELLED'&&!old.inventory_restored){const items=await c.query('SELECT variant_id,quantity FROM order_items WHERE order_id=$1',[id]);for(const i of items.rows)if(i.variant_id)await c.query('UPDATE product_variants SET inventory_qty=inventory_qty+$1,updated_at=NOW() WHERE id=$2',[i.quantity,i.variant_id]);}const or=await c.query(`UPDATE orders SET status=$1,internal_notes=$2,carrier_name=$3,tracking_number=$4,manifest_number=$5,inventory_restored=CASE WHEN $1='CANCELLED' THEN TRUE ELSE inventory_restored END,updated_at=NOW() WHERE id=$6 RETURNING *`,[st,text(req.body.internalNotes,3000),text(req.body.carrierName,160),text(req.body.trackingNumber,160),text(req.body.manifestNumber,160),id]);await c.query('INSERT INTO order_status_history(order_id,status,note) VALUES($1,$2,$3)',[id,st,text(req.body.statusNote,1000)]);const customer=await c.query('SELECT * FROM customers WHERE id=$1',[or.rows[0].customer_id]);const items=await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id',[id]);return{order:or.rows[0],customer:customer.rows[0],items:items.rows};});sendEmail(saved.customer.email,`Order ${saved.order.order_number}: ${saved.order.status.replace(/_/g,' ')}`,orderHtml(saved.order,saved.items,`Order status: ${saved.order.status.replace(/_/g,' ')}`)).catch(console.error);res.json({ok:true,order:saved.order});}catch(e){next(e);}});

  app.get('/api/admin/orders-export.csv',requireAdmin,async(_req,res,next)=>{try{const r=await pool.query(`SELECT o.order_number,o.created_at,o.status,o.ship_business_name,o.ship_contact_name,c.email,c.phone,c.license_number,o.total_cents,o.ship_address1,o.ship_address2,o.ship_city,o.ship_state,o.ship_postal_code,o.carrier_name,o.tracking_number,o.manifest_number FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`);const headers=['order_number','created_at','status','ship_business_name','ship_contact_name','email','phone','license_number','total_cents','ship_address1','ship_address2','ship_city','ship_state','ship_postal_code','carrier_name','tracking_number','manifest_number'];const q=v=>`"${String(v==null?'':v).replace(/"/g,'""')}"`;res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition',`attachment; filename="orders-${new Date().toISOString().slice(0,10)}.csv"`);res.send([headers.map(q).join(','),...r.rows.map(row=>headers.map(h=>q(row[h])).join(','))].join('\n'));}catch(e){next(e);}});
}

module.exports = { registerCommerce };
