// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');
const https = require('https');
const dns = require('dns');

// Paksa prioritas IPv4 supaya tidak lari ke [::1]/IPv6
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = Number(process.env.PORT || 3030);

// === Konfigurasi dari ENV (WAJIB diisi) ===
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Endpoint tes koneksi
app.get('/', (_req, res) => {
  res.json({ status: 'success', message: 'Server terhubung dengan baik 🚀' });
});

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Download gambar → Buffer (redirect OK, UA, retry on transient errors)
async function fetchImageBuffer(url, attempt = 1) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 45_000,
      httpsAgent,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.8',
      },
      validateStatus: (s) => s >= 200 && s < 400, // 2xx–3xx OK
    });
    return Buffer.from(resp.data);
  } catch (err) {
    const transient = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'];
    if (attempt < 3 && (transient.includes(err.code) || /socket hang up/i.test(err.message))) {
      const wait = 300 * attempt;
      console.warn(`⚠️ fetch retry ${attempt} in ${wait}ms due to ${err.code || err.message}`);
      await new Promise(r => setTimeout(r, wait));
      return fetchImageBuffer(url, attempt + 1);
    }
    throw err;
  }
}

// Crop aman (tak melebihi ukuran gambar)
async function safeCrop(buf, box) {
  const meta = await sharp(buf).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;

  const left   = Math.max(0, Math.min(box.left ?? 0, W - 1));
  const top    = Math.max(0, Math.min(box.top ?? 0, H - 1));
  const width  = Math.max(1, Math.min(box.width ?? W,  W - left));
  const height = Math.max(1, Math.min(box.height ?? H, H - top));

  return await sharp(buf).extract({ left, top, width, height }).png().toBuffer();
}

// /process-screenshot?screenshots=<URL>&dryRun=1(optional)
app.get('/process-screenshot', async (req, res) => {
  const screenshotUrl = req.query.screenshots;
  const dryRun = String(req.query.dryRun || '') === '1';

  if (!screenshotUrl) {
    return res.status(400).json({ error: 'MISSING_PARAM', message: 'Parameter "screenshots" tidak ditemukan' });
  }

  // Signed URL GCS sering kepotong kalau tidak di-encode
  if (screenshotUrl.includes('googleapis.com') && !screenshotUrl.includes('Signature=')) {
    return res.status(400).json({
      error: 'BAD_PARAM',
      message: 'Signed URL tidak lengkap. Pastikan nilai "screenshots" di-encode atau dikirim via query parameters n8n.',
    });
  }

  try {
    console.log('📸 URL masuk:', screenshotUrl);

    const imageBuffer = await fetchImageBuffer(screenshotUrl);

    // Box crop default (disesuaikan otomatis bila melebihi ukuran)
    const cropBox = { left: 0, top: 50, width: 1270, height: 250 };
    const croppedImage = await safeCrop(imageBuffer, cropBox);

    if (dryRun) {
      res.setHeader('Content-Type', 'image/png');
      return res.send(croppedImage);
    }

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(500).json({
        error: 'NO_TELEGRAM_CONFIG',
        message: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum dikonfigurasi',
      });
    }

    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('photo', croppedImage, { filename: 'screenshot.png', contentType: 'image/png' });

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    const tgResp = await axios.post(telegramUrl, form, {
      headers: form.getHeaders(),
      timeout: 30_000,
      httpsAgent,
    });

    return res.json({
      status: 'success',
      message: 'Gambar berhasil diproses & dikirim ke Telegram',
      telegram_result: tgResp.data,
    });
  } catch (err) {
    const detail = {
      name: err.name,
      message: err.message,
      code: err.code,
      sharp: err?.constructor?.name,
      axiosStatus: err.response?.status,
      axiosData:
        typeof err.response?.data === 'string'
          ? err.response.data.slice(0, 300)
          : err.response?.data,
    };
    console.error('❌ Process error:', detail);
    return res.status(500).json({ error: 'PROCESS_FAILED', detail });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server berjalan di http://localhost:${PORT}`);
});
