const router      = require('express').Router();
const jwt         = require('jsonwebtoken');
const User        = require('../models/User');
const GiftCode    = require('../models/GiftCode');
const Transaction = require('../models/Transaction');

const BOT_TOKEN  = process.env.BOT_TOKEN   || '';
const ADMIN_PASS = process.env.ADMIN_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET  || 'royalwallet_secret_2026';

async function sendTG(tg_id, text) {
  if (!tg_id||!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:tg_id, text, parse_mode:'HTML' })
    });
  } catch(e) {}
}

// ── Auto-generate unique 5-digit code ────────────────────────────
async function generateUniqueCode() {
  let code, exists;
  do {
    code = Math.floor(10000 + Math.random() * 90000).toString(); // 10000–99999
    exists = await GiftCode.findOne({ code });
  } while (exists);
  return code;
}

// ── Create Gift Code (Admin OR User) ─────────────────────────────
router.post('/create', async (req, res) => {
  try {
    const { key, amount, max_uses, expires_hours, remark } = req.body;
    const isAdmin = key === ADMIN_PASS;
    let user = null;

    if (!isAdmin) {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(403).json({ status:'error', message:'Unauthorized' });
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        user = await User.findById(decoded.id);
        if (!user) return res.status(404).json({ status:'error', message:'User not found' });
      } catch(e) {
        return res.status(401).json({ status:'error', message:'Invalid token' });
      }
    }

    if (!amount) return res.status(400).json({ status:'error', message:'amount required' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 1) return res.status(400).json({ status:'error', message:'Minimum ₹1' });
    const uses = parseInt(max_uses) || 1;
    const totalCost = parseFloat((amt * uses).toFixed(2));

    // Auto-generate unique 5-digit code
    const code = await generateUniqueCode();

    // User balance cut
    if (!isAdmin) {
      if (user.balance < totalCost)
        return res.status(400).json({ status:'error', message:`Insufficient balance. Need ₹${totalCost}, Available: ₹${user.balance}` });

      await User.findByIdAndUpdate(user._id, { $inc:{ balance:-totalCost } });
      await Transaction.create({
        sender_id: user._id,
        amount: totalCost,
        type: 'transfer',
        status: 'success',
        remark: `Gift Code Created: ${code}${remark ? ' | ' + remark : ''}`,
        tx_time: new Date()
      });

      if (user.tg_id) sendTG(user.tg_id,
        `🎁 <b>Gift Code Created!</b>\n\n` +
        `🔑 Code: <code>${code}</code>\n` +
        `💰 Amount: ₹${amt}/use\n` +
        `🎯 Max Uses: ${uses}\n` +
        `💸 Total Deducted: ₹${totalCost}\n` +
        (remark ? `📝 Remark: ${remark}\n` : '') +
        `\n👑 ROYAL WALLET`
      );
    }

    const expires_at = expires_hours ? new Date(Date.now() + parseInt(expires_hours)*3600000) : null;
    const gc = await GiftCode.create({
      code,
      amount: amt,
      max_uses: uses,
      expires_at,
      remark: remark || '',
      created_by: user?._id || null
    });

    res.json({
      status: 'success',
      code: gc.code,
      amount: gc.amount,
      max_uses: gc.max_uses,
      remark: gc.remark,
      total_cost: isAdmin ? 0 : totalCost
    });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// ── Redeem Gift Code ──────────────────────────────────────────────
router.post('/redeem', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ status:'error', message:'Code required' });
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ status:'error', message:'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ status:'error', message:'User not found' });

    const gc = await GiftCode.findOne({ code: code.toString().trim(), active:true });
    if (!gc) return res.status(404).json({ status:'error', message:'Invalid or expired code' });
    if (gc.expires_at && new Date() > gc.expires_at) return res.status(400).json({ status:'error', message:'Code expired!' });
    if (gc.used_by.includes(user.mobile)) return res.status(400).json({ status:'error', message:'Already redeemed!' });
    if (gc.used_count >= gc.max_uses) return res.status(400).json({ status:'error', message:'Code limit reached!' });

    // Agar creator khud redeem karne ki koshish kare
    if (gc.created_by && gc.created_by.toString() === user._id.toString())
      return res.status(400).json({ status:'error', message:'Apna hi code redeem nahi kar sakte!' });

    await GiftCode.findByIdAndUpdate(gc._id, {
      $inc: { used_count:1 },
      $push: { used_by:user.mobile },
      ...(gc.used_count+1 >= gc.max_uses ? { active:false } : {})
    });
    await User.findByIdAndUpdate(user._id, { $inc:{ balance:gc.amount } });
    await Transaction.create({
      receiver_id: user._id,
      amount: gc.amount,
      type: 'transfer',
      status: 'success',
      remark: `Gift Code: ${gc.code}${gc.remark ? ' | ' + gc.remark : ''}`,
      tx_time: new Date()
    });

    if (user.tg_id) sendTG(user.tg_id,
      `🎁 <b>Gift Code Redeemed!</b>\n\n` +
      `Code: <code>${gc.code}</code>\n` +
      `Amount: ₹${gc.amount}\n` +
      (gc.remark ? `📝 Remark: ${gc.remark}\n` : '') +
      `\n✅ Balance add ho gaya!\n\n👑 ROYAL WALLET`
    );

    res.json({
      status: 'success',
      amount: gc.amount,
      remark: gc.remark || '',
      message: `₹${gc.amount} added!`
    });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// ── My Gift Codes ─────────────────────────────────────────────────
router.get('/my-codes', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ status:'error', message:'No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const codes = await GiftCode.find({ created_by: decoded.id }).sort({ createdAt:-1 }).lean();
    res.json({ status:'success', codes });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

module.exports = router;
    
