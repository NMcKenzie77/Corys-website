'use strict';

const express=require('express');
const path=require('path');
const fs=require('fs');
const cookieParser=require('cookie-parser');
const {initDatabase,pool}=require('./db');
const {registerCommerce}=require('./commerce-api');

const app=express();
const PORT=process.env.PORT||3000;
const PUBLIC=path.join(__dirname,'public');
const VIEWS=path.join(__dirname,'views');
const PAGES=path.join(VIEWS,'pages');
const PARTIALS=path.join(VIEWS,'partials');
const SITE_NAME=process.env.SITE_NAME||'YOUR BRAND';
const SITE_URL=String(process.env.SITE_URL||'').replace(/\/+$/,'');
const ENABLE_INDEXING=process.env.ENABLE_INDEXING==='true';
const OG_IMAGE=process.env.OG_IMAGE||'';

app.set('trust proxy',true);
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true,limit:'1mb'}));
app.use(cookieParser());
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');next();});
app.use(express.static(PUBLIC,{extensions:['html'],setHeaders:(res,file)=>{if(file.endsWith('.css')||file.endsWith('.js'))res.setHeader('Cache-Control','no-cache,must-revalidate');}}));

function esc(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function replace(source,values){return Object.entries(values).reduce((out,[k,v])=>out.split(`{{${k}}}`).join(v==null?'':String(v)),source);}
function base(req){return SITE_URL||`${req.protocol}://${req.get('host')}`;}
function url(req,p='/'){return p==='/'?`${base(req)}/`:`${base(req)}/${String(p).replace(/^\/+|\/+$/g,'')}`;}
function page(slug){const file=path.join(PAGES,`${slug}.html`);if(!fs.existsSync(file))return null;const raw=fs.readFileSync(file,'utf8');const meta={};const m=raw.match(/^\s*<!--([\s\S]*?)-->/);let content=raw;if(m){m[1].split('\n').forEach(line=>{const x=line.match(/^\s*(title|description|robots|ogTitle|ogDescription|schemaType|changefreq|priority):\s*(.*?)\s*$/i);if(x)meta[x[1]]=x[2];});content=raw.slice(m[0].length).trimStart();}return{file,meta,content};}
function render(slug,req,status=200){const p=page(slug);if(!p)return null;const title=replace(p.meta.title||`${SITE_NAME} | Washington Wholesale Cannabis`,{siteName:SITE_NAME});const description=replace(p.meta.description||`${SITE_NAME} supplies licensed Washington cannabis retailers.`,{siteName:SITE_NAME});const canonical=url(req,slug==='index'?'/':`/${slug}`);const robots=status===404?'noindex, nofollow':(p.meta.robots||(ENABLE_INDEXING?'index, follow':'noindex, nofollow'));const jsonLd=JSON.stringify({'@context':'https://schema.org','@type':p.meta.schemaType||'Organization',name:SITE_NAME,url:canonical,description});return replace(fs.readFileSync(path.join(VIEWS,'layout.html'),'utf8'),{siteName:esc(SITE_NAME),title:esc(title),description:esc(description),robots:esc(robots),canonicalUrl:esc(canonical),ogType:'website',ogTitle:esc(replace(p.meta.ogTitle||title,{siteName:SITE_NAME})),ogDescription:esc(replace(p.meta.ogDescription||description,{siteName:SITE_NAME})),twitterCard:OG_IMAGE?'summary_large_image':'summary',ogImageTag:OG_IMAGE?`<meta property="og:image" content="${esc(OG_IMAGE)}" />`:'',twitterImageTag:OG_IMAGE?`<meta name="twitter:image" content="${esc(OG_IMAGE)}" />`:'',jsonLd:jsonLd.replace(/</g,'\\u003c'),header:replace(fs.readFileSync(path.join(PARTIALS,'header.html'),'utf8'),{siteName:esc(SITE_NAME)}),content:replace(p.content,{siteName:esc(SITE_NAME)}),footer:replace(fs.readFileSync(path.join(PARTIALS,'footer.html'),'utf8'),{siteName:esc(SITE_NAME)})});}

registerCommerce(app,{salesEmail:process.env.SALES_EMAIL||process.env.ADMIN_EMAIL||''});
app.get('/healthz',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:true});}catch(e){res.status(503).json({ok:false,database:false,error:e.message});}});
app.get('/robots.txt',(req,res)=>res.type('text/plain').send(ENABLE_INDEXING?`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${url(req,'/sitemap.xml')}\n`:`User-agent: *\nDisallow: /\n`));
app.get('/sitemap.xml',(req,res)=>{const rows=fs.readdirSync(PAGES).filter(f=>f.endsWith('.html')&&!['404.html'].includes(f)).map(f=>`  <url><loc>${url(req,f==='index.html'?'/':`/${f.replace('.html','')}`)}</loc></url>`).join('\n');res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>`);});
app.get('/admin',(_req,res)=>res.type('html').send(replace(fs.readFileSync(path.join(VIEWS,'admin.html'),'utf8'),{siteName:esc(SITE_NAME)})));
app.get('/',(req,res)=>res.type('html').send(render('index',req)));
app.get('/:page',(req,res,next)=>{const html=render(req.params.page,req);if(!html)return next();res.type('html').send(html);});
app.use((err,_req,res,_next)=>{console.error(err);const status=Number(err.status)||(err.code==='23505'?409:500);let message=err.code==='23505'?'That slug, SKU, or email is already in use.':(err.message||'Something went wrong.');if(status>=500&&process.env.NODE_ENV==='production')message='Something went wrong on our end.';res.status(status).json({ok:false,error:message});});
app.use((req,res)=>res.status(404).type('html').send(render('404',req,404)||'<h1>Page not found</h1>'));

initDatabase().then(()=>app.listen(PORT,()=>console.log(`${SITE_NAME} commerce running on ${PORT}`))).catch(err=>{console.error('Startup failed:',err);process.exit(1);});
