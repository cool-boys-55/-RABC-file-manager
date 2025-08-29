require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs'); 
const config = require('./config/config');
const connectToDB = require('./config/db');
const userRoute = require('./routes/user');
const authRoute = require('./routes/auth');
const folderRoute = require('./routes/folder');
const assetRoute = require('./routes/asset');
const File = require('./models/file.model'); 
const storage = require('./utils/storage'); 

connectToDB();

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests, please try again later'
});
app.use('/api/', apiLimiter);

// General middleware
app.use(cors({
  origin: "http://localhost:3000",
  credentials: true,
  methods: ['GET', 'POST', 'PUT','PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization',]
}));
app.use(cookieParser());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug route (before API routes)
app.get('/debug-file-path/:id', async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).send('File not found in database');
    
    const normalizedPath = file.path.replace(/\\/g, '/');
    const fullPath = storage.getFullPath(normalizedPath);

    const response = {
      dbPath: file.path,
      normalizedPath,
      storageRoot: storage.STORAGE_ROOT,
      fullPath,
      exists: fs.existsSync(fullPath)
    };
    
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Routes
app.use('/api/user', userRoute);
app.use('/api/auth', authRoute);
app.use('/api/folder', folderRoute);
app.use('/api/asset', assetRoute);

// Unified error handlerx`
app.use((err, req, res, next) => {
  console.error(`❗ [${req.method}] ${req.path}:`, err);
  
  const status = err.status || 500;
  const message = config.env === 'production' 
    ? 'Server error' 
    : err.message;
  
  res.status(status).json({
    success: false,
    error: message,
    ...(config.env !== 'production' && { stack: err.stack })
  });
});

// Start server
app.listen(config.port, () => 
  console.log(`🚀 Server running in ${config.env} mode on port ${config.port}`)
);
