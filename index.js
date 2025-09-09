// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');
const https = require('https');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = Number(process.env.PORT || 3030);

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.get('/', (_req, res) => {
  res.json({ status: 'success', message: 'Server terhubung dengan baik 🚀' });
});

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Ambil gambar (dengan retry ringan)
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
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return Buffer.from(resp.data);
  } catch (err) {
    const transient = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'];
    if (attempt < 3 && (transient.includes(err.code) || /socket hang up/i.test(err.message))) {
      const wait = 300 * attempt;
      await new Promise(r => setTimeout(r, wait));
      return fetchImageBuffer(url, attempt + 1);
    }
    throw err;
  }
}

/**
 * Auto-crop tabel:
 * - trim(10) untuk buang whitespace (threshold kecil supaya garis tipis tetap aman)
 * - padding opsional (default 8px) biar tidak terlalu mepet
 * - resizeWidth opsional kalau mau dipersempit
 *
 * Query yang didukung:
 *   pad=<number>     : padding (default 8)
 *   resizeWidth=<px> : kalau ingin ubah lebar hasil (mis. 1280)
 *   box=left,top,w,h : override manual (lewati auto-trim)
 */
async function cropTable(buffer, query) {
  const pad = Number.isFinite(Number(query.pad)) ? Number(query.pad) : 8;

  // Manual override kalau disediakan
  if (query.box) {
    const [l, t, w, h] = String(query.box).split(',').map(n => Number(n));
    const meta = await sharp(buffer).metadata();
    const W = meta.width ?? 1, H = meta.height ?? 1;
    const left   = Math.max(0, Math.min(isFinite(l)?l:0, W-1));
    const top    = Math.max(0, Math.min(isFinite(t)?t:0, H-1));
    const width  = Math.max(1, Math.min(isFinite(w)?w:W,  W-left));
    const height = Math.max(1, Math.min(isFinite(h)?h:H, H-top));
    return sharp(buffer).extract({ left, top, width, height }).png().toBuffer();
  }

  // 1) Auto-trim: hilangkan ruang putih keliling tabel (SS#2 menunjukkan tabel dikelilingi whitespace)
  let trimmed = await sharp(buffer).trim({ threshold: 10 }).toBuffer();


  // 2) Tambah padding biar tidak terlalu mepet ke border
  //    (gunakan extend; kalau hasil trim sudah pas, padding kecil bikin lebih rapi)
  trimmed = await sharp(trimmed)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  // 3) Optional resizeWidth
  if (query.resizeWidth) {
    const targetW = Math.max(320, Math.min(4000, Number(query.resizeWidth)));
    trimmed = await sharp(trimmed).resize({ width: targetW }).png().toBuffer();
  }

  return trimmed;
}

// Endpoint utama
app.get('/process-screenshot', async (req, res) => {
  const screenshotUrl = req.query.screenshots;
  const dryRun = String(req.query.dryRun || '') === '1';

  if (!screenshotUrl) {
    return res.status(400).json({ error: 'MISSING_PARAM', message: 'Parameter "screenshots" tidak ditemukan' });
  }
  if (screenshotUrl.includes('googleapis.com') && !screenshotUrl.includes('Signature=')) {
    return res.status(400).json({
      error: 'BAD_PARAM',
      message: 'Signed URL tidak lengkap. Pastikan nilai "screenshots" di-encode atau dikirim via Send Query Parameters di n8n.',
    });
  }

  try {
    const imageBuffer = await fetchImageBuffer(screenshotUrl);

    // === Auto-trim untuk dapat seluruh tabel (sesuai SS#2) ===
    const croppedImage = await cropTable(imageBuffer, req.query);

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
