const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const path     = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB connection with caching for Vercel serverless ──
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
    });
    isConnected = true;
    console.log('MongoDB connected');
  } catch(e) {
    console.error('DB error:', e.message);
    throw e;
  }
}

// Middleware — har request se pehle DB connect karo
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch(e) {
    res.status(500).json({ status: 'error', message: 'Database connection failed' });
  }
});

const { router: authRouter } = require('./routes/auth');
app.use('/auth',     authRouter);
app.use('/transfer', require('./routes/transfer'));
app.use('/wallet',   require('./routes/wallet'));
app.use('/payment',  require('./routes/payment'));
app.use('/gift',     require('./routes/giftcode'));
app.use('/admin',    require('./routes/admin'));

app.get('/health', (req, res) => res.json({ status:'ok', time:new Date().toISOString() }));

module.exports = app;
