const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const storage = require('../utils/storage');

// ------------------
// Schema definition
// ------------------
const fileSchema = new mongoose.Schema({
  // Core file properties
  filename: {
    type: String,
    required: [true, 'Filename is required'],
    trim: true,
    validate: {
      validator: function (v) {
        return /^[\w\-. ()]+$/.test(v);
      },
      message: props => `${props.value} contains invalid characters`
    }
  },
  originalFilename: {
    type: String,
    required: true
  },
  path: {
    type: String,
    required: [true, 'Path is required'],
    unique: true,
    index: true
  },
  size: {
    type: Number,
    required: [true, 'File size is required'],
    min: 0
  },
  mimetype: {
    type: String,
    required: [true, 'MIME type is required']
  },
  extension: {
    type: String,
    required: true
  },

  // Ownership and organization
  folder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    required: true,
    index: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Owner is required'],
    index: true
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Approval system
  approvalStatus: {
    type: String,
    enum: ['pending', 'approved', 'disapproved'],
    default: 'pending',
    index: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: Date,
  disapprovalReason: String,
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectedAt: Date,

  // Versioning
  version: {
    type: Number,
    default: 1
  },
  isCurrentVersion: {
    type: Boolean,
    default: true
  },
  previousVersions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File'
  }],
  originalFile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File'
  },

  // File integrity
  fileHash: {
    type: String,
    required: true,
    unique: true
  },
  checksum: {
    algorithm: {
      type: String,
      default: 'sha256'
    },
    value: String
  },

  // Metadata
  metadata: {
    type: Map,
    of: String,
    default: {}
  },
  tags: {
    type: [String],
    default: [],
    index: true
  },
  description: String,

  // Security
  isEncrypted: {
    type: Boolean,
    default: false
  },
  encryptionKey: String,

  // System fields
  isSystemFile: {
    type: Boolean,
    default: false
  },
  downloadCount: {
    type: Number,
    default: 0
  },

  // Soft delete support
  isDeleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ------------------
// Virtual properties
// ------------------
fileSchema.virtual('url').get(function () {
  return `/api/files/${this._id}/download`;
});

fileSchema.virtual('thumbnailUrl').get(function () {
  return `/api/files/${this._id}/thumbnail`;
});

fileSchema.virtual('sizeFormatted').get(function () {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = this.size;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
});

// ------------------
// Indexes
// ------------------
fileSchema.index({ filename: 'text', description: 'text', tags: 'text' });
fileSchema.index({ folder: 1, filename: 1 }, { unique: true });

// ------------------
// Pre-save hook
// ------------------
fileSchema.pre('save', async function (next) {
  try {
    // Set extension if new or filename changed
    if (this.isNew || this.isModified('filename')) {
      this.extension = path.extname(this.filename).toLowerCase();
    }

    // Verify folder exists if new or folder changed
    if (this.isNew || this.isModified('folder')) {
      const folder = await mongoose.model('Folder').findById(this.folder);
      if (!folder) throw new Error('Folder does not exist');

      // Create folder path if missing
      if (!await storage.pathExists(folder.path)) {
        await storage.createDirectory(folder.path);
      }

      // Set normalized path for cross-platform use
      if (this.isNew) {
        this.path = path.join(folder.path, this.filename).replace(/\\/g, '/');
      }
    }

    // Generate file hash if new or path changed
    if ((this.isNew || this.isModified('path')) &&
      await storage.pathExists(this.path)) {
      const fileBuffer = await storage.readFile(this.path);
      const hashSum = crypto.createHash('sha256');
      hashSum.update(fileBuffer);
      this.fileHash = hashSum.digest('hex');
      this.checksum = {
        algorithm: 'sha256',
        value: this.fileHash
      };
    }

    next();
  } catch (err) {
    next(err);
  }
});

// ------------------
// Pre-remove hook
// ------------------
fileSchema.pre('deleteOne', { document: true, query: false }, async function (next) {
  try {
    if (await storage.pathExists(this.path)) {
      await storage.unlink(this.path);
    }
    next();
  } catch (err) {
    next(err);
  }
});

// ------------------
// Static methods
// ------------------

// Find file by hash
fileSchema.statics.findByHash = function (hash) {
  return this.findOne({ fileHash: hash });
};

// Find all files in a folder
fileSchema.statics.findByFolder = function (folderId) {
  return this.find({ folder: folderId }).sort({ filename: 1 });
};

// Generate versioned filename
// ✅ FIXED: Generate versioned filename
fileSchema.statics.generateVersionedName = function (originalName, version, format = 'number') {
  const ext = path.extname(originalName);
  const baseName = path.basename(originalName, ext);

  if (format === 'date') {
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return `${baseName}_${dateStr}${ext}`;
  } else {
    // ✅ FIXED: Proper numbered versioning
    // Version 1 = original name, Version 2 = name(1), Version 3 = name(2), etc.
    return version === 1 ? originalName : `${baseName}(${version - 1})${ext}`;
  }
};

// Find all versions of a file
fileSchema.statics.findVersions = async function (fileId) {
  const currentFile = await this.findById(fileId);
  if (!currentFile) return null;

  const originalFileId = currentFile.originalFile || currentFile._id;

  const versions = await this.find({
    $or: [
      { _id: originalFileId },       // The original file
      { originalFile: originalFileId } // All its versions
    ]
  }).sort({ version: 1 }); // Oldest first

  return versions;
};

// ------------------
// Instance methods
// ------------------

// Increment downloads
fileSchema.methods.incrementDownloadCount = async function () {
  this.downloadCount += 1;
  return this.save();
};

// Approve file
fileSchema.methods.approve = async function (userId) {
  this.approvalStatus = 'approved';
  this.approvedBy = userId;
  this.approvedAt = new Date();
  this.disapprovalReason = undefined;
  this.rejectedBy = undefined;
  this.rejectedAt = undefined;
  return this.save();
};

// Reject file
fileSchema.methods.reject = async function (userId, reason) {
  this.approvalStatus = 'disapproved';
  this.rejectedBy = userId;
  this.disapprovalReason = reason;
  this.rejectedAt = new Date();
  this.approvedBy = undefined;
  this.approvedAt = undefined;
  return this.save();
};

module.exports = mongoose.model('File', fileSchema);
