const router = require('express').Router();
const User   = require('../models/User');
const axios  = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN || '8858053119:AAHhpSRz3ge2_K0uwoWKNM47hp3TJRL_x3k';

function adminOnly(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'] || req.body?.key;
  if (!key || key !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ status: 'error', message: '🚫 Unauthorized' });
  }
  next();
}

async function sendTG(tg_id, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id:    tg_id,
      text:       text,
      parse_mode: 'HTML'
    }, { timeout: 8000 });
    return { success: tru
  } catch(e) 
    return { success: false, reason: e?.response.data?.description || e.message }

// POST /broadcast?key=ADMIN_SECRET
// body: { message: "..." }
router.post('/', adminOnly, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim())
      return res.status(400).json({ status: 'error', message: 'Message required' });

    const users = await User.find({ tg_id: { $exists: true, $ne: '' } }).select('name mobile tg_id').lean();

    if (!users.length)
      return res.json({ status: 'error', message: 'No users with Telegram ID found' });

    let sent = 0, failed = 0;
    const failedList = [];

    const finalMessage = message + '\n\n— BROADCAST BY NEXO WALLET 🔐';

    for (const user of users) {
      const result = await sendTG(user.tg_id, finalMessage);
      if (result.success) {
        sent++;
      } else {
        failed++;
        failedList.push({ name: user.name, mobile: user.mobile, tg_id: user.tg_id, reason: result.reason });
      }
      // 50ms delay to avoid TG rate limit
      await new Promise(r => setTimeout(r, 50));
    }

    return res.json({
      status:      'success',
      message:     '✅ Broadcast complete!',
      total_users: users.length,
      sent,
      failed,
      failed_list: failedList
    });

  } catch(e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

module.exports = router;
  
