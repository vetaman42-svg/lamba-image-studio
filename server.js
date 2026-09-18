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

// WayForPay configuration. Keep the secret only in Render Environment Variables.
const W4P_MERCHANT = process.env.WAYFORPAY_MERCHANT_ACCOUNT || '';
const W4P_SECRET = process.env.WAYFORPAY_SECRET_KEY || '';
const W4P_DOMAIN = process.env.WAYFORPAY_DOMAIN || '';
const W4P_RETURN_URL = process.env.WAYFORPAY_RETURN_URL || '';
const W4P_SERVICE_URL = process.env.WAYFORPAY_SERVICE_URL || '';

// Supabase configuration. Keep the service-role key only in Render Environment Variables.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PAYMENT_AMOUNT_USD = 2.99;
const PAYMENT_CREDITS = 10;

// Temporary payment state. For production, replace this Map with Supabase/DB
// so payments and credits survive a Render restart.
const payments = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// WayForPay returns the customer to this URL with POST data.
// Redirect POST / to GET / so the Lamba page opens instead of showing "Cannot POST /".
app.post('/', (_req, res) => {
  res.redirect(303, '/');
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', tokenConfigured: !!TOKEN });
});

function wayForPaySignature(parts) {
  return crypto
    .createHmac('md5', W4P_SECRET)
    .update(parts.join(';'), 'utf8')
    .digest('hex');
}

function wayForPayReady() {
  return !!(W4P_MERCHANT && W4P_SECRET && W4P_DOMAIN && W4P_RETURN_URL && W4P_SERVICE_URL);
}

function supabaseReady() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function getAuthenticatedSupabaseUser(req) {
  if (!supabaseReady()) {
    throw new Error('Supabase server credentials не настроены.');
  }

  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    return null;
  }

  return await response.json();
}

async function addCreditsToUser(userId, amount) {
  if (!supabaseReady()) {
    throw new Error('Supabase server credentials не настроены.');
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };

  const readResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/user_credits?user_id=eq.${encodeURIComponent(userId)}&select=user_id,credits`,
    { headers }
  );

  if (!readResponse.ok) {
    throw new Error(`Supabase read credits failed: HTTP ${readResponse.status}`);
  }

  const rows = await readResponse.json();

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Пользователь не найден в user_credits.');
  }

  const currentCredits = Number(rows[0].credits) || 0;
  const newCredits = currentCredits + Number(amount);

  const updateResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/user_credits?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        credits: newCredits,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!updateResponse.ok) {
    const details = await updateResponse.text();
    throw new Error(
      `Supabase update credits failed: HTTP ${updateResponse.status} ${details}`
    );
  }

  const updatedRows = await updateResponse.json();

  return Number(updatedRows?.[0]?.credits ?? newCredits);
}

// Create a WayForPay invoice for 10 image generations for $2.99.
app.post(['/api/payment/create', '/api/create-checkout-session'], async (req, res) => {
  try {
    if (!wayForPayReady()) {
      return res.status(500).json({
        error: 'WayForPay не настроен. Добавь WAYFORPAY_MERCHANT_ACCOUNT, WAYFORPAY_SECRET_KEY, WAYFORPAY_DOMAIN, WAYFORPAY_RETURN_URL и WAYFORPAY_SERVICE_URL в Render.'
      });
    }

    const user = await getAuthenticatedSupabaseUser(req);
    if (!user?.id) {
      return res.status(401).json({
        error: 'Сначала войдите в аккаунт Lamba Image Studio.'
      });
    }

    const orderReference = `LAMBA10-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const orderDate = Math.floor(Date.now() / 1000);
    const email = String(user.email || req.body?.email || '').trim();

    const productName = ['Lamba Image Studio — 10 генераций'];
    const productCount = [1];
    const productPrice = [PAYMENT_AMOUNT_USD];

    const signature = wayForPaySignature([
      W4P_MERCHANT,
      W4P_DOMAIN,
      orderReference,
      orderDate,
      PAYMENT_AMOUNT_USD,
      'USD',
      ...productName,
      ...productCount,
      ...productPrice
    ]);

    const payload = {
      transactionType: 'CREATE_INVOICE',
      merchantAccount: W4P_MERCHANT,
      merchantAuthType: 'SimpleSignature',
      merchantDomainName: W4P_DOMAIN,
      merchantSignature: signature,
      apiVersion: 1,
      language: 'RU',
      serviceUrl: W4P_SERVICE_URL,
      returnUrl: W4P_RETURN_URL,
      orderReference,
      orderDate,
      amount: PAYMENT_AMOUNT_USD,
      currency: 'USD',
      orderTimeout: 86400,
      productName,
      productPrice,
      productCount,
      ...(email ? { clientEmail: email } : {})
    };

    const response = await fetch('https://api.wayforpay.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.invoiceUrl) {
      console.error('WayForPay create invoice:', data);
      return res.status(502).json({
        error: data?.reason || data?.reasonCode || 'WayForPay не создал счёт.',
        details: data
      });
    }

    payments.set(orderReference, {
      orderReference,
      userId: user.id,
      amount: PAYMENT_AMOUNT_USD,
      currency: 'USD',
      credits: PAYMENT_CREDITS,
      email,
      status: 'Pending',
      paid: false,
      credited: false,
      createdAt: Date.now()
    });

// Save payment order in Supabase
const savePaymentResponse = await fetch(
  `${SUPABASE_URL}/rest/v1/payment_orders`,
  {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      order_reference: orderReference,
      user_id: user.id,
      amount: PAYMENT_AMOUNT_USD,
      currency: 'USD',
      credits: PAYMENT_CREDITS,
      status: 'Pending',
      credited: false
    })
  }
);

