import express from 'express';
import multer from 'multer';
import Replicate from 'replicate';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// LAMBA IMAGE STUDIO
// Paddle + Supabase + Render
//
// IMPORTANT:
// - Existing Supabase credits are NOT reset or modified on startup.
// - Payment package: $2.99 = 10 credits.
// - 1 credit is consumed only after a successful image generation.
// - A completed Paddle transaction is fulfilled only once.
// - Secrets must be stored in Render Environment Variables.
// ============================================================

// -------------------- Replicate --------------------

const TOKEN = process.env.REPLICATE_API_TOKEN || '';
const replicate = TOKEN ? new Replicate({ auth: TOKEN }) : null;

// -------------------- Paddle --------------------

const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const PADDLE_WEBHOOK_SECRET =
  process.env.PADDLE_WEBHOOK_SECRET ||
  process.env.PADDLE_WEBHOOK_SECRET_KEY ||
  '';

const PADDLE_PRICE_ID =
  process.env.PADDLE_PRICE_ID ||
  'pri_01m2yhnx9141nykm53kqaf2dyp';

const PADDLE_ENV = (process.env.PADDLE_ENV || 'sandbox').toLowerCase();

const PADDLE_API_BASE =
  PADDLE_ENV === 'live'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

const PAYMENT_AMOUNT_USD = 2.99;
const PAYMENT_CREDITS = 10;

// -------------------- Supabase --------------------
//
// Use the service-role key ONLY on Render.
// Never put it into the HTML/frontend.

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

const SUPABASE_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json'
};

// ============================================================
// Small helpers
// ============================================================

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// Resolve the currently logged-in Supabase user from the access token.
// This is the primary identity source for payment creation: the frontend
// does not have to guess/pass an email field when a Supabase session exists.
function getBearerToken(req) {
  const header = String(req.get('Authorization') || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

async function getAuthenticatedSupabaseUser(req) {
  const accessToken = getBearerToken(req);
  if (!accessToken || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok || !data?.id || !isUuid(data.id)) {
    return null;
  }

  return {
    id: data.id,
    email: normalizeEmail(data.email)
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// In-memory lock. It prevents two copies of the SAME Paddle transaction
// from being fulfilled simultaneously inside one Render instance.
const transactionLocks = new Map();

async function withTransactionLock(transactionId, fn) {
  const key = String(transactionId || '');

  while (transactionLocks.has(key)) {
    await transactionLocks.get(key);
  }

  let release;
  const lock = new Promise(resolve => {
    release = resolve;
  });

  transactionLocks.set(key, lock);

  try {
    return await fn();
  } finally {
    if (transactionLocks.get(key) === lock) {
      transactionLocks.delete(key);
    }
    release();
  }
}

// ============================================================
// Supabase REST helper
// No extra npm package is required for Supabase.
// ============================================================

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase не настроен. Добавь SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в Render.'
    );
  }

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      ...SUPABASE_HEADERS,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail =
      data?.message ||
      data?.hint ||
      data?.details ||
      data?.error_description ||
      data?.error ||
      text ||
      `Supabase HTTP ${response.status}`;

    const error = new Error(String(detail));
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

// ============================================================
// Supabase data access
// Tables used:
//
// public.profiles
//   id uuid
//   email text
//
// public.user_credits
//   user_id uuid
//   credits int4
//
// public.payment_orders
//   order_reference text
//   user_id uuid
//   amount numeric
//   currency text
//
// The 94 credits already stored in user_credits are left untouched.
// ============================================================

// profiles in this project does NOT contain an email column.
// Therefore we resolve the user's email through Supabase Auth,
// then use the returned Auth user id with public.user_credits.
// This fixes: "column profiles.email does not exist".
async function findProfileByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  // Resolve the Auth user directly by email instead of downloading only
  // the first 1000 users and searching that page locally.
  const query =
    `/auth/v1/admin/users?email=${encodeURIComponent(normalized)}`;

  const response = await fetch(
    `${SUPABASE_URL}${query}`,
    {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );

  const text = await response.text();

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      data?.msg ||
      data?.message ||
      data?.error_description ||
      `Supabase Auth HTTP ${response.status}`
    );
  }

  const users = Array.isArray(data)
    ? data
    : Array.isArray(data?.users)
      ? data.users
      : data?.id
        ? [data]
        : [];

  const user = users.find(
    item => normalizeEmail(item?.email) === normalized
  );

  if (!user?.id || !isUuid(user.id)) {
    return null;
  }

  return {
    id: user.id,
    email: user.email
  };
}

