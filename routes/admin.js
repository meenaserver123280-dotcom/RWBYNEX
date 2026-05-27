const router      = require('express').Router();
const User        = require('../models/User');
const Transaction = require('../models/Transaction');
const AdminLog    = require('../models/AdminLog');
const GiftCode    = require('../models/GiftCode');

const BOT_TOKEN  = process.env.BOT_TOKEN   || '';
const ADMIN_TG   = process.env.ADMIN_TG_ID || '';
const ADMIN_PASS = process.env.ADMIN_SECRET || '';

const getIST = () => new Date().toLocaleString('en-IN', {
  timeZone:'Asia/Kolkata', hour12:true,
  day:'2-digit', month:'short', year:'numeric',
  hour:'2-digit', minute:'2-digit'
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

async function log(action, target, detail, amount=0) {
  try { await AdminLog.create({ action, target, detail, amount, at:new Date() }); } catch(e) {}
}

function adminOnly(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'] || req.body?.key;
  if (!key || key !== ADMIN_PASS)
    return res.status(403).json({ status:'error', message:'🚫 Unauthorized' });
  next();
}

// Stats
router.get('/stats', adminOnly, async (req, res) => {
  try {
    const totalUsers  = await User.countDocuments();
    const totalTxns   = await Transaction.countDocuments();
    const balAgg      = await User.aggregate([{ $group:{ _id:null, total:{ $sum:'$balance' } } }]);
    const totalBal    = balAgg[0]?.total || 0;
    const pendingWith = await Transaction.countDocuments({ type:'withdraw', status:'pending' });
    const pendingDep  = await Transaction.countDocuments({ type:'deposit',  status:'pending' });
    const todayStart  = new Date(); todayStart.setHours(0,0,0,0);
    const todayUsers  = await User.countDocuments({ createdAt:{ $gte:todayStart } });
    const todayTxns   = await Transaction.countDocuments({ tx_time:{ $gte:todayStart } });
    res.json({ status:'success', stats:{ total_users:totalUsers, today_users:todayUsers, total_txns:totalTxns, today_txns:todayTxns, total_balance:`₹${totalBal.toFixed(2)}`, pending_withdraw:pendingWith, pending_deposit:pendingDep } });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Users
router.get('/users', adminOnly, async (req, res) => {
  try {
    const { search, page=1, limit=20 } = req.query;
    const q = search ? { $or:[{ mobile:new RegExp(search,'i') },{ name:new RegExp(search,'i') },{ wallet_id:new RegExp(search,'i') }] } : {};
    const users = await User.find(q).select('-password -pin -api_key').sort({ createdAt:-1 }).skip((page-1)*limit).limit(parseInt(limit)).lean();
    const total = await User.countDocuments(q);
    res.json({ status:'success', users, total, page:parseInt(page) });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Single User
router.get('/user/:mobile', adminOnly, async (req, res) => {
  try {
    const user = await User.findOne({ mobile:req.params.mobile }).select('-password -pin -api_key').lean();
    if (!user) return res.status(404).json({ status:'error', message:'User not found' });
    const txnCount = await Transaction.countDocuments({ $or:[{ sender_id:user._id },{ receiver_id:user._id }] });
    res.json({ status:'success', user:{ ...user, txn_count:txnCount } });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Add Balance
router.post('/add-balance', adminOnly, async (req, res) => {
  try {
    const { mobile, amount, remark } = req.body;
    const amt = parseFloat(amount);
    if (!mobile||isNaN(amt)) return res.status(400).json({ status:'error', message:'mobile and amount required' });
    const user = await User.findOneAndUpdate({ mobile }, { $inc:{ balance:amt } }, { new:true });
    if (!user) return res.status(404).json({ status:'error', message:'User not found' });
    await Transaction.create({ receiver_id:user._id, amount:amt, type:'admin_credit', status:'success', remark:remark||'Admin Credit', tx_time:new Date() });
    await log('ADD_BALANCE', mobile, remark||'Admin Credit', amt);
    if (user.tg_id) sendTG(user.tg_id, `💰 <b>Balance Added!</b>\n\nAmount: ₹${amt}\nRemark: ${remark||'—'}\nNew Balance: ₹${user.balance}\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', message:`₹${amt} added`, new_balance:user.balance });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Deduct Balance
router.post('/deduct-balance', adminOnly, async (req, res) => {
  try {
    const { mobile, amount, remark } = req.body;
    const amt = parseFloat(amount);
    const user = await User.findOne({ mobile });
    if (!user) return res.status(404).json({ status:'error', message:'User not found' });
    if (user.balance < amt) return res.status(400).json({ status:'error', message:`Insufficient: ₹${user.balance}` });
    await User.findByIdAndUpdate(user._id, { $inc:{ balance:-amt } });
    await Transaction.create({ sender_id:user._id, amount:amt, type:'admin_debit', status:'success', remark:remark||'Admin Debit', tx_time:new Date() });
    await log('DEDUCT_BALANCE', mobile, remark||'Admin Debit', amt);
    if (user.tg_id) sendTG(user.tg_id, `⚡ <b>Balance Deducted!</b>\n\nAmount: ₹${amt}\nRemark: ${remark||'—'}\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', message:`₹${amt} deducted` });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Delete Account
router.post('/delete-account', adminOnly, async (req, res) => {
  try {
    const { mobile } = req.body;
    const user = await User.findOne({ mobile });
    if (!user) return res.status(404).json({ status:'error', message:'User not found' });
    if (user.tg_id) sendTG(user.tg_id, `❌ <b>Account Deleted!</b>\n\nAapka Royal Wallet account delete kar diya gaya.\n\n👑 ROYAL WALLET`);
    await Transaction.deleteMany({ $or:[{ sender_id:user._id },{ receiver_id:user._id }] });
    await User.findByIdAndDelete(user._id);
    await log('DELETE_ACCOUNT', mobile, `Name: ${user.name}`);
    res.json({ status:'success', message:`${mobile} deleted` });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Bulk Delete
router.post('/bulk-delete', adminOnly, async (req, res) => {
  try {
    const exclude = (req.body.exclude||[]).map(m=>m.toString().trim()).filter(Boolean);
    const users   = await User.find(exclude.length ? { mobile:{ $nin:exclude } } : {}).lean();
    if (!users.length) return res.json({ status:'success', deleted:0, skipped:exclude.length });
    let deleted=0;
    for (const user of users) {
      await Transaction.deleteMany({ $or:[{ sender_id:user._id },{ receiver_id:user._id }] });
      await User.findByIdAndDelete(user._id);
      if (user.tg_id) sendTG(user.tg_id, `❌ <b>Account Deleted!</b>\n\nAapka Royal Wallet account delete kar diya gaya.\n\n👑 ROYAL WALLET`);
      deleted++;
    }
    await log('BULK_DELETE', 'ALL', `Excluded: ${exclude.join(',')||'none'}`, deleted);
    if (ADMIN_TG) sendTG(ADMIN_TG, `🗑️ <b>Bulk Delete!</b>\n\nDeleted: ${deleted}\nSkipped: ${exclude.length}\nTime: ${getIST()}\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', deleted, skipped:exclude.length });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// All Transactions
router.get('/transactions', adminOnly, async (req, res) => {
  try {
    const { page=1, limit=30, type, status } = req.query;
    const q={};
    if (type)   q.type   = type;
    if (status) q.status = status;
    const txns = await Transaction.find(q).sort({ tx_time:-1 }).skip((page-1)*limit).limit(parseInt(limit)).populate('sender_id','name mobile').populate('receiver_id','name mobile').lean();
    const total = await Transaction.countDocuments(q);
    res.json({ status:'success', transactions:txns, total, page:parseInt(page) });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Withdrawals
router.get('/withdrawals', adminOnly, async (req, res) => {
  try {
    const { status='pending' } = req.query;
    const txns = await Transaction.find({ type:'withdraw', status }).sort({ tx_time:-1 }).populate('sender_id','name mobile tg_id').lean();
    res.json({ status:'success', withdrawals:txns, total:txns.length });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Approve Withdraw
router.post('/approve-withdraw', adminOnly, async (req, res) => {
  try {
    const { tx_id } = req.body;
    const txn = await Transaction.findOneAndUpdate({ tx_id, type:'withdraw' }, { status:'success' }, { new:true }).populate('sender_id','name mobile tg_id');
    if (!txn) return res.status(404).json({ status:'error', message:'Txn not found' });
    await log('APPROVE_WITHDRAW', txn.sender_id?.mobile, `TxnID: ${tx_id}`, txn.amount);
    if (txn.sender_id?.tg_id) sendTG(txn.sender_id.tg_id, `✅ <b>Withdrawal Approved!</b>\n\nAmount: ₹${txn.amount}\nTxn: <code>${tx_id}</code>\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', message:'Approved' });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Reject Withdraw
router.post('/reject-withdraw', adminOnly, async (req, res) => {
  try {
    const { tx_id, reason } = req.body;
    const txn = await Transaction.findOne({ tx_id, type:'withdraw' }).populate('sender_id','name mobile tg_id');
    if (!txn) return res.status(404).json({ status:'error', message:'Txn not found' });
    await Transaction.findByIdAndUpdate(txn._id, { status:'rejected' });
    await User.findByIdAndUpdate(txn.sender_id._id, { $inc:{ balance:txn.amount } });
    await log('REJECT_WITHDRAW', txn.sender_id?.mobile, `TxnID: ${tx_id} | ${reason||'—'}`, txn.amount);
    if (txn.sender_id?.tg_id) sendTG(txn.sender_id.tg_id, `❌ <b>Withdrawal Rejected!</b>\n\nAmount: ₹${txn.amount} refunded\nReason: ${reason||'—'}\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', message:'Rejected & refunded' });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Deposits
router.get('/deposits', adminOnly, async (req, res) => {
  try {
    const { status='pending' } = req.query;
    const deps = await Transaction.find({ type:'deposit', status }).sort({ tx_time:-1 }).populate('receiver_id','name mobile tg_id').lean();
    res.json({ status:'success', deposits:deps, total:deps.length });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Approve Deposit
router.post('/approve-deposit', adminOnly, async (req, res) => {
  try {
    const { tx_id } = req.body;
    const dep = await Transaction.findOne({ tx_id, type:'deposit' }).populate('receiver_id','name mobile tg_id');
    if (!dep) return res.status(404).json({ status:'error', message:'Deposit not found' });
    if (dep.status !== 'pending') return res.status(400).json({ status:'error', message:'Already processed' });
    await Transaction.findByIdAndUpdate(dep._id, { status:'success' });
    await User.findByIdAndUpdate(dep.receiver_id._id, { $inc:{ balance:dep.amount } });
    await log('APPROVE_DEPOSIT', dep.receiver_id?.mobile, `TxnID: ${tx_id}`, dep.amount);
    if (dep.receiver_id?.tg_id) sendTG(dep.receiver_id.tg_id, `✅ <b>Deposit Approved!</b>\n\nAmount: ₹${dep.amount}\nTxn: <code>${tx_id}</code>\nTime: ${getIST()}\n\nBalance add ho gaya! 🎉\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', message:'Deposit approved', amount:dep.amount });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Reject Deposit
router.post('/reject-deposit', adminOnly, async (req, res) => {
  try {
    const { tx_id, reason } = req.body;
    const dep = await Transaction.findOne({ tx_id, type:'deposit' }).populate('receiver_id','name mobile tg_id');
    if (!dep) return res.status(404).json({ status:'error', message:'Deposit not found' });
    await Transaction.findByIdAndUpdate(dep._id, { status:'rejected' });
    await log('REJECT_DEPOSIT', dep.receiver_id?.mobile, `TxnID: ${tx_id} | ${reason||'—'}`, dep.amount);
    if (dep.receiver_id?.tg_id) sendTG(dep.receiver_id.tg_id, `❌ <b>Deposit Rejected!</b>\n\nAmount: ₹${dep.amount}\nReason: ${reason||'Invalid UTR'}\n\n👑 ROYAL WALLET`);
    res.json({ status:'success', message:'Deposit rejected' });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Broadcast
router.post('/broadcast', adminOnly, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ status:'error', message:'Message required' });
    const users = await User.find({ tg_id:{ $exists:true, $ne:'' } }).select('tg_id').lean();
    let sent=0, failed=0;
    const finalMsg = message + '\n\n— BROADCAST BY ROYAL WALLET 👑';
    for (const u of users) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ chat_id:u.tg_id, text:finalMsg, parse_mode:'HTML' })
        });
        sent++;
      } catch(e) { failed++; }
      await new Promise(r => setTimeout(r, 50));
    }
    await log('BROADCAST', 'ALL', message.slice(0,100));
    res.json({ status:'success', sent, failed, total:users.length });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Create Gift Code
router.post('/create-gift', adminOnly, async (req, res) => {
  try {
    const { code, amount, max_uses, expires_hours } = req.body;
    if (!code||!amount) return res.status(400).json({ status:'error', message:'code and amount required' });
    if (await GiftCode.findOne({ code:code.toUpperCase() })) return res.status(400).json({ status:'error', message:'Code exists' });
    const expires_at = expires_hours ? new Date(Date.now()+parseInt(expires_hours)*3600000) : null;
    const gc = await GiftCode.create({ code:code.toUpperCase(), amount:parseFloat(amount), max_uses:parseInt(max_uses)||1, expires_at });
    await log('CREATE_GIFT', gc.code, `₹${gc.amount} | Uses: ${gc.max_uses}`);
    res.json({ status:'success', code:gc.code, amount:gc.amount, max_uses:gc.max_uses });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// Logs
router.get('/logs', adminOnly, async (req, res) => {
  try {
    const { page=1, limit=50 } = req.query;
    const logs  = await AdminLog.find().sort({ at:-1 }).skip((page-1)*limit).limit(parseInt(limit)).lean();
    const total = await AdminLog.countDocuments();
    res.json({ status:'success', logs, total, page:parseInt(page) });
  } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

module.exports = router;
