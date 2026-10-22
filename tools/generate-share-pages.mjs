// Genera una página por producto (p/<id>.html) con foto, precio y datos para que los links
// compartidos en WhatsApp, Facebook, Telegram, etc. muestren la vista previa del producto.
// También crea p/index.json (lista de páginas disponibles) y sitemap.xml.
//
// Uso:  node tools/generate-share-pages.mjs
// No necesita instalar nada (Node 18 o superior). Lee la configuración de Firebase y la URL
// del sitio directamente de index.html, y el catálogo desde Firestore (lectura pública).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SHARE_ROOT || process.cwd();
const FIRESTORE = (process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com').replace(/\/$/, '');

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const grab = (re, what) => {
  const m = indexHtml.match(re);
  if (!m) { console.error(`No encontré ${what} en index.html`); process.exit(1); }
  return m[1];
};
const projectId = grab(/projectId:\s*["']([^"']+)["']/, 'projectId de Firebase');
const apiKey    = grab(/apiKey:\s*["']([^"']+)["']/, 'apiKey de Firebase');
const SITE      = grab(/<link rel="canonical" href="([^"]+)"/, 'la URL canónica del sitio').replace(/\/?$/, '/');
const STORE     = (indexHtml.match(/storeName:\s*'([^']+)'/) || [])[1] || 'Sold-It TechMarket';

// ── Firestore (REST) → objetos JS ──
function fromValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromValue(x)]));
  return null;
}
async function fetchProducts() {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 100; page++) {
    const url = `${FIRESTORE}/v1/projects/${projectId}/databases/(default)/documents/products?pageSize=300&key=${apiKey}` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    for (const d of data.documents || []) {
      const p = Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fromValue(v)]));
      p._updated = d.updateTime || '';
      out.push(p);
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

// ── helpers ──
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const jsonForHtml = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const isHttp = u => typeof u === 'string' && /^https?:\/\//i.test(u);

function mainImage(p) { const s = (Array.isArray(p.images) && p.images[0]) || p.imagen; return isHttp(s) ? s : ''; }
// Cloudinary: 1200x630 con fondo blanco (formato ideal para vistas previas)
function ogImage(p) {
  const src = mainImage(p);
  if (!src) return { url: SITE + 'og.png', sized: true };
  const m = src.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/.*)$/);
  if (!m) return { url: src, sized: false };
  return { url: `${m[1]}f_jpg,q_auto,c_pad,b_white,w_1200,h_630/${m[2].replace(/\.[a-z0-9]+$/i, '.jpg')}`, sized: true };
}
function bodyImage(p) {
  const src = mainImage(p);
  const m = src.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/.*)$/);
  return m ? `${m[1]}f_auto,q_auto,w_700/${m[2]}` : src;
}

function summary(p) {
  const bits = [p.sold ? 'VENDIDO' : money(p.price)];
  if (p.cuotas) bits.push(`${p.cuotas} cuotas sin interés`);
  if (p.shipping) bits.push('Envío gratis');
  bits.push(p.cond === 'new' ? 'Nuevo' : 'Usado');
  const extra = p.desc && p.desc !== '—' ? clip(p.desc, 140) : 'Consultá por WhatsApp.';
  return clip(bits.join(' · ') + '. ' + extra, 220);
}

