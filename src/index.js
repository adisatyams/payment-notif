import { handleRawEmail, pollImap } from './mail.js';
import { retryWebhooks } from './webhook.js';
import {
  createPayment, getPayment, listPayments, cancelPayment, confirmManually, expireOld, HttpError,
} from './payments.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  if (ea.length !== eb.length) return false;
  let d = 0;
  for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}

function authorized(request, env) {
  if (!env.API_KEY) return false; // fail-closed bila secret belum di-set
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && timingSafeEqual(h.slice(7), env.API_KEY);
}

function present(p) {
  if (!p) return p;
  return {
    ref: p.ref,
    external_ref: p.external_ref,
    customer: p.customer,
    status: p.status,
    amount_base: p.amount_base,
    unique_code: p.unique_code,
    amount_total: p.amount_total,
    amount_display: 'Rp ' + p.amount_total.toLocaleString('id-ID'),
    created_at: p.created_at,
    expires_at: p.expires_at,
    paid_at: p.paid_at,
    paid_via: p.paid_via,
  };
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (path === '/' || path === '/health') return json({ ok: true, service: 'payment-notif' });
  if (!path.startsWith('/api/')) return json({ error: 'not found' }, 404);
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

  // POST /api/payments  { amount, customer?, external_ref? }
  if (path === '/api/payments' && m === 'POST') {
    const body = await request.json().catch(() => ({}));
    const p = await createPayment(env.DB, env, {
      amount: body.amount, customer: body.customer, externalRef: body.external_ref,
    });
    return json(present(p), 201);
  }

  // GET /api/payments?status=&external_ref=&limit=
  if (path === '/api/payments' && m === 'GET') {
    const rows = await listPayments(env.DB, {
      status: url.searchParams.get('status') || undefined,
      externalRef: url.searchParams.get('external_ref') || undefined,
      limit: url.searchParams.get('limit') || 50,
    });
    return json(rows.map(present));
  }

  const one = path.match(/^\/api\/payments\/([A-Z0-9-]+)(\/(cancel|confirm))?$/);
  if (one) {
    const [, ref, , action] = one;
    if (!action && m === 'GET') {
      const p = await getPayment(env.DB, ref);
      return p ? json(present(p)) : json({ error: 'not found' }, 404);
    }
    if (action === 'cancel' && m === 'POST') {
      return json({ ok: await cancelPayment(env.DB, ref) });
    }
    if (action === 'confirm' && m === 'POST') {
      const ok = await confirmManually(env.DB, ref);
      return json({ ok, payment: present(await getPayment(env.DB, ref)) });
    }
  }

  // GET /api/notifs?status=unmatched  -> email masuk yang belum cocok (untuk ditinjau manual)
  if (path === '/api/notifs' && m === 'GET') {
    const status = url.searchParams.get('status');
    const q = status
      ? env.DB.prepare(`SELECT id, source, sender, subject, amounts, received_at, match_status, payment_id FROM notifs WHERE match_status=? ORDER BY id DESC LIMIT 100`).bind(status)
      : env.DB.prepare(`SELECT id, source, sender, subject, amounts, received_at, match_status, payment_id FROM notifs ORDER BY id DESC LIMIT 100`);
    const { results } = await q.all();
    return json(results.map((r) => ({ ...r, amounts: JSON.parse(r.amounts || '[]') })));
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error('fetch error', e);
      return json({ error: 'internal error' }, 500);
    }
  },

  // Cloudflare Email Routing -> Email Worker (jalur utama, tanpa IMAP)
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).arrayBuffer();
    const r = await handleRawEmail(env, ctx, new Uint8Array(raw), 'email-routing');
    console.log('email', message.from, r.status);
  },

  // Cron: IMAP polling + housekeeping
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try { await expireOld(env.DB); } catch (e) { console.error('expire', e); }
        try { console.log('imap', JSON.stringify(await pollImap(env, ctx))); } catch (e) { console.error('imap', e.message); }
        try { await retryWebhooks(env.DB, env); } catch (e) { console.error('webhook retry', e); }
      })()
    );
  },
};
