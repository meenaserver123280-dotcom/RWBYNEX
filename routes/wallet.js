const router      = require('express').Router();
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth }    = require('./auth');

const BOT_TOKEN = process.env.BOT_TOKEN  || '';
const ADMIN_TG  = process.env.ADMIN_TG_ID || '';
const UPI_ID    = process.env.UPI_ID     || 'royalwallet@upi';

const getIST = () => new Date().toLocaleString('en-IN', {
  timeZone:'Asia/Kolkata', day:'2-digit', month:'short',
  year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true
});

async function sendTG(tg_id, text) {
  if (!tg_id||!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:tg_id, text, parse_mode:'HTML' })
    });
  } catch(e) {}
}

// Balance
router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('balance name wallet_id mobile');
    res.json({ status:'success', balance:user.balance, name:user.name, wallet_id:user.wallet_id, mobile:user.mobile });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Transactions
router.get('/transactions', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const txns = await Transaction.find({ $or:[{ sender_id:user._id },{ receiver_id:user._id }] })
      .sort({ tx_time:-1 }).limit(50)
      .populate('sender_id','name mobile')
      .populate('receiver_id','name mobile').lean();
    res.json({ status:'success', transactions:txns });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Deposit info
router.get('/deposit-info', auth, async (req, res) => {
  res.json({ status:'success', upi_id:UPI_ID });
});

// Deposit submit (UTR)
router.post('/deposit', auth, async (req, res) => {
  try {
    const { amount, utr } = req.body;
    const amt = parseFloat(amount);
    if (!utr||isNaN(amt)||amt<1) return res.status(400).json({ status:'error', message:'Amount and UTR required' });
    const user = await User.findById(req.user.id);
    const dup  = await Transaction.findOne({ remark:`UTR:${utr}` });
    if (dup) return res.status(400).json({ status:'error', message:'Yeh UTR already use ho chuka hai!' });
    const txId = 'RWD' + Date.now().toString().slice(-8);
    await Transaction.create({ tx_id:txId, receiver_id:user._id, amount:amt, type:'deposit', status:'pending', remark:`UTR:${utr}`, tx_time:new Date() });
    if (user.tg_id) sendTG(user.tg_id, `⏳ <b>Deposit Request!</b>\n\nAmount: ₹${amt}\nUTR: <code>${utr}</code>\nTxn: <code>${txId}</code>\nTime: ${getIST()}\n\nAdmin 48h mein verify karega.\n\n👑 ROYAL WALLET`);
    if (ADMIN_TG) sendTG(ADMIN_TG, `💰 <b>New Deposit!</b>\n\nUser: ${user.name} (${user.mobile})\nAmount: ₹${amt}\nUTR: <code>${utr}</code>\nTxn: <code>${txId}</code>\nTime: ${getIST()}\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', tx_id:txId, message:'Deposit request submitted!' });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Withdraw
router.post('/withdraw', auth, async (req, res) => {
  try {
    const { upi, amount } = req.body;
    const amt = parseFloat(amount);
    if (!upi||isNaN(amt)||amt<10) return res.status(400).json({ status:'error', message:'Minimum ₹10' });
    const user = await User.findById(req.user.id);
    if (user.balance < amt) return res.status(400).json({ status:'error', message:`Insufficient. Available: ₹${user.balance}` });
    const txId = 'RWW' + Date.now().toString().slice(-8);
    await User.findByIdAndUpdate(user._id, { $inc:{ balance:-amt } });
    await Transaction.create({ tx_id:txId, sender_id:user._id, amount:amt, type:'withdraw', status:'pending', remark:`Withdraw to ${upi}`, tx_time:new Date() });
    if (user.tg_id) sendTG(user.tg_id, `⏳ <b>Withdrawal Request!</b>\n\nAmount: ₹${amt}\nUPI: ${upi}\nTxn: <code>${txId}</code>\nTime: ${getIST()}\n\n👑 ROYAL WALLET`);
    if (ADMIN_TG) sendTG(ADMIN_TG, `💸 <b>Withdrawal!</b>\n\nUser: ${user.name} (${user.mobile})\nAmount: ₹${amt}\nUPI: ${upi}\nTxn: <code>${txId}</code>\nTime: ${getIST()}\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', tx_id:txId, message:'Withdrawal request submitted!' });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

module.exports = router;