function renderPage(p) {
  const id = p.id;
  const pageUrl = `${SITE}p/${id}.html`;
  const title = `${clip(p.name, 80)} — ${p.sold ? 'Vendido' : money(p.price)} | ${STORE}`;
  const desc = summary(p);
  const img = ogImage(p);
  const inStock = !p.sold && p.stock !== 0;
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: desc, url: pageUrl, image: [img.url],
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    itemCondition: p.cond === 'new' ? 'https://schema.org/NewCondition' : 'https://schema.org/UsedCondition',
    offers: { '@type': 'Offer', url: pageUrl, price: Math.round(Number(p.price) || 0), priceCurrency: 'ARS', availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', seller: { '@type': 'Organization', name: STORE } }
  };
  const specs = (Array.isArray(p.specs) ? p.specs : []).filter(s => s && s.k);
  const body = bodyImage(p);
  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(pageUrl)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="${esc(STORE)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(img.url)}">
${img.sized ? '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n' : ''}<meta property="og:locale" content="es_AR">
<meta property="product:price:amount" content="${Math.round(Number(p.price) || 0)}">
<meta property="product:price:currency" content="ARS">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img.url)}">
<script type="application/ld+json">${jsonForHtml(ld)}</script>
<style>body{margin:0;background:#080810;color:#ececf4;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.55}main{max-width:640px;margin:0 auto;padding:24px 16px}img{max-width:100%;border-radius:12px;background:#fff}h1{font-size:22px;margin:16px 0 6px}.price{font-size:28px;font-weight:700;color:#f5c400;margin:0 0 10px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #222;font-size:14px;vertical-align:top}a{color:#7aaeff}.btn{display:inline-block;margin-top:16px;padding:12px 20px;background:#f5c400;color:#14110a;border-radius:12px;font-weight:700;text-decoration:none}</style>
</head>
<body>
<main>
${body ? `<img src="${esc(body)}" alt="${esc(p.name)}" width="640" loading="eager">\n` : ''}<h1>${esc(p.name)}</h1>
<p class="price">${p.sold ? 'Vendido' : esc(money(p.price))}</p>
<p>${esc(summary(p))}</p>
${specs.length ? `<h2>Ficha técnica</h2>\n<table>${specs.map(s => `<tr><th>${esc(s.k)}</th><td>${esc(s.v || '')}</td></tr>`).join('')}</table>\n` : ''}${p.warranty ? `<h2>Garantía y condiciones</h2>\n<p>${esc(p.warranty)}</p>\n` : ''}<a class="btn" href="../#/producto/${id}">Ver en ${esc(STORE)}</a>
<noscript><p><a href="../#/producto/${id}">Abrir el producto en el sitio</a></p></noscript>
</main>
<script>
// Las personas pasan al sitio; los buscadores y las apps de mensajería leen esta página tal cual.
(function () {
  var ua = navigator.userAgent || '';
  if (/bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|twitter|linkedin|preview|embedly|pinterest|skype|discord/i.test(ua)) return;
  location.replace('../#/producto/${id}');
})();
</script>
</body>
</html>
`;
}

function renderSitemap(products) {
  const rows = [`  <url><loc>${esc(SITE)}</loc></url>`].concat(products.map(p => `  <url><loc>${esc(SITE + 'p/' + p.id + '.html')}</loc>${p._updated ? `<lastmod>${esc(p._updated.slice(0, 10))}</lastmod>` : ''}</url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

function writeIfChanged(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

// ── main ──
let all;
try { all = await fetchProducts(); }
catch (e) { console.error('No se pudo leer el catálogo. No se tocó ningún archivo.\n' + e.message); process.exit(1); }

const visible = all
  .filter(p => Number.isInteger(p.id) && p.name && Number(p.price) >= 0 && p.hidden !== true && p.available !== false)
  .sort((a, b) => a.id - b.id);

const dir = path.join(ROOT, 'p');
let changed = 0, removed = 0;
for (const p of visible) if (writeIfChanged(path.join(dir, `${p.id}.html`), renderPage(p))) changed++;
const keep = new Set(visible.map(p => `${p.id}.html`));
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^\d+\.html$/.test(f) && !keep.has(f)) { fs.unlinkSync(path.join(dir, f)); removed++; }
if (writeIfChanged(path.join(dir, 'index.json'), JSON.stringify({ v: 1, ids: visible.map(p => p.id) }) + '\n')) changed++;
if (writeIfChanged(path.join(ROOT, 'sitemap.xml'), renderSitemap(visible))) changed++;
console.log(`Catálogo: ${all.length} productos, ${visible.length} con página. Archivos nuevos o actualizados: ${changed}. Eliminados: ${removed}.`);
