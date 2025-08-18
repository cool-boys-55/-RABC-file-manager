// scripts/migration.js
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db.js'); // Adjust path based on your structure

async function migrateApprovalStatus() {
  try {
    // Connect using your existing logic
    await connectDB();
    
    console.log('🚀 Starting migration...');
    
    // Get native MongoDB driver connection
    const db = mongoose.connection.client.db();
    
    // 1. Rename 'status' to 'approvalStatus'
    const filesCollection = db.collection('files');
    const filesToUpdate = await filesCollection.find({
      status: { $exists: true },
      approvalStatus: { $exists: false }
    }).toArray();
    
    console.log(`🔍 Found ${filesToUpdate.length} files to update`);
    
    if (filesToUpdate.length > 0) {
      const bulkOps = filesToUpdate.map(file => ({
        updateOne: {
          filter: { _id: file._id },
          update: {
            $set: { approvalStatus: file.status },
            $unset: { status: "" }
          }
        }
      }));
      
      await filesCollection.bulkWrite(bulkOps);
      console.log(`✅ Updated ${filesToUpdate.length} files`);
    }
    
    // 2. Auto-approve admin/sub-admin files
    const usersCollection = db.collection('users');
    const adminUsers = await usersCollection.find({
      role: { $in: ['admin', 'sub-admin'] }
    }).toArray();
    
    if (adminUsers.length > 0) {
      const adminUserIds = adminUsers.map(u => u._id);
      const now = new Date();
      
      const result = await filesCollection.updateMany(
        {
          uploadedBy: { $in: adminUserIds },
          approvalStatus: 'pending'
        },
        {
          $set: {
            approvalStatus: 'approved',
            approvedAt: now
          }
        }
      );
      
      console.log(`✨ Auto-approved ${result.modifiedCount} admin files`);
    }
    
    console.log('🎉 Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database');
  }
}

// Run the migration
migrateApprovalStatus();