async function getCreditsByUserId(userId) {
  if (!isUuid(userId)) {
    throw new Error('Некорректный user_id.');
  }

  const query =
    `/rest/v1/user_credits?select=user_id,credits` +
    `&user_id=eq.${encodeURIComponent(userId)}` +
    `&limit=1`;

  const rows = await supabaseRequest(query, {
    method: 'GET'
  });

  return Array.isArray(rows) && rows.length
    ? {
        user_id: rows[0].user_id,
        credits: Number(rows[0].credits || 0)
      }
    : null;
}

// Atomic compare-and-swap increment.
// This never blindly overwrites another update.
async function addCreditsAtomic(userId, amount) {
  const delta = Number(amount || 0);

  if (!isUuid(userId) || !Number.isInteger(delta) || delta <= 0) {
    throw new Error('Некорректные данные для начисления кредитов.');
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await getCreditsByUserId(userId);

    if (!current) {
      throw new Error(
        'Для пользователя не найдена строка public.user_credits.'
      );
    }

    const oldCredits = Number(current.credits || 0);
    const newCredits = oldCredits + delta;

    const query =
      `/rest/v1/user_credits` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&credits=eq.${encodeURIComponent(oldCredits)}`;

    const updated = await supabaseRequest(query, {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        credits: newCredits,
        updated_at: new Date().toISOString()
      })
    });

    if (Array.isArray(updated) && updated.length) {
      return {
        oldCredits,
        newCredits
      };
    }

    await sleep(25 + attempt * 25);
  }

  throw new Error(
    'Не удалось атомарно обновить баланс кредитов. Попробуй ещё раз.'
  );
}

// Atomic compare-and-swap decrement.
// A credit is removed only if the current balance still equals the
// balance we read immediately before the update.
async function spendCreditAtomic(userId) {
  if (!isUuid(userId)) {
    throw new Error('Некорректный user_id.');
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await getCreditsByUserId(userId);

    if (!current) {
      throw new Error(
        'Для пользователя не найдена строка public.user_credits.'
      );
    }

    const oldCredits = Number(current.credits || 0);

    if (oldCredits < 1) {
      return {
        success: false,
        credits: 0
      };
    }

    const newCredits = oldCredits - 1;

    const query =
      `/rest/v1/user_credits` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&credits=eq.${encodeURIComponent(oldCredits)}`;

    const updated = await supabaseRequest(query, {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        credits: newCredits,
        updated_at: new Date().toISOString()
      })
    });

    if (Array.isArray(updated) && updated.length) {
      return {
        success: true,
        credits: newCredits
      };
    }

    await sleep(25 + attempt * 25);
  }

  return {
    success: false,
    conflict: true
  };
}

