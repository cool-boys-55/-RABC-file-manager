const mongoose = require('mongoose');
const storage = require('../utils/storage');

const folderSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: function(v) {
        return /^[\w\-]+$/.test(v);
      },
      message: props => `${props.value} contains invalid characters`
    }
  },
  path: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  parentFolder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Folder',
    default: null
  },
  isSystemFolder: {
    type: Boolean,
    default: false,
    immutable: true
  },
  depth: {
    type: Number,
    default: 0,
    min: 0
  },
  access: {
    type: [{
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },
      permission: {
        type: String,
        enum: ['read', 'write', 'admin'],
        required: true
      },
      grantedAt: {
        type: Date,
        default: Date.now
      }
    }],
    default: []
  },
  metadata: {
    type: Map,
    of: String,
    default: {}
  }
});

// Pre-save hooks
folderSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
  // Normalize path
  if (this.isModified('path')) {
    this.path = this.path.replace(/\\/g, '/');
  }
  
  next();
});

folderSchema.pre('save', async function(next) {
  try {
    if (this.isNew) {
      // For new folders, compute path based on parent
      if (this.parentFolder) {
        const parent = await this.constructor.findById(this.parentFolder)
          .select('path depth')
          .lean();
        
        if (parent) {
          this.depth = parent.depth + 1;
          this.path = `${parent.path}/${this.name}`;
        } else {
          this.depth = 0;
          this.path = this.name;
        }
      } else {
        this.depth = 0;
        this.path = this.name;
      }
      
      // Normalize path
      this.path = this.path.replace(/\\/g, '/');
      
      // Create storage directory
      await storage.createDirectory(this.path);
    } 
    else if (this.isModified('name') || this.isModified('parentFolder')) {
      // Handle folder rename or move
      const original = await this.constructor.findById(this._id)
        .select('path parentFolder name')
        .lean();
      
      // Compute new path
      let newPath;
      if (this.parentFolder && this.parentFolder.toString() !== original.parentFolder?.toString()) {
        const parent = await this.constructor.findById(this.parentFolder)
          .select('path')
          .lean();
        
        newPath = parent ? `${parent.path}/${this.name}` : this.name;
      } else {
        const parentPath = original.path.substring(0, original.path.lastIndexOf('/'));
        newPath = `${parentPath}/${this.name}`;
      }
      
      // Normalize path
      newPath = newPath.replace(/\\/g, '/');
      
      // Move storage directory
      await storage.moveDirectory(original.path, newPath);
      
      // Update path and children
      this.path = newPath;
      await updateChildPaths(this._id, original.path, newPath);
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Pre-remove hook
folderSchema.pre('deleteOne', { document: true, query: false }, async function(next) {
  try {
    // Delete physical directory
    await storage.deleteDirectory(this.path);
    
    // Remove references in child folders
    await this.model('Folder').updateMany(
      { parentFolder: this._id },
      { $set: { parentFolder: null } }
    );
    
    next();
  } catch (err) {
    next(err);
  }
});

// Helper function to update child paths recursively
async function updateChildPaths(parentId, oldBasePath, newBasePath) {
  const children = await mongoose.model('Folder').find({ parentFolder: parentId });
  
  for (const child of children) {
    const childOldPath = child.path;
    child.path = child.path.replace(oldBasePath, newBasePath);
    await child.save();
    
    // Recursively update grandchildren
    await updateChildPaths(child._id, childOldPath, child.path);
  }
}

// Indexes
folderSchema.index({ path: 1 });
folderSchema.index({ parentFolder: 1 });
folderSchema.index({ createdBy: 1 });

// Virtuals
folderSchema.virtual('effectiveAccess').get(function() {
  return this.access;
});

// Static methods
folderSchema.statics.validatePath = function(path) {
  return /^[\w\-/]+$/.test(path);
};

// Query helpers
folderSchema.query.byPath = function(path) {
  return this.where({ path });
};

module.exports = mongoose.model('Folder', folderSchema);