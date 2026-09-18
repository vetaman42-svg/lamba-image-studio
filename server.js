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

// WayForPay sends payment status here.
// WayForPay sends payment status here.
app.post('/api/payment/wayforpay-callback', async (req, res) => {
  console.log('WAYFORPAY HEADERS:', req.headers['content-type']);
  console.log('WAYFORPAY CALLBACK BODY:', req.body);

  try {
    if (!W4P_SECRET) {
      return res.status(500).json({
        error: 'WAYFORPAY_SECRET_KEY не настроен.'
      });
    }

    let body = req.body || {};

    // WayForPay should send JSON, but in our current setup
    // the request arrives as application/x-www-form-urlencoded
    // with the whole JSON object used as the field name.
    if (!body.orderReference) {
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (e) {
          console.error('WayForPay string JSON parse error:', e);
        }
      }

      if (!body.orderReference && body && typeof body === 'object') {
        const keys = Object.keys(body);

        if (keys.length === 1) {
          const raw = String(keys[0]).trim();

          if (raw.startsWith('{')) {
            try {
              // Remove anything accidentally added before/after the JSON.
              const start = raw.indexOf('{');
              const end = raw.lastIndexOf('}');

              if (start !== -1 && end > start) {
                body = JSON.parse(raw.slice(start, end + 1));
              }
            } catch (e) {
              console.error(
                'WayForPay callback JSON parse error:',
                e,
                'RAW:',
                raw
              );
            }
          }
        }
      }
    }

    console.log('WAYFORPAY PARSED BODY:', body);

    if (!body.orderReference) {
      return res.status(400).json({
        error: 'WayForPay callback не содержит orderReference.'
      });
    }

    const expected = wayForPaySignature([
      body.merchantAccount || '',
      body.orderReference || '',
      body.amount || '',
      body.currency || '',
      body.authCode || '',
      body.cardPan || '',
      body.transactionStatus || '',
      body.reasonCode || ''
    ]);

    if (
      !body.merchantSignature ||
      body.merchantSignature !== expected
    ) {
      console.error('WayForPay signature mismatch:', {
        orderReference: body.orderReference,
        transactionStatus: body.transactionStatus
      });

      return res.status(400).json({
        error: 'Неверная подпись WayForPay.'
      });
    }

    const paymentResponse = await fetch(
  `${SUPABASE_URL}/rest/v1/payment_orders?order_reference=eq.${encodeURIComponent(body.orderReference)}&select=*`,
  {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  }
);

if (!paymentResponse.ok) {
  const details = await paymentResponse.text();
  throw new Error(
    `Supabase payment lookup failed: HTTP ${paymentResponse.status} ${details}`
  );
}

const paymentRows = await paymentResponse.json();
const payment = paymentRows?.[0];

if (!payment) {
  console.error(
    'WayForPay payment not found in Supabase:',
    body.orderReference
  );
} else {
  console.log('WayForPay payment found in Supabase:', body.orderReference);

  if (body.transactionStatus === 'Approved') {
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
        })
      }
    );

    if (!creditResponse.ok) {
      const details = await creditResponse.text();
      throw new Error(
        `Supabase credit payment failed: HTTP ${creditResponse.status} ${details}`
      );
    }

    const creditResult = await creditResponse.json();

    console.log(
      `WayForPay Approved: credited=${creditResult?.[0]?.credited}; balance=${creditResult?.[0]?.new_balance}`
    );
  }
}

    
      
      
      

      
      

      
        
          
          
        

        
       
        

        
          
        
      
        
      
    
      
        
        
      
  

    const time = Math.floor(Date.now() / 1000);
    const status = 'accept';

    const signature = wayForPaySignature([
      body.orderReference || '',
      status,
      time
    ]);

    return res.json({
      orderReference: body.orderReference,
      status,
      time,
      signature
    });

  } catch (err) {
    console.error('WayForPay callback error:', err);

    return res.status(500).json({
      error: 'Ошибка обработки уведомления WayForPay.'
    });
  }
});


                                                                 
    
      
    

    

  

  
    
      
    
      
      
    
  

    
      
      
    
      
      
    
      
      
    

    
      
    

    
    
      
      
      

      
      
      

      
        
       
        
        
        
      
        
      
    

    
    
    
      
      
      
    

    
      
      
      
    
    
  
  
    
  


// Frontend can check the result of a payment by orderReference.
app.get('/api/payment/status/:orderReference', (req, res) => {
  const payment = payments.get(req.params.orderReference);
  if (!payment) {
    return res.status(404).json({ error: 'Платёж не найден.' });
  }

  res.json({
    ok: true,
    orderReference: payment.orderReference,
    status: payment.status,
    paid: !!payment.paid,
    creditsToAdd: payment.creditsToAdd || 0,
    newBalance: payment.newBalance ?? null,
    amount: payment.amount,
    currency: payment.currency
  });
});

app.post('/api/generate', upload.single('image'), async (req, res) => {
  let tmp = null;
  try {
    if (!TOKEN) return res.status(500).json({ error: 'REPLICATE_API_TOKEN не настроен на Render.' });
    if (!req.file) return res.status(400).json({ error: 'Фото не загружено.' });
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Напиши, что изменить на фото.' });

    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
    tmp = path.join(os.tmpdir(), `lamba-${Date.now()}${ext}`);
    await fs.writeFile(tmp, req.file.buffer);

    const output = await replicate.run('black-forest-labs/flux-kontext-pro', {
      input: {
        prompt,
        input_image: req.file.buffer,
        aspect_ratio: 'match_input_image',
        output_format: 'jpg',
        safety_tolerance: 2,
        prompt_upsampling: false
      }
    });

    if (!output) throw new Error('Модель не вернула изображение.');
    const data = Buffer.from(await output.blob().then(b => b.arrayBuffer()));

                            
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || 'Ошибка генерации.' });
  } finally {
    if (tmp) await fs.unlink(tmp).catch(() => {});
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



