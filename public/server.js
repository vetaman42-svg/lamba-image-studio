import express from 'express';
import multer from 'multer';
import Replicate from 'replicate';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.REPLICATE_API_TOKEN;
const replicate = TOKEN ? new Replicate({ auth: TOKEN }) : null;

// Paddle Billing
// Keep secrets only in Render Environment Variables.
const PADDLE_API_KEY = process.env.PADDLE_API_KEY || '';
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_PRICE_ID = process.env.PADDLE_PRICE_ID || 'pri_01m2yhnx9141nykm53kqaf2dyp';
const PADDLE_ENV = (process.env.PADDLE_ENV || 'sandbox').toLowerCase();
const PADDLE_API_BASE =
  PADDLE_ENV === 'live'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

const PAYMENT_AMOUNT_USD = 2.99;
const PAYMENT_CREDITS = 10;

// Temporary local state.
// IMPORTANT: Render's normal filesystem is not persistent across all redeploys/restarts.
// This keeps the current test flow working, but a real production database should replace it.
const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'lamba-state.json');

let state = {
  users: {},
  payments: {},
  processedEvents: {}
};

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    state = { ...state, ...JSON.parse(raw) };
  } catch {
    await saveState();
  }
}

let saveQueue = Promise.resolve();
function saveState() {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  }).catch(err => console.error('State save error:', err));
  return saveQueue;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getUser(email) {
  const key = normalizeEmail(email);
  if (!key) return null;

  if (!state.users[key]) {
    state.users[key] = {
      email: key,
      credits: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  return state.users[key];
}

function addCredits(email, amount) {
  const user = getUser(email);
  if (!user) return null;

  user.credits = Math.max(0, Number(user.credits || 0) + Number(amount || 0));
  user.updatedAt = Date.now();
  return user;
}

function spendCredit(email) {
  const user = getUser(email);
  if (!user || Number(user.credits || 0) < 1) return false;

  user.credits -= 1;
  user.updatedAt = Date.now();
  return true;
}

function timingSafeEqualHex(a, b) {
  try {
    const aa = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function verifyPaddleWebhook(rawBody, signatureHeader) {
  if (!PADDLE_WEBHOOK_SECRET || !signatureHeader) return false;

  const parts = String(signatureHeader)
    .split(';')
    .map(x => x.trim());

  const ts = parts.find(x => x.startsWith('ts='))?.slice(3);
  const h1 = parts.find(x => x.startsWith('h1='))?.slice(3);

  if (!ts || !h1) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const signedPayload = `${ts}:${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return timingSafeEqualHex(expected, h1);
}

async function paddleRequest(endpoint, options = {}) {
  if (!PADDLE_API_KEY) {
    throw new Error('PADDLE_API_KEY не настроен на Render.');
  }

  const response = await fetch(`${PADDLE_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error?.detail ||
      data?.error?.code ||
      data?.detail ||
      'Ошибка Paddle API.';
    const err = new Error(message);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

// Paddle webhook MUST receive the raw request body for signature verification.
// Register it before express.json().
app.post('/api/payment/paddle-webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const signature = req.get('Paddle-Signature') || '';

    if (!verifyPaddleWebhook(rawBody, signature)) {
      return res.status(401).json({ error: 'Неверная подпись Paddle.' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const eventId = event?.event_id || event?.notification_id || '';

    if (eventId && state.processedEvents[eventId]) {
      return res.json({ ok: true, duplicate: true });
    }

    const eventType = event?.event_type || '';
    const data = event?.data || {};

    // One-time package fulfillment.
    // Paddle's transaction.completed means the transaction has completed processing.
    if (eventType === 'transaction.completed') {
      const transactionId = data?.id || '';
      const customData = data?.custom_data || {};
      const email = normalizeEmail(customData.email);

      if (!email) {
        console.error('Paddle webhook: email missing in custom_data', transactionId);
      } else if (!state.payments[transactionId]?.credited) {
        const user = addCredits(email, PAYMENT_CREDITS);

        state.payments[transactionId] = {
          transactionId,
          email,
          credits: PAYMENT_CREDITS,
          amount: data?.details?.totals?.total || null,
          currency: data?.currency_code || 'USD',
          status: 'completed',
          credited: true,
          createdAt: state.payments[transactionId]?.createdAt || Date.now(),
          updatedAt: Date.now()
        };

        console.log(
          `Paddle payment completed: ${transactionId}; ${email} +${PAYMENT_CREDITS} credits; balance=${user?.credits}`
        );
      }
    }

    if (eventId) {
      state.processedEvents[eventId] = {
        eventType,
        receivedAt: Date.now()
      };
    }

    await saveState();
    return res.json({ ok: true });
  } catch (err) {
    console.error('Paddle webhook error:', err);
    return res.status(500).json({ error: 'Ошибка обработки Paddle webhook.' });
  }
});

app.use(express.json());
app.use(express.static('.'));

// Health
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    provider: 'paddle',
    paddleEnvironment: PADDLE_ENV,
    paddleConfigured: !!PADDLE_API_KEY,
    paddlePriceConfigured: !!PADDLE_PRICE_ID,
    replicateConfigured: !!TOKEN,
    model: 'black-forest-labs/flux-kontext-pro'
  });
});

// Create a Paddle transaction for $2.99 / 10 generations.
app.post('/api/payment/create', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ error: 'Нужен email пользователя.' });
    }

    if (!PADDLE_API_KEY || !PADDLE_PRICE_ID) {
      return res.status(500).json({
        error: 'Paddle не настроен. Добавь PADDLE_API_KEY и PADDLE_PRICE_ID в Render.'
      });
    }

    const transaction = await paddleRequest('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            price_id: PADDLE_PRICE_ID,
            quantity: 1
          }
        ],
        custom_data: {
          email,
          package: 'Lamba Image Studio — 10 generations',
          credits: PAYMENT_CREDITS
        }
      })
    });

    const data = transaction?.data;

    if (!data?.id || !data?.checkout?.url) {
      console.error('Paddle create transaction response:', transaction);
      return res.status(502).json({
        error: 'Paddle не вернул ссылку на оплату.',
        details: transaction
      });
    }

    state.payments[data.id] = {
      transactionId: data.id,
      email,
      credits: PAYMENT_CREDITS,
      amount: PAYMENT_AMOUNT_USD,
      currency: 'USD',
      status: data.status || 'ready',
      credited: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await saveState();

    res.json({
      ok: true,
      transactionId: data.id,
      checkoutUrl: data.checkout.url,
      amount: PAYMENT_AMOUNT_USD,
      currency: 'USD',
      credits: PAYMENT_CREDITS
    });
  } catch (err) {
    console.error('Paddle create transaction:', err);
    res.status(500).json({
      error: err?.message || 'Ошибка создания платежа Paddle.'
    });
  }
});

