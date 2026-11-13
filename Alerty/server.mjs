import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const publicFiles = new Set(['index.html','styles.css','app.js']);
const port = Number(process.env.PORT || 8080);
const promUrl = process.env.PROMETHEUS_URL || '';
const lokiUrl = process.env.LOKI_URL || '';
const promToken = process.env.PROMETHEUS_TOKEN || '';
const lokiToken = process.env.LOKI_TOKEN || '';
const promUser = process.env.PROMETHEUS_USER || '';
const promPassword = process.env.PROMETHEUS_PASSWORD || '';
const lokiUser = process.env.LOKI_USER || '';
const lokiPassword = process.env.LOKI_PASSWORD || '';
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 8000);
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json; charset=utf-8', '.ico':'image/x-icon' };

function authHeaders(token, user, password) {
  if (token) return { authorization: `Bearer ${token}` };
  if (user || password) return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
  return {};
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  res.end(JSON.stringify(body));
}

function configuredBase(raw, service) {
  if (!raw) throw Object.assign(new Error(`${service} URL не настроен`), { status:503 });
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error(`Некорректный ${service} URL`), { status:500 }); }
  if (!['http:','https:'].includes(url.protocol)) throw Object.assign(new Error(`Для ${service} поддерживаются только HTTP(S)`), { status:500 });
  return url;
}

async function upstream(base, path, params, headers) {
  const url = new URL(path, base);
  for (const [key,value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
  const response = await fetch(url, { headers, signal:AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Источник вернул HTTP ${response.status}`), { status:502 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Источник вернул некорректный JSON'), { status:502 }); }
}

async function check(name, raw, path, headers) {
  if (!raw) return { configured:false, healthy:false, message:'URL не задан' };
  try {
    const base = configuredBase(raw, name);
    const response = await fetch(new URL(path, base), { headers, signal:AbortSignal.timeout(timeoutMs) });
    return { configured:true, healthy:response.ok, message:response.ok?'Подключён':`HTTP ${response.status}` };
  } catch (error) {
    return { configured:true, healthy:false, message:error.name==='TimeoutError'?'Таймаут':error.message };
  }
}

const server = createServer(async (req,res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res,200,{ ok:true, service:'alerty-api' });
    if (req.method === 'GET' && url.pathname === '/api/integrations') {
      const [prometheus,loki] = await Promise.all([
        check('Prometheus',promUrl,'/-/healthy',authHeaders(promToken,promUser,promPassword)),
        check('Loki',lokiUrl,'/ready',authHeaders(lokiToken,lokiUser,lokiPassword))
      ]);
      return json(res,200,{ prometheus,loki,mode:prometheus.healthy||loki.healthy?'live':'demo' });
    }
    if (req.method === 'GET' && url.pathname === '/api/metrics/query_range') {
      const query=url.searchParams.get('query'),start=url.searchParams.get('start'),end=url.searchParams.get('end'),step=url.searchParams.get('step')||'30s';
      if (!query || !start || !end) return json(res,400,{ error:'Укажи query, start и end' });
      const base=configuredBase(promUrl,'Prometheus');
      return json(res,200,await upstream(base,'/api/v1/query_range',{query,start,end,step},authHeaders(promToken,promUser,promPassword)));
    }
    if (req.method === 'GET' && url.pathname === '/api/logs/query_range') {
      const query=url.searchParams.get('query'),start=url.searchParams.get('start'),end=url.searchParams.get('end'),limit=url.searchParams.get('limit')||'100';
      if (!query || !start || !end) return json(res,400,{ error:'Укажи query, start и end' });
      const base=configuredBase(lokiUrl,'Loki');
      return json(res,200,await upstream(base,'/loki/api/v1/query_range',{query,start,end,limit,direction:'BACKWARD'},authHeaders(lokiToken,lokiUser,lokiPassword)));
    }
    if (url.pathname.startsWith('/api/')) return json(res,404,{ error:'API route не найдена' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{ error:'Метод не поддерживается' });

    const requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    if (!publicFiles.has(requested)) return json(res,404,{ error:'Файл не найден' });
    const file=resolve(root,requested);
    const info=await stat(file);
    if (!info.isFile()) return json(res,404,{ error:'Файл не найден' });
    res.writeHead(200,{ 'content-type':mime[extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','x-frame-options':'SAMEORIGIN','referrer-policy':'no-referrer','cache-control':extname(file)==='.html'?'no-cache':'public, max-age=300','content-security-policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'self'" });
    if(req.method==='HEAD') return res.end();
    res.end(await readFile(file));
  } catch(error) {
    json(res,error.status||500,{ error:error.message||'Внутренняя ошибка' });
  }
});

server.listen(port,'0.0.0.0',()=>console.log(`Alerty listening on :${port}`));

