const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require('os'); // Add OS module
const createError = require("http-errors");
const storageUtil = require("../utils/storage");
const Folder = require("../models/folder.model");

const ALLOWED_FILE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip"
};

// Use system temp directory instead of final destination
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir()); // Save to system temp directory
  },

  filename: (req, file, cb) => {
    const ext = ALLOWED_FILE_TYPES[file.mimetype];
    if (!ext) return cb(createError(400, "Invalid file type"));

    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const isValid = !!ALLOWED_FILE_TYPES[file.mimetype];

  if (!isValid) {
    console.warn(`Rejected file type: ${file.mimetype}`); // Debugging
    return cb(createError(400, "Unsupported file type"), false);
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { 
    fileSize: process.env.MAX_FILE_SIZE || 5 * 1024 * 1024 // 5MB default
  }
});

module.exports = { upload };