// Frontend can check a transaction/payment result.
app.get('/api/payment/status/:transactionId', (req, res) => {
  const payment = state.payments[req.params.transactionId];

  if (!payment) {
    return res.status(404).json({ error: 'Платёж не найден.' });
  }

  const user = getUser(payment.email);

  res.json({
    ok: true,
    transactionId: payment.transactionId,
    status: payment.status,
    paid: !!payment.credited,
    creditsAdded: payment.credited ? payment.credits : 0,
    userCredits: user?.credits || 0,
    amount: payment.amount,
    currency: payment.currency
  });
});

// Get current user's credit balance.
app.get('/api/credits', (req, res) => {
  const email = normalizeEmail(req.query.email);

  if (!email) {
    return res.status(400).json({ error: 'Нужен email пользователя.' });
  }

  const user = getUser(email);

  res.json({
    ok: true,
    email: user.email,
    credits: user.credits
  });
});

// Generate image — one credit is spent only after a successful generation.
app.post('/api/generate', upload.single('image'), async (req, res) => {
  let tmp = null;

  try {
    if (!TOKEN) {
      return res.status(500).json({
        error: 'REPLICATE_API_TOKEN не настроен на Render.'
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Фото не загружено.' });
    }

    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ error: 'Нужен email пользователя.' });
    }

    const user = getUser(email);
    if (Number(user.credits || 0) < 1) {
      return res.status(402).json({
        error: 'Нет доступных генераций.',
        credits: 0
      });
    }

    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: 'Напиши, что изменить на фото.' });
    }

    const ext =
      path.extname(req.file.originalname || '').toLowerCase() || '.jpg';

    tmp = path.join(os.tmpdir(), `lamba-${Date.now()}${ext}`);
    await fs.writeFile(tmp, req.file.buffer);

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
      throw new Error('Модель не вернула изображение.');
    }

    const data = Buffer.from(
      await output.blob().then(b => b.arrayBuffer())
    );

    // Spend the credit only after Replicate successfully returned an image.
    spendCredit(email);
    await saveState();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.set('X-Lamba-Credits-Remaining', String(getUser(email)?.credits || 0));
    res.send(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || 'Ошибка генерации.' });
  } finally {
    if (tmp) await fs.unlink(tmp).catch(() => {});
  }
});

// Existing video endpoint kept unchanged.
app.post('/api/video', upload.single('image'), async (req, res) => {
  try {
    if (!TOKEN) {
      return res.status(500).json({
        error: 'REPLICATE_API_TOKEN не настроен на Render.'
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Фото не загружено.' });
    }

    const prompt = String(
      req.body?.prompt ||
      'Камера плавно приближается, человек слегка двигается естественно.'
    ).trim();

    const output = await replicate.run('wan-video/wan-2.2-i2v-fast', {
      input: {
        image: new Blob([req.file.buffer], { type: req.file.mimetype }),
        prompt,
        go_fast: true,
        num_frames: 81,
        resolution: '480p',
        sample_shift: 12,
        frames_per_second: 16,
        interpolate_output: false
      }
    });

    if (!output) {
      throw new Error('Модель не вернула видео.');
    }

    const data = Buffer.from(await output.arrayBuffer());

    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'no-store');
    res.send(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err?.message || 'Ошибка генерации видео.'
    });
  }
});

await loadState();

app.listen(PORT, () =>
  console.log(
    `Lamba Remote Image Editor listening on port ${PORT}; Paddle=${PADDLE_ENV}`
  )
);

