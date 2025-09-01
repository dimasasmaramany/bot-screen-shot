// server.js
const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');

const app = express();
const PORT = 3030;

// Konfigurasi bot Telegram
const TELEGRAM_CHAT_ID = '5293882405';
// const TELEGRAM_CHAT_ID = '-4255211238';
const TELEGRAM_BOT_TOKEN = '5264797009:AAGi-E0qOQA1m3LKiKnZDxJYFzPhHBpg5B4';

// Endpoint tes koneksi
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Server terhubung dengan baik 🚀'
  });
});

// Endpoint proses screenshot dan kirim ke Telegram
app.get('/process-screenshot', async (req, res) => {
  try {
    const screenshotUrl = req.query.screenshots;

    if (!screenshotUrl) {
      return res.status(400).json({ message: 'Parameter screenshots tidak ditemukan' });
    }

    console.log("📸 Terima screenshot:", screenshotUrl);

    // Ambil gambar dari URL
    const response = await axios.get(screenshotUrl, { responseType: 'arraybuffer' });
    let imageBuffer = Buffer.from(response.data);

    // Crop otomatis
    let croppedImage = await sharp(imageBuffer)
      .extract({ left: 0, top: 50, width: 1270, height: 250 })
      .toBuffer();

    // Hapus buffer awal biar RAM langsung bebas
    imageBuffer = null;

    // Kirim gambar ke Telegram
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', croppedImage, {
      filename: 'screenshot.png',
      contentType: 'image/png'
    });
    

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;

    await axios.post(telegramUrl, formData, {
      headers: formData.getHeaders()
    });

    // Setelah terkirim, kosongkan buffer cropped
    croppedImage = null;

    res.json({
      status: 'success',
      message: 'Gambar berhasil diproses dan dikirim ke Telegram',
      image_url: screenshotUrl
    });

  } catch (error) {
    console.error("❌ Gagal memproses screenshot:", error.message);
    res.status(500).json({ message: 'Gagal memproses screenshot' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server berjalan di http://localhost:${PORT}`);
});