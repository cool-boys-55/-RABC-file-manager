// scripts/migrateFilesToFolders.js
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const File = require('../models/file.model');
const Folder = require('../models/folder.model');

const mkdir = promisify(fs.mkdir);
const rename = promisify(fs.rename);

async function migrateFiles() {
  try {
    await mongoose.connect('your-mongodb-uri', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log('Connected to MongoDB');
    
    const files = await File.find({ folder: { $ne: null } });
    const baseDir = path.join(__dirname, '../uploads');
    
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        const folder = await Folder.findById(file.folder);
        if (!folder) {
          console.log(`Skipping - Folder not found for file ${file.filename}`);
          skipCount++;
          continue;
        }

        const oldPath = file.path;
        const newFolderPath = path.join(baseDir, file.folder.toString());
        const newPath = path.join(newFolderPath, path.basename(oldPath));

        // Skip if already in correct location
        if (oldPath === newPath) {
          skipCount++;
          continue;
        }

        // Create folder if needed
        if (!fs.existsSync(newFolderPath)) {
          await mkdir(newFolderPath, { recursive: true });
        }

        // Move file
        await rename(oldPath, newPath);

        // Update path in database
        file.path = newPath;
        await file.save();

        successCount++;
        console.log(`Moved ${file.filename} to folder ${file.folder}`);
      } catch (err) {
        errorCount++;
        console.error(`Error moving file ${file.filename}:`, err);
      }
    }

    console.log(`
      Migration complete:
      - Successfully moved: ${successCount}
      - Skipped: ${skipCount}
      - Errors: ${errorCount}
    `);
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

migrateFiles();