if (!savePaymentResponse.ok) {
  const details = await savePaymentResponse.text();
  throw new Error(
    `Supabase save payment failed: HTTP ${savePaymentResponse.status} ${details}`
  );
}

console.log('Payment order saved in Supabase:', orderReference);
    res.json({
  ok: true,
  orderReference,
  url: data.invoiceUrl,
  invoiceUrl: data.invoiceUrl,
  amount: PAYMENT_AMOUNT_USD,
  currency: 'USD',
  credits: PAYMENT_CREDITS
});

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || 'Ошибка создания платежа.' });
  }
});

// WayForPay payment callback
app.post('/api/payment/wayforpay-callback', async (req, res) => {
  console.log('=== WAYFORPAY CALLBACK START ===');
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Raw callback body:', req.body);

  try {
    if (!W4P_SECRET) {
      console.error('WAYFORPAY_SECRET_KEY is missing');
      return res.status(500).json({
        error: 'WAYFORPAY_SECRET_KEY не настроен.'
      });
    }

    let body = req.body || {};

    // WayForPay may send the whole JSON object as the field name
    // of an application/x-www-form-urlencoded request.
    // Express can expose that request as an object with one or more keys,
    // so inspect BOTH keys and values and try to recover the JSON payload.
    if (!body.orderReference && body && typeof body === 'object') {
      const candidates = [];

      for (const [key, value] of Object.entries(body)) {
        candidates.push(String(key ?? ''));
        if (value !== undefined && value !== null) {
          candidates.push(String(value));
        }
      }

      for (const candidate of candidates) {
        let raw = candidate.trim();

        if (!raw) continue;

        // Remove URL encoding if WayForPay/form parsing left it encoded.
        try {
          raw = decodeURIComponent(raw);
        } catch {
          // Keep the original string when it is not valid URI encoding.
        }

        raw = raw.trim();

        // Remove accidental wrapping quotes.
        raw = raw.replace(/^['"]+|['"]+$/g, '').trim();

        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');

        if (start === -1 || end <= start) continue;

        const jsonText = raw.slice(start, end + 1);

        try {
          const parsed = JSON.parse(jsonText);

          if (parsed && typeof parsed === 'object') {
            body = parsed;
            console.log(
              'WayForPay form payload successfully parsed from form field.'
            );
            break;
          }
        } catch (parseError) {
          console.error(
            'WayForPay form JSON candidate parse failed:',
            parseError?.message || parseError
          );
        }
      }
    }

    console.log('Parsed orderReference:', body.orderReference);
    console.log('Parsed transactionStatus:', body.transactionStatus);
    console.log('Parsed amount:', body.amount);
    console.log('Parsed currency:', body.currency);

    if (!body.orderReference) {
      console.error(
        'WayForPay callback parsing failed. Body keys:',
        Object.keys(body || {})
      );
      console.error('No orderReference in callback');
      return res.status(400).json({
        error: 'WayForPay callback не содержит orderReference.'
      });
    }

    // Verify WayForPay signature
    const expectedSignature = wayForPaySignature([
      body.merchantAccount || '',
      body.orderReference || '',
      body.amount || '',
      body.currency || '',
      body.authCode || '',
      body.cardPan || '',
      body.transactionStatus || '',
      body.reasonCode || ''
    ]);

    console.log('Signature received:', body.merchantSignature);
    console.log('Signature expected:', expectedSignature);

    if (
      !body.merchantSignature ||
      body.merchantSignature !== expectedSignature
    ) {
      console.error('WAYFORPAY SIGNATURE MISMATCH');

      return res.status(400).json({
        error: 'Неверная подпись WayForPay.'
      });
    }

    console.log('Signature OK');

    if (!supabaseReady()) {
      console.error('Supabase is not configured');
      return res.status(500).json({
        error: 'Supabase server credentials не настроены.'
      });
    }

    // Find payment order
    console.log('Looking for payment in Supabase:', body.orderReference);

    const paymentResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_orders?order_reference=eq.${encodeURIComponent(body.orderReference)}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!paymentResponse.ok) {
      const details = await paymentResponse.text();

      console.error(
        'Supabase payment lookup failed:',
        paymentResponse.status,
        details
      );

      throw new Error(
        `Supabase payment lookup failed: HTTP ${paymentResponse.status} ${details}`
      );
    }

    const paymentRows = await paymentResponse.json();
    const payment = paymentRows?.[0];

    console.log('Payment found:', !!payment);

    if (!payment) {
      console.error(
        'PAYMENT NOT FOUND:',
        body.orderReference
      );

      return res.status(404).json({
        error: 'Платёж не найден в payment_orders.'
      });
    }

    console.log('Payment status before:', payment.status);
    console.log('Payment credited before:', payment.credited);

    // Only successful payments receive credits
    if (body.transactionStatus === 'Approved') {

      // If already credited, do not add credits again
      if (payment.credited === true) {
        console.log('Payment already credited. No duplicate credit.');

      } else {

        console.log(
          'APPROVED PAYMENT. Adding',
          PAYMENT_CREDITS,
          'credits to user:',
          payment.user_id
        );

        const creditResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/credit_payment`,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              p_order_reference: body.orderReference,
              p_credits: PAYMENT_CREDITS
            }),
            signal: AbortSignal.timeout(10000)
          }
        );

        const creditText = await creditResponse.text();

        console.log(
          'credit_payment response:',
          creditResponse.status,
          creditText
        );

        if (!creditResponse.ok) {
          throw new Error(
            `credit_payment failed: HTTP ${creditResponse.status} ${creditText}`
          );
        }

        let creditResult = null;

        try {
          creditResult = creditText
            ? JSON.parse(creditText)
            : null;
        } catch {
          creditResult = null;
        }

        const credited = !!creditResult?.[0]?.credited;
        const newBalance =
          creditResult?.[0]?.new_balance ?? null;

        console.log(
          'CREDIT RESULT:',
          'credited =',
          credited,
          'newBalance =',
          newBalance
        );

        // Save final payment status
        const updatePaymentResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/payment_orders?order_reference=eq.${encodeURIComponent(body.orderReference)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              status: 'Approved',
              credited: credited,
              updated_at: new Date().toISOString()
            }),
            signal: AbortSignal.timeout(10000)
          }
        );

        if (!updatePaymentResponse.ok) {
          const details = await updatePaymentResponse.text();

          throw new Error(
            `Supabase payment update failed: HTTP ${updatePaymentResponse.status} ${details}`
          );
        }

        console.log(
          'PAYMENT UPDATED: Approved / credited =',
          credited
        );
      }

    } else {

      console.log(
        'Payment is not Approved:',
        body.transactionStatus
      );

      const updatePaymentResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/payment_orders?order_reference=eq.${encodeURIComponent(body.orderReference)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            status: String(
              body.transactionStatus || 'Declined'
            ),
            updated_at: new Date().toISOString()
          }),
          signal: AbortSignal.timeout(10000)
        }
      );

      if (!updatePaymentResponse.ok) {
        const details = await updatePaymentResponse.text();

        throw new Error(
          `Supabase declined payment update failed: HTTP ${updatePaymentResponse.status} ${details}`
        );
      }
    }

    // WayForPay acknowledgement
    const time = Math.floor(Date.now() / 1000);
    const status = 'accept';

    const signature = wayForPaySignature([
      body.orderReference || '',
      status,
      time
    ]);

    console.log(
      '=== WAYFORPAY CALLBACK SUCCESS ===',
      body.orderReference
    );

    return res.json({
      orderReference: body.orderReference,
      status,
      time,
      signature
    });

  } catch (err) {

    console.error(
      '=== WAYFORPAY CALLBACK ERROR ===',
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        'Ошибка обработки уведомления WayForPay.'
    });
  }
});

// Frontend can check the result of a payment by orderReference.
// Read from Supabase so the result survives a Render restart.
app.get('/api/payment/status/:orderReference', async (req, res) => {
  try {
    const orderReference = String(req.params.orderReference || '').trim();

    if (!orderReference) {
      return res.status(400).json({ error: 'Не указан orderReference.' });
    }

    if (!supabaseReady()) {
      return res.status(500).json({ error: 'Supabase server credentials не настроены.' });
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/payment_orders?order_reference=eq.${encodeURIComponent(orderReference)}&select=order_reference,status,credited,amount,currency,credits`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Supabase payment status failed: HTTP ${response.status} ${details}`);
    }

    const rows = await response.json();
    const payment = rows?.[0];

    if (!payment) {
      return res.status(404).json({ error: 'Платёж не найден.' });
    }

    res.json({
      ok: true,
      orderReference: payment.order_reference,
      status: payment.status,
      paid: payment.status === 'Approved',
      credited: !!payment.credited,
      creditsToAdd: payment.credits || 0,
      amount: payment.amount,
      currency: payment.currency
    });
  } catch (err) {
    console.error('Payment status error:', err);
    res.status(500).json({
      error: err?.message || 'Ошибка проверки платежа.'
    });
  }
});

app.post('/api/generate', upload.single('image'), async (req, res) => {
  let tmp = null;

  try {
    // Проверяем Replicate
    if (!TOKEN) {
      return res.status(500).json({
        error: 'REPLICATE_API_TOKEN не настроен на Render.'
      });
    }

    // Проверяем авторизацию пользователя
    const user = await getAuthenticatedSupabaseUser(req);

    if (!user?.id) {
      return res.status(401).json({
        error: 'Сначала войдите в аккаунт Lamba Image Studio.'
      });
    }

    // Проверяем фото
    if (!req.file) {
      return res.status(400).json({
        error: 'Фото не загружено.'
      });
    }

    const prompt = String(req.body?.prompt || '').trim();

    if (!prompt) {
      return res.status(400).json({
        error: 'Напиши, что изменить на фото.'
      });
    }

    // Проверяем баланс кредитов
    if (!supabaseReady()) {
      return res.status(500).json({
        error: 'Supabase server credentials не настроены.'
      });
    }

    const headers = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    };

    const creditsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/user_credits?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,credits`,
      { headers }
    );

    if (!creditsResponse.ok) {
      const details = await creditsResponse.text();

      throw new Error(
        `Supabase read credits failed: HTTP ${creditsResponse.status} ${details}`
      );
    }

    const creditRows = await creditsResponse.json();

    if (!Array.isArray(creditRows) || !creditRows.length) {
      return res.status(403).json({
        error: 'Для пользователя не создан баланс кредитов.'
      });
    }

    const currentCredits = Number(creditRows[0].credits) || 0;

    if (currentCredits < 1) {
      return res.status(402).json({
        error: 'У вас закончились генерации. Купите пакет из 10 генераций.'
      });
    }

    // Временный файл
    const ext =
      path.extname(req.file.originalname || '').toLowerCase() || '.jpg';

    tmp = path.join(
      os.tmpdir(),
      `lamba-${Date.now()}${ext}`
    );

    await fs.writeFile(tmp, req.file.buffer);

    // Генерация изображения
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

    // Списываем 1 кредит только после успешной генерации
    const newCredits = currentCredits - 1;

    const updateCreditsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/user_credits?user_id=eq.${encodeURIComponent(user.id)}`,
      {
        method: 'PATCH',
        headers: {
          ...headers,
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          credits: newCredits,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!updateCreditsResponse.ok) {
      const details = await updateCreditsResponse.text();

      throw new Error(
        `Supabase update credits failed: HTTP ${updateCreditsResponse.status} ${details}`
      );
    }

    console.log(
      `Lamba generation: user=${user.id}, credits ${currentCredits} -> ${newCredits}`
    );

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.set('X-Credits-Remaining', String(newCredits));
    res.send(data);

  } catch (err) {
    console.error('Lamba generation error:', err);

    res.status(500).json({
      error: err?.message || 'Ошибка генерации.'
    });

  } finally {
    if (tmp) {
      await fs.unlink(tmp).catch(() => {});
    }
  }
});

app.post('/api/video', upload.single('image'), async (req, res) => {
  try {
    if (!TOKEN) {
      return res.status(500).json({ error: 'REPLICATE_API_TOKEN не настроен на Render.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Фото не загружено.' });
    }

    const prompt = String(req.body?.prompt || 'Камера плавно приближается, человек слегка двигается естественно.').trim();

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
app.listen(PORT, "0.0.0.0", () => console.log(`Lamba Remote Image Editor listening on 0.0.0.0:${PORT}`));



  
  

  
    
    
      
      
      
    


  
    
    
      


      

  

  
  




