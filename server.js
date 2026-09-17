import express from 'express';
import multer from 'multer';
import Replicate from 'replicate';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.REPLICATE_API_TOKEN;
const replicate = TOKEN ? new Replicate({ auth: TOKEN }) : null;

app.use(express.static('.'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', tokenConfigured: !!TOKEN });
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
app.listen(PORT, () => console.log(`Lamba Remote Image Editor listening on port ${PORT}`));