async function findPaymentOrder(transactionId) {
  const id = String(transactionId || '').trim();
  if (!id) return null;

  const query =
    `/rest/v1/payment_orders?select=order_reference,user_id,amount,currency` +
    `&order_reference=eq.${encodeURIComponent(id)}` +
    `&limit=1`;

  const rows = await supabaseRequest(query, {
    method: 'GET'
  });

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Insert the Paddle transaction into the payment ledger.
// order_reference must be unique/primary in the existing table so the
// same Paddle transaction cannot be recorded twice.
async function createPaymentOrder(transactionId, userId) {
  const row = {
    order_reference: String(transactionId),
    user_id: userId,
    amount: PAYMENT_AMOUNT_USD,
    currency: 'USD'
  };

  const rows = await supabaseRequest('/rest/v1/payment_orders', {
    method: 'POST',
    headers: {
      Prefer: 'return=representation,resolution=ignore-duplicates'
    },
    body: JSON.stringify(row)
  });

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ============================================================
// Paddle API
// ============================================================

async function paddleRequest(endpoint, options = {}) {
  if (!PADDLE_API_KEY) {
    throw new Error('PADDLE_API_KEY не настроен на Render.');
  }

  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(`${PADDLE_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    const rawText = await response.text();

    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { raw: rawText };
    }

    // Paddle rate limit: HTTP 429
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = Number(retryAfterHeader);

      console.error('Paddle API rate limit:', {
        endpoint,
        status: response.status,
        retryAfter: retryAfterHeader,
        response: data
      });

      if (
        attempt < MAX_RETRIES &&
        Number.isFinite(retryAfter) &&
        retryAfter >= 0
      ) {
        await sleep(Math.min(retryAfter * 1000, 65000));
        continue;
      }

      const message =
        data?.error?.detail ||
        data?.error?.message ||
        data?.error?.code ||
        data?.detail ||
        data?.message ||
        `Paddle временно ограничил запросы. Повтори через ${
          Number.isFinite(retryAfter) ? retryAfter : 60
        } секунд.`;

      const error = new Error(String(message));
      error.status = 429;
      error.retryAfter = Number.isFinite(retryAfter)
        ? retryAfter
        : 60;
      error.details = data;

      throw error;
    }

    if (!response.ok) {
      console.error('Paddle API error:', {
        endpoint,
        status: response.status,
        response: data
      });

      const message =
        data?.error?.detail ||
        data?.error?.message ||
        data?.error?.code ||
        data?.detail ||
        data?.message ||
        `Ошибка Paddle API. HTTP ${response.status}`;

      const error = new Error(String(message));
      error.status = response.status;
      error.details = data;

      throw error;
    }

    return data;
  }

  throw new Error('Paddle API: превышено количество повторных попыток.');
}

// ============================================================
// Paddle webhook signature
//
// Paddle sends:
// Paddle-Signature: ts=...;h1=...
//
// The signature is HMAC-SHA256(ts + ":" + rawBody).
// The raw request body MUST be preserved.
// ============================================================

function timingSafeEqualHex(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');

    return aa.length > 0 &&
      aa.length === bb.length &&
      crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function verifyPaddleWebhook(rawBody, signatureHeader) {
  if (!PADDLE_WEBHOOK_SECRET || !signatureHeader) {
    return false;
  }

  const parts = String(signatureHeader)
    .split(';')
    .map(x => x.trim());

  const ts = parts.find(x => x.startsWith('ts='))?.slice(3);

  // Paddle can expose more than one h1 during secret rotation.
  const signatures = parts
    .filter(x => x.startsWith('h1='))
    .map(x => x.slice(3))
    .filter(Boolean);

  if (!ts || !signatures.length) {
    return false;
  }

  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  // Allow reasonable delivery/network delay while still rejecting stale webhooks.
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);

  if (age > 300) {
    return false;
  }

  const signedPayload = `${ts}:${rawBody.toString('utf8')}`;

  const expected = crypto
    .createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return signatures.some(signature =>
    timingSafeEqualHex(expected, signature)
  );
}

// ============================================================
// Paddle webhook
//
// IMPORTANT: this route is BEFORE express.json().
// ============================================================

app.post(
  '/api/payment/paddle-webhook',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const signature = req.get('Paddle-Signature') || '';

      if (!verifyPaddleWebhook(rawBody, signature)) {
        console.error('Paddle webhook: invalid signature.');
        return res.status(401).json({
          error: 'Неверная подпись Paddle.'
        });
      }

      const event = JSON.parse(rawBody.toString('utf8'));

      const eventId =
        event?.event_id ||
        event?.notification_id ||
        '';

      const eventType = event?.event_type || '';
      const data = event?.data || {};

      console.log(
        `Paddle webhook received: ${eventType}; event=${eventId || 'n/a'}`
      );

      // We fulfill only completed transactions.
      if (eventType !== 'transaction.completed') {
        return res.json({
          ok: true,
          ignored: true,
          eventType
        });
      }

      const transactionId = String(data?.id || '').trim();

      if (!transactionId) {
        console.error('Paddle webhook: transaction id missing.');
        return res.status(400).json({
          error: 'В webhook отсутствует transaction id.'
        });
      }

      return await withTransactionLock(transactionId, async () => {
        // --------------------------------------------------------
        // 1. Durable DB idempotency check.
        // If this Paddle transaction is already in payment_orders,
        // NEVER add the 10 credits again.
        // --------------------------------------------------------

        const existingOrder = await findPaymentOrder(transactionId);

        if (existingOrder) {
          console.log(
            `Paddle duplicate ignored: ${transactionId}`
          );

          const balance = await getCreditsByUserId(
            existingOrder.user_id
          );

          return res.json({
            ok: true,
            duplicate: true,
            transactionId,
            credits: balance?.credits ?? null
          });
        }

        // --------------------------------------------------------
        // 2. Identify the user.
        // user_id is placed into custom_data when the transaction
        // is created. Email is kept as a fallback.
        // --------------------------------------------------------

        const customData = data?.custom_data || {};

        let userId = String(customData?.user_id || '').trim();
        const email = normalizeEmail(customData?.email);

        if (!isUuid(userId)) {
          userId = '';
        }

        if (!userId && email) {
          const profile = await findProfileByEmail(email);
          userId = profile?.id || '';
        }

        if (!isUuid(userId)) {
          console.error(
            `Paddle webhook: user not found for transaction ${transactionId}; email=${email}`
          );

          // Return 500 so Paddle can retry the webhook after the
          // user/account data has been fixed.
          return res.status(500).json({
            error: 'Пользователь для платежа не найден в Supabase.'
          });
        }

        // --------------------------------------------------------
        // 3. Check the actual Paddle transaction amount/price.
        // The server-created transaction uses our fixed price ID.
        // --------------------------------------------------------

        const itemPriceIds = Array.isArray(data?.items)
          ? data.items
              .map(item => item?.price?.id || item?.price_id)
              .filter(Boolean)
          : [];

        if (
          itemPriceIds.length &&
          !itemPriceIds.includes(PADDLE_PRICE_ID)
        ) {
          console.error(
            `Paddle webhook: unexpected price for ${transactionId}`,
            itemPriceIds
          );

          return res.status(400).json({
            error: 'Неожиданный Paddle price_id.'
          });
        }

        // --------------------------------------------------------
        // 4. Credit the user exactly once for this transaction.
        //
        // First the ledger is checked above. Then credits are
        // incremented with an atomic compare-and-swap update.
        // Finally the Paddle transaction is written to payment_orders.
        //
        // The in-memory transaction lock prevents the same transaction
        // from being fulfilled concurrently on one Render instance.
        // The payment_orders unique key provides durable duplicate
        // protection across normal webhook retries/restarts.
        // --------------------------------------------------------

        // Record the transaction FIRST. This makes the durable payment
        // ledger the idempotency gate before any credits are added.
        const insertedOrder = await createPaymentOrder(
          transactionId,
          userId
        );

        // If the transaction already exists, never add credits again.
        if (!insertedOrder) {
          const existing = await findPaymentOrder(transactionId);

          if (existing) {
            const balance = await getCreditsByUserId(existing.user_id);

            console.log(
              `Paddle duplicate ignored after ledger check: ${transactionId}`
            );

            return res.json({
              ok: true,
              duplicate: true,
              transactionId,
              credits: balance?.credits ?? null
            });
          }

          console.error(
            `Paddle payment ledger conflict for ${transactionId}.`
          );

          return res.status(500).json({
            error:
              'Платёж уже обрабатывается другим процессом. Paddle повторит webhook.'
          });
        }

        const creditResult = await addCreditsAtomic(
          userId,
          PAYMENT_CREDITS
        );

        console.log(
          `Paddle payment completed: ${transactionId}; ` +
          `${userId} +${PAYMENT_CREDITS} credits; ` +
          `balance=${creditResult.newCredits}`
        );

        return res.json({
          ok: true,
          transactionId,
          creditsAdded: PAYMENT_CREDITS,
          userCredits: creditResult.newCredits
        });
      });
    } catch (err) {
      console.error('Paddle webhook error:', err);

      return res.status(500).json({
        error:
          err?.message ||
          'Ошибка обработки Paddle webhook.'
      });
    }
  }
);

// ============================================================
// Normal JSON/static middleware AFTER webhook route
// ============================================================

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/pricing', (_req, res) => {
  res.sendFile(path.join(__dirname, 'pricing.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'terms.html'));
});

app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

app.get('/refunds', (_req, res) => {
  res.sendFile(path.join(__dirname, 'refunds.html'));
});
// ============================================================
// Health
// ============================================================

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    provider: 'paddle',
    paddleEnvironment: PADDLE_ENV,
    paddleConfigured: !!PADDLE_API_KEY,
    paddleWebhookConfigured: !!PADDLE_WEBHOOK_SECRET,
    paddlePriceConfigured: !!PADDLE_PRICE_ID,
    supabaseConfigured:
      !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY,
    replicateConfigured: !!TOKEN,
    package: {
      amount: PAYMENT_AMOUNT_USD,
      credits: PAYMENT_CREDITS,
      currency: 'USD'
    },
    model: 'black-forest-labs/flux-kontext-pro'
  });
});

// ============================================================
// Create Paddle transaction
// $2.99 = 10 credits
// ============================================================

app.post('/api/payment/create', async (req, res) => {
  try {
    // PRIMARY: identify the logged-in Supabase user from the session token.
    // FALLBACK: keep compatibility with the existing frontend that sends email.
    const authUser = await getAuthenticatedSupabaseUser(req);
    const requestedEmail = normalizeEmail(
      req.body?.email ||
      req.body?.userEmail ||
      req.body?.user_email ||
      req.body?.accountEmail ||
      req.get('X-Lamba-User-Email') ||
      req.get('X-User-Email')
    );
    const requestedUserId = String(
      req.body?.userId ||
      req.body?.user_id ||
      req.body?.accountId ||
      req.get('X-Supabase-User-Id') ||
      ''
    ).trim();

    let email = authUser?.email || requestedEmail;
    let userId = authUser?.id || '';

    // Never allow a logged-in session to create a payment for another email/user.
    if (authUser && requestedEmail && requestedEmail !== authUser.email) {
      return res.status(403).json({
        error: 'Email платежа не совпадает с текущим аккаунтом.'
      });
    }

    if (!userId && isUuid(requestedUserId)) {
      userId = requestedUserId;
    }

    if (!email && !userId) {
      return res.status(401).json({
        error: 'Пользователь не авторизован. Передай Supabase session в Authorization: Bearer <access_token>.'
      });
    }

    if (!PADDLE_API_KEY || !PADDLE_PRICE_ID) {
      return res.status(500).json({
        error:
          'Paddle не настроен. Добавь PADDLE_API_KEY и PADDLE_PRICE_ID в Render.'
      });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error:
          'Supabase не настроен. Добавь SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в Render.'
      });
    }

    // The payment must belong to the authenticated Lamba user.
    // If an authenticated Supabase session was supplied, its user id is already
    // trusted and we do not perform a second email lookup.
    let profile = authUser ? authUser : null;

    if (!profile && email) {
      profile = await findProfileByEmail(email);
    }

    if (!profile?.id && userId) {
      profile = { id: userId, email };
    }

    if (!profile?.id || !isUuid(profile.id)) {
      return res.status(404).json({
        error:
          'Пользователь с этим email не найден в Supabase.'
      });
    }

    email = normalizeEmail(profile.email || email);

    const transaction = await paddleRequest('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            price_id: PADDLE_PRICE_ID,
            quantity: 1
          }
        ],
        collection_mode: 'automatic',
        custom_data: {
          email,
          user_id: profile.id,
          package: 'Lamba Image Studio - 10 generations',
          credits: PAYMENT_CREDITS,
          amount_usd: PAYMENT_AMOUNT_USD
        }
      })
    });

    const data = transaction?.data;

    if (!data?.id || !data?.checkout?.url) {
      console.error(
        'Paddle create transaction response:',
        transaction
      );

      return res.status(502).json({
        error:
          'Paddle не вернул ссылку на оплату.',
        details: transaction
      });
    }

    console.log(
      `Paddle checkout created: ${data.id}; ${email || 'no-email'}; user=${profile.id}; auth=${authUser ? 'supabase-session' : 'fallback'}; $${PAYMENT_AMOUNT_USD}; +${PAYMENT_CREDITS}`
    );

    return res.json({
      ok: true,
      transactionId: data.id,
      checkoutUrl: data.checkout.url,
      amount: PAYMENT_AMOUNT_USD,
      currency: 'USD',
      credits: PAYMENT_CREDITS
    });
  } catch (err) {
    console.error('Paddle create transaction:', err);

    if (err?.status === 429) {
      return res.status(429).json({
        error:
          err?.message ||
          'Paddle временно ограничил запросы. Повтори позже.',
        retryAfter: Number(err?.retryAfter || 60)
      });
    }

    return res.status(
      err?.status >= 400 && err?.status < 500
        ? err.status
        : 500
    ).json({
      error:
        err?.message ||
        'Ошибка создания платежа Paddle.'
    });
  }
});

// ============================================================
// Payment status
// ============================================================

app.get('/api/payment/status/:transactionId', async (req, res) => {
  try {
    const transactionId = String(
      req.params.transactionId || ''
    ).trim();

    if (!transactionId) {
      return res.status(400).json({
        error: 'Не указан transactionId.'
      });
    }

    const payment = await findPaymentOrder(transactionId);

    if (!payment) {
      return res.json({
        ok: true,
        transactionId,
        status: 'pending',
        paid: false,
        creditsAdded: 0
      });
    }

    const balance = await getCreditsByUserId(payment.user_id);

    return res.json({
      ok: true,
      transactionId,
      status: 'completed',
      paid: true,
      creditsAdded: PAYMENT_CREDITS,
      userCredits: balance?.credits ?? 0,
      amount: Number(payment.amount || PAYMENT_AMOUNT_USD),
      currency: payment.currency || 'USD'
    });
  } catch (err) {
    console.error('Payment status error:', err);

    return res.status(500).json({
      error:
        err?.message ||
        'Ошибка проверки статуса платежа.'
    });
  }
});

// ============================================================
// Current credit balance
// ============================================================

app.get('/api/credits', async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({
        error: 'Нужен email пользователя.'
      });
    }

    const profile = await findProfileByEmail(email);

    if (!profile?.id) {
      return res.status(404).json({
        error: 'Пользователь не найден.'
      });
    }

    const balance = await getCreditsByUserId(profile.id);

    if (!balance) {
      return res.status(404).json({
        error:
          'Для пользователя не найдена строка user_credits.'
      });
    }

    return res.json({
      ok: true,
      email,
      userId: profile.id,
      credits: balance.credits
    });
  } catch (err) {
    console.error('Credits error:', err);

    return res.status(500).json({
      error:
        err?.message ||
        'Ошибка получения баланса кредитов.'
    });
  }
});

// ============================================================
// Generate image
//
// IMPORTANT:
// The credit is NOT deducted before generation.
// Replicate must successfully return an image first.
// Then the server performs one atomic -1 update.
// ============================================================

app.post(
  '/api/generate',
  upload.single('image'),
  async (req, res) => {
    try {
      if (!TOKEN || !replicate) {
        return res.status(500).json({
          error:
            'REPLICATE_API_TOKEN не настроен на Render.'
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'Фото не загружено.'
        });
      }

      // Accept the logged-in user's email from the frontend.
      // The image upload uses multipart/form-data, so email must be sent
      // as a form field together with the image.
      // Email can arrive either as a multipart form field or in a header.
      // Accept all names currently used by the Lamba frontend.
      // Prefer the authenticated Supabase user id when the frontend sends it.
      // Email remains a compatibility fallback for the current Lamba frontend.
      const clientUserId = String(
        req.body?.userId ||
        req.body?.user_id ||
        req.body?.accountId ||
        req.get('X-Supabase-User-Id') ||
        ''
      ).trim();

      const email = normalizeEmail(
        req.body?.email ||
        req.body?.userEmail ||
        req.body?.user_email ||
        req.body?.accountEmail ||
        req.get('X-Lamba-User-Email') ||
        req.get('X-User-Email')
      );

      let profile = null;

      if (isUuid(clientUserId)) {
        profile = { id: clientUserId, email };
      } else if (email) {
        profile = await findProfileByEmail(email);
      }

      if (!profile?.id || !isUuid(profile.id)) {
        console.error(
          'Generation: user identity missing.',
          {
            hasEmail: !!email,
            hasUserId: !!clientUserId,
            receivedFields: Object.keys(req.body || {})
          }
        );

        return res.status(400).json({
          error: 'Не удалось определить пользователя.'
        });
      }

      const balance = await getCreditsByUserId(profile.id);

      if (!balance || Number(balance.credits || 0) < 1) {
        return res.status(402).json({
          error: 'Нет доступных генераций.',
          credits: 0
        });
      }

      const prompt = String(
        req.body?.prompt || ''
      ).trim();

      if (!prompt) {
        return res.status(400).json({
          error:
            'Напиши, что изменить на фото.'
        });
      }

      // -------------------- Replicate --------------------

      const output = await replicate.run(
        'black-forest-labs/flux-kontext-pro',
        {
          input: {
            prompt,
            input_image: req.file.buffer,
            aspect_ratio: 'match_input_image',
            output_format: 'jpg',
            safety_tolerance: 2,
            prompt_upsampling: false
          }
        }
      );

      if (!output) {
        throw new Error(
          'Модель не вернула изображение.'
        );
      }

      let data;

      // Replicate FileOutput normally exposes blob().
      if (typeof output.blob === 'function') {
        const blob = await output.blob();
        data = Buffer.from(
          await blob.arrayBuffer()
        );
      } else if (typeof output === 'string') {
        const imageResponse = await fetch(output);

        if (!imageResponse.ok) {
          throw new Error(
            'Не удалось получить изображение от Replicate.'
          );
        }

        data = Buffer.from(
          await imageResponse.arrayBuffer()
        );
      } else if (
        typeof output.arrayBuffer === 'function'
      ) {
        data = Buffer.from(
          await output.arrayBuffer()
        );
      } else {
        throw new Error(
          'Неизвестный формат ответа Replicate.'
        );
      }

      if (!data?.length) {
        throw new Error(
          'Получено пустое изображение.'
        );
      }

      // -------------------- Spend exactly 1 credit --------------------
      //
      // The deduction happens ONLY here, after successful generation.
      // CAS prevents two simultaneous generations from spending the
      // same credit.

      const spent = await spendCreditAtomic(
        profile.id
      );

      if (!spent.success) {
        if (spent.conflict) {
          return res.status(409).json({
            error:
              'Баланс изменился во время генерации. Изображение не выдано, кредит не списан.',
            credits:
              (await getCreditsByUserId(profile.id))
                ?.credits ?? 0
          });
        }

        return res.status(402).json({
          error:
            'Недостаточно кредитов для выдачи результата.',
          credits: spent.credits ?? 0
        });
      }

      console.log(
        `Generation successful: ${email}; -1 credit; remaining=${spent.credits}`
      );

      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.set(
        'X-Lamba-Credits-Remaining',
        String(spent.credits)
      );

      return res.send(data);
    } catch (err) {
      console.error('Generation error:', err);

      return res.status(500).json({
        error:
          err?.message ||
          'Ошибка генерации.'
      });
    }
  }
);

// ============================================================
// Existing video endpoint
// Kept for compatibility with the current frontend.
// It does NOT consume image credits.
// ============================================================

app.post(
  '/api/video',
  upload.single('image'),
  async (req, res) => {
    try {
      if (!TOKEN || !replicate) {
        return res.status(500).json({
          error:
            'REPLICATE_API_TOKEN не настроен на Render.'
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'Фото не загружено.'
        });
      }

      const prompt = String(
        req.body?.prompt ||
          'Камера плавно приближается, человек слегка двигается естественно.'
      ).trim();

      const output = await replicate.run(
        'wan-video/wan-2.2-i2v-fast',
        {
          input: {
            image: new Blob(
              [req.file.buffer],
              { type: req.file.mimetype }
            ),
            prompt,
            go_fast: true,
            num_frames: 81,
            resolution: '480p',
            sample_shift: 12,
            frames_per_second: 16,
            interpolate_output: false
          }
        }
      );

      if (!output) {
        throw new Error(
          'Модель не вернула видео.'
        );
      }

      let data;

      if (typeof output.arrayBuffer === 'function') {
        data = Buffer.from(
          await output.arrayBuffer()
        );
      } else if (typeof output.blob === 'function') {
        const blob = await output.blob();
        data = Buffer.from(
          await blob.arrayBuffer()
        );
      } else if (typeof output === 'string') {
        const videoResponse = await fetch(output);

        if (!videoResponse.ok) {
          throw new Error(
            'Не удалось получить видео от Replicate.'
          );
        }

        data = Buffer.from(
          await videoResponse.arrayBuffer()
        );
      } else {
        throw new Error(
          'Неизвестный формат ответа Replicate для видео.'
        );
      }

      res.set('Content-Type', 'video/mp4');
      res.set('Cache-Control', 'no-store');

      return res.send(data);
    } catch (err) {
      console.error('Video generation error:', err);

      return res.status(500).json({
        error:
          err?.message ||
          'Ошибка генерации видео.'
      });
    }
  }
);

// ============================================================
// Start
// ============================================================

app.listen(PORT, () => {
  console.log(
    `Lamba Remote Image Editor listening on port ${PORT}; ` +
    `Paddle=${PADDLE_ENV}; ` +
    `Supabase=${SUPABASE_URL ? 'configured' : 'missing'}`
  );
});




  

