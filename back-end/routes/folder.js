const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Folder = require("../models/folder.model");
const File = require("../models/file.model");
const User = require("../models/user.model");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs"); // classic fs for streams and sync checks
const fsp = require("fs").promises; // promise-based fs functions
const crypto = require("crypto");
const { check, validationResult } = require("express-validator");
const { upload } = require("../utils/multer");
const storage = require("../utils/storage");

// Helper: Validate access
const validateFolderAccess = async (folderId, userId) => {
  const folder = await Folder.findOne({
    _id: folderId,
    $or: [{ createdBy: userId }, { "access.user": userId }, { isPublic: true }],
  }).populate("access.user", "email name _id");

  return folder;
};

// ✅ Helper to update child paths recursively
async function updateChildPaths(parentId, newParentPath) {
  const children = await Folder.find({ parentFolder: parentId });
  for (const child of children) {
    const newPath = path.join(newParentPath, child.name).replace(/\\/g, "/");
    await Folder.findByIdAndUpdate(child._id, { path: newPath });
    await updateChildPaths(child._id, newPath);
  }
}

// ✅ Create Folder
router.post(
  "/",
  auth(["admin"]),
  [
    check("name")
      .trim()
      .notEmpty()
      .withMessage("Folder name is required")
      .matches(/^[\w\s\-().]+$/)
      .withMessage("Invalid characters in folder name"),
    check("parentFolder")
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null) return true;
        return mongoose.Types.ObjectId.isValid(value);
      })
      .withMessage("Invalid parent folder ID"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, parentFolder } = req.body;

      let folderPath;
      if (parentFolder) {
        const parent = await Folder.findById(parentFolder);
        if (!parent)
          return res
            .status(404)
            .json({ success: false, error: "Parent folder not found" });
        folderPath = path.join(parent.path, name).replace(/\\/g, "/");
      } else {
        folderPath = path.join("/", name).replace(/\\/g, "/");
      }

      const existing = await Folder.findOne({ path: folderPath });
      if (existing)
        return res
          .status(409)
          .json({ success: false, error: "Folder path already exists" });

      const folder = new Folder({
        name,
        path: folderPath,
        parentFolder: parentFolder || null,
        createdBy: req.user._id,
      });

      await folder.save();
      res.status(201).json({ success: true, data: folder });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ✅ List Folders (with parent filtering + access control)
router.get("/", auth(["admin", "sub-admin", "user"]), async (req, res) => {
  try {
    let baseQuery = {};

    if (req.query.parent) {
      baseQuery.parentFolder =
        req.query.parent === "null" ? null : req.query.parent;
    }

    if (req.user.role !== "admin") {
      baseQuery = {
        $and: [
          baseQuery,
          {
            $or: [
              { createdBy: req.user._id },
              { "access.user": req.user._id },
              { isSystemFolder: true },
            ],
          },
        ],
      };
    }

    const folders = await Folder.find(baseQuery)
      .select("-__v")
      .populate("createdBy", "name email")
      .populate("access.user", "name email");

    res.json({ success: true, count: folders.length, data: folders });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: "Failed to retrieve folders" });
  }
});

// ✅ Get Folder by ID + files + child folders (Updated with Approval System)
// ✅ FIXED: Get Folder by ID + files + child folders
router.get("/:id", auth(["admin", "sub-admin", "user"]), async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("access.user", "name email");

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: "Folder not found",
      });
    }

    // Check basic folder access
    const hasAccess = await validateFolderAccess(req.params.id, req.user._id);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
      });
    }

    // ✅ FIXED: Build file query based on user role with correct logic
    let fileQuery = {
      folder: folder._id,
      isDeleted: { $ne: true },
    };

    // Different visibility rules based on user role
    if (req.user.role === "admin") {
      // Admin: See all files except deleted ones
      // No additional filters needed
    } else if (req.user.role === "sub-admin") {
      // Sub-admin: See all files except deleted ones
      // No additional filters needed
    } else if (req.user.role === "user") {
      // Regular users: See approved files + their own uploads (any status except deleted)
      fileQuery = {
        ...fileQuery,
        $or: [
          { approvalStatus: "approved" },
          {
            $and: [
              { uploadedBy: req.user._id },
              { approvalStatus: { $in: ["pending", "approved", "disapproved"] } },
            ],
          },
        ],
      };
    }

    const files = await File.find(fileQuery)
      .select("-__v")
      .populate("uploadedBy", "name email username")
      .populate("approvedBy", "name email username")
      .populate("rejectedBy", "name email username")
      .sort({ createdAt: -1 }); // Newest first

    const childFolders = await Folder.find({
      parentFolder: folder._id,
      isDeleted: { $ne: true },
    })
      .select("-__v")
      .populate("createdBy", "name email");

    res.json({
      success: true,
      data: {
        folder,
        files,
        childFolders,
        fileCount: files.length,
        // Add permission flags for frontend
        permissions: {
          canUpload:
            req.user.role === "admin" ||
            req.user.role === "sub-admin" ||
            hasAccess.access?.some((a) => a.permission === "write"),
          canApprove:
            req.user.role === "admin" || req.user.role === "sub-admin",
        },
      },
    });
  } catch (error) {
    console.error("Folder fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve folder",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});
// ✅ Update Folder (with parentFolder support)
router.put("/:id", auth(["admin", "sub-admin", "user"]), async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder)
      return res
        .status(404)
        .json({ success: false, error: "Folder not found" });

    if (req.user.role !== "admin" && !folder.createdBy.equals(req.user._id)) {
      return res.status(403).json({ success: false, error: "Not authorized" });
    }

    const updates = {};
    if (req.body.name) updates.name = req.body.name;
    if (req.body.metadata) updates.metadata = req.body.metadata;

    // Handle parentFolder change
    if (req.body.parentFolder !== undefined) {
      if (req.body.parentFolder === null) {
        // Move to root
        updates.parentFolder = null;
        updates.path = `/${req.body.name || folder.name}`;
      } else {
        const newParent = await Folder.findById(req.body.parentFolder);
        if (!newParent) {
          return res
            .status(404)
            .json({ success: false, error: "Parent folder not found" });
        }

        // Prevent moving into itself or children
        if (newParent.path.includes(folder.path)) {
          return res.status(400).json({
            success: false,
            error: "Cannot move folder into itself or its children",
          });
        }

        updates.parentFolder = newParent._id;
        updates.path = path
          .join(newParent.path, req.body.name || folder.name)
          .replace(/\\/g, "/");
      }
    } else if (req.body.name) {
      // If only name is changed, update path accordingly
      const parentPath = folder.parentFolder
        ? (await Folder.findById(folder.parentFolder)).path
        : "/";
      updates.path = path.join(parentPath, req.body.name).replace(/\\/g, "/");
    }

    const updated = await Folder.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    // Update child paths if path changed
    if (updates.path) {
      await updateChildPaths(folder._id, updates.path);
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: "Update failed" });
  }
});

// ✅ Grant Access
router.post(
  "/:id/access",
  auth(["admin"]),
  [
    check("email").isEmail().normalizeEmail(),
    check("permission").isIn(["read", "write", "admin"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });

      const { email, permission } = req.body;
      const user = await User.findOne({ email });
      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });

      const folder = await Folder.findById(req.params.id);
      if (!folder)
        return res
          .status(404)
          .json({ success: false, error: "Folder not found" });

      const access = folder.access.find(
        (a) => a.user.toString() === user._id.toString()
      );

      if (access) {
        access.permission = permission;
        access.grantedAt = new Date();
      } else {
        folder.access.push({
          user: user._id,
          permission,
          grantedAt: new Date(),
        });
      }

      await folder.save();
      res.json({ success: true, data: folder });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: "Failed to update access" });
    }
  }
);

// ✅ Remove Access
router.delete("/:id/access", auth(["admin"]), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }

    const folder = await Folder.findByIdAndUpdate(
      req.params.id,
      { $pull: { access: { user: userId } } },
      { new: true }
    );

    if (!folder)
      return res
        .status(404)
        .json({ success: false, error: "Folder not found" });

    res.json({ success: true, data: folder });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to remove access" });
  }
});

// ✅ Delete Folder
router.delete("/:id", auth(["admin"]), async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder)
      return res
        .status(404)
        .json({ success: false, error: "Folder not found" });

    if (folder.isSystemFolder) {
      return res
        .status(403)
        .json({ success: false, error: "System folder cannot be deleted" });
    }

    await Folder.deleteOne({ _id: folder._id });
    await File.deleteMany({ folder: folder._id });

    res.json({ success: true, message: "Folder and contents deleted" });
  } catch (error) {
    res.status(500).json({ success: false, error: "Delete failed" });
  }
});

// Add these routes to your routes/folder.js file
// Place them BEFORE your existing /:id/files route

// Get all pending files for approval
router.get('/files/pending', auth(['admin', 'sub-admin']), async (req, res) => {
  try {
    const files = await File.find({ 
      approvalStatus: 'pending' 
    })
    .populate('uploadedBy', 'name username email')
    .populate('folder', 'name path')
    .populate('owner', 'name username')
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: files,
      count: files.length
    });
  } catch (error) {
    console.error('Error fetching pending files:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch pending files',
      message: error.message 
    });
  }
});

// Get files by status (approved, disapproved, all)
router.get('/files/all-status', auth(['admin', 'sub-admin']), async (req, res) => {
  try {
    const { status } = req.query;
    let query = {};

    // Build query based on status
    if (status && status !== 'all') {
      if (['pending', 'approved', 'disapproved'].includes(status)) {
        query.approvalStatus = status;
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid status. Must be: pending, approved, disapproved, or all'
        });
      }
    }

    const files = await File.find(query)
      .populate('uploadedBy', 'name username email')
      .populate('folder', 'name path')
      .populate('owner', 'name username')
      .populate('approvedBy', 'name username')
      .populate('rejectedBy', 'name username')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: files,
      count: files.length
    });
  } catch (error) {
    console.error('Error fetching files by status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch files',
      message: error.message 
    });
  }
});

// File approval/disapproval route
router.patch('/files/:fileId/approval', auth(['admin', 'sub-admin']), async (req, res) => {
  try {
    const { fileId } = req.params;
    const { status, reason } = req.body;

    // Validate fileId
    if (!mongoose.Types.ObjectId.isValid(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    // Validate status
    if (!['approved', 'disapproved'].includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status. Must be "approved" or "disapproved"' 
      });
    }

    // If disapproving, reason is required
    if (status === 'disapproved' && !reason?.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Reason is required when disapproving a file' 
      });
    }

    // Check if file exists
    const existingFile = await File.findById(fileId);
    if (!existingFile) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found' 
      });
    }

    // Prepare update data
    const updateData = {
      approvalStatus: status
    };

    if (status === 'approved') {
      updateData.approvedBy = req.user._id;
      updateData.approvedAt = new Date();
      // Clear disapproval fields if re-approving
      updateData.rejectedBy = undefined;
      updateData.rejectedAt = undefined;
      updateData.disapprovalReason = undefined;
    } else if (status === 'disapproved') {
      updateData.rejectedBy = req.user._id;
      updateData.rejectedAt = new Date();
      updateData.disapprovalReason = reason.trim();
      // Clear approval fields if disapproving
      updateData.approvedBy = undefined;
      updateData.approvedAt = undefined;
    }

    const updatedFile = await File.findByIdAndUpdate(
      fileId,
      updateData,
      { new: true }
    )
    .populate('uploadedBy', 'name username email')
    .populate('folder', 'name path')
    .populate('owner', 'name username')
    .populate('approvedBy', 'name username')
    .populate('rejectedBy', 'name username');

    res.status(200).json({
      success: true,
      message: `File ${status} successfully`,
      data: updatedFile
    });
  } catch (error) {
    console.error('Error updating file approval status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update file approval status',
      message: error.message 
    });
  }
});

// Get single file details (useful for the file view page)
router.get('/files/:fileId', auth(['admin', 'sub-admin', 'user']), async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(fileId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid file ID' 
      });
    }

    const file = await File.findById(fileId)
      .populate('uploadedBy', 'name username email')
      .populate('folder', 'name path')
      .populate('owner', 'name username')
      .populate('approvedBy', 'name username')
      .populate('rejectedBy', 'name username');

    if (!file) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found' 
      });
    }

    // Check if user can view this file
    const canView = 
      req.user.role === 'admin' || 
      req.user.role === 'sub-admin' ||
      file.uploadedBy._id.equals(req.user._id) ||
      file.owner._id.equals(req.user._id) ||
      file.approvalStatus === 'approved'; // Anyone can view approved files

    if (!canView) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to view this file'
      });
    }

    res.status(200).json({
      success: true,
      data: file
    });
  } catch (error) {
    console.error('Error fetching file:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch file',
      message: error.message 
    });
  }
});

// ✅ FIXED: Upload files route with correct approval logic
// ✅ FIXED: Upload files route with correct versioning logic
router.post(
  "/:id/files",
  auth(["admin", "sub-admin", "user"]),
  upload.array("files"),
  async (req, res) => {
    try {
      const uploadedFiles = req.files;
      if (!uploadedFiles || uploadedFiles.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: "No files uploaded" });
      }

      const folder = await Folder.findById(req.params.id);
      if (!folder) {
        return res
          .status(404)
          .json({ success: false, error: "Folder not found" });
      }

      // ✅ Check access
      const hasAccess =
        req.user.role === "admin" ||
        folder.createdBy.equals(req.user._id) ||
        folder.access.some(
          (a) =>
            a.user.equals(req.user._id) &&
            ["write", "admin"].includes(a.permission)
        );

      if (!hasAccess) {
        return res
          .status(403)
          .json({ success: false, error: "Write access required" });
      }

      // ✅ Approval setup
      const isAutoApproved =
        req.user.role === "admin" || req.user.role === "sub-admin";
      const approvalStatus = isAutoApproved ? "approved" : "pending";

      const savedFiles = [];

      for (const file of uploadedFiles) {
        const originalName = file.originalname;
        const dirPath = path.join(storage.STORAGE_ROOT, folder.path);

        if (!fs.existsSync(dirPath)) {
          await fsp.mkdir(dirPath, { recursive: true });
        }

        // ✅ FIXED: Better versioning logic
        // First, find all files with the same originalFilename in this folder
        const existingVersions = await File.find({
          folder: folder._id,
          originalFilename: originalName,
          isDeleted: { $ne: true },
        }).sort({ version: -1 });

        // Calculate the next version number
        const nextVersion = existingVersions.length > 0 
          ? existingVersions[0].version + 1 
          : 1;

        // ✅ Generate versioned filename
        const versionedName = File.generateVersionedName(
          originalName,
          nextVersion,
          req.body.versionFormat || "number"
        );

        // ✅ Check if a file with this exact filename already exists in the folder
        const existingFileWithName = await File.findOne({
          folder: folder._id,
          filename: versionedName,
          isDeleted: { $ne: true }
        });

        if (existingFileWithName) {
          // If filename collision occurs, find the next available number
          let counter = nextVersion;
          let availableName = versionedName;
          
          while (await File.findOne({ 
            folder: folder._id, 
            filename: availableName, 
            isDeleted: { $ne: true } 
          })) {
            counter++;
            availableName = File.generateVersionedName(originalName, counter, "number");
          }
          
          versionedName = availableName;
        }

        const finalPath = path.join(dirPath, versionedName).replace(/\\/g, "/");

        // ✅ Check if physical file already exists
        if (fs.existsSync(finalPath)) {
          console.warn(`Physical file already exists: ${finalPath}`);
          continue; // Skip this file
        }

        // ✅ Compute file hash for duplicate detection
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(file.path);
        await new Promise((resolve, reject) => {
          stream.on("data", (chunk) => hash.update(chunk));
          stream.on("end", resolve);
          stream.on("error", reject);
        });
        const fileHash = hash.digest("hex");

        // ✅ Check for duplicate content by hash
        const duplicateFile = await File.findOne({
          folder: folder._id,
          fileHash: fileHash,
          isDeleted: { $ne: true }
        });

        if (duplicateFile) {
          console.log(`Duplicate file detected (same content): ${originalName}`);
          // You might want to return info about the duplicate instead of saving
          savedFiles.push({
            ...duplicateFile.toObject(),
            message: "File already exists with same content",
            isDuplicate: true
          });
          continue;
        }

        // ✅ Move uploaded file to final location
        await fsp.rename(file.path, finalPath);

        // ✅ Create new file record
        const newFile = new File({
          filename: versionedName,
          originalFilename: originalName,
          path: finalPath,
          size: file.size,
          mimetype: file.mimetype,
          extension: path.extname(originalName).toLowerCase(),
          folder: folder._id,
          owner: req.user._id,
          uploadedBy: req.user._id,
          fileHash,
          approvalStatus,
          version: nextVersion,
          isCurrentVersion: true,
          ...(isAutoApproved && {
            approvedBy: req.user._id,
            approvedAt: new Date(),
          }),
          ...(existingVersions.length > 0 && {
            originalFile: existingVersions[0].originalFile || existingVersions[0]._id,
          }),
        });

        await newFile.save();

        // ✅ Update previous versions to not be current
        if (existingVersions.length > 0) {
          await File.updateMany(
            {
              originalFilename: originalName,
              folder: folder._id,
              _id: { $ne: newFile._id }, // Don't update the new file we just created
              isDeleted: { $ne: true }
            },
            { isCurrentVersion: false }
          );

          // Update the new file's previousVersions array
          newFile.previousVersions = existingVersions.map((v) => v._id);
          await newFile.save();
        }

        console.log(`File saved with versioning: ${versionedName} (version ${nextVersion})`);
        savedFiles.push(newFile);
      }

      if (savedFiles.length === 0) {
        return res.status(409).json({
          success: false,
          error: "No new files were uploaded (duplicates or conflicts detected)",
        });
      }

      res.status(201).json({
        success: true,
        count: savedFiles.length,
        data: savedFiles,
        approvalInfo: {
          autoApproved: isAutoApproved,
          status: approvalStatus,
        },
      });
    } catch (error) {
      // Cleanup leftover temp files
      if (req.files && Array.isArray(req.files)) {
        for (const file of req.files) {
          try {
            if (file?.path && fs.existsSync(file.path)) {
              await fsp.unlink(file.path);
            }
          } catch (_) {}
        }
      }

      console.error("File upload error:", error);

      res.status(500).json({
        success: false,
        error: "File upload failed",
        message: error.message || "Unknown error",
        details: error.stack || "No stack trace",
      });
    }
  }
);
// Get file info
router.get(
  "/files/:id",
  auth(["admin", "sub-admin", "user"]),
  async (req, res) => {
    try {
      const file = await File.findById(req.params.id)
        .populate("folder", "name path")
        .populate("uploadedBy", "name email username")
        .populate("owner", "name email username");

      if (!file) {
        return res
          .status(404)
          .json({ success: false, error: "File not found" });
      }

      // Check access permissions
      const hasAccess =
        req.user.role === "admin" ||
        file.owner.equals(req.user._id) ||
        (file.folder &&
          (await validateFolderAccess(file.folder._id, req.user._id)));

      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      res.json({ success: true, data: file });
    } catch (error) {
      console.error("Error fetching file:", error);
      res
        .status(500)
        .json({ success: false, error: "Failed to get file info" });
    }
  }
);

router.get("/files/:id/download", auth(), async (req, res) => {
  console.log("============================================");
  console.log(`[START] File download request for ID: ${req.params.id}`);
  console.log(`[USER] ID: ${req.user._id}, Role: ${req.user.role}`);
  console.log(`[PREVIEW] Is preview request: ${!!req.query.preview}`);
  console.log("============================================");

  let fileStream = null;
  let isRequestCompleted = false;

  // Helper function to cleanup and end response
  const cleanup = (reason) => {
    console.log(`[CLEANUP] Cleaning up due to: ${reason}`);
    if (fileStream && !fileStream.destroyed) {
      fileStream.destroy();
    }
    isRequestCompleted = true;
  };

  try {
    console.log("[DB] Fetching file from database...");
    const file = await File.findById(req.params.id).populate(
      "folder uploadedBy"
    );

    if (!file) {
      console.warn("[DB] File not found in database");
      return res.status(404).json({
        success: false,
        error: "File not found in database",
      });
    }
    console.log(`[DB] File found: ${file.originalFilename}`);

    // Permission check
    console.log("[AUTH] Checking user permissions...");
    const hasAccess =
      req.user.role === "admin" ||
      file.uploadedBy._id.equals(req.user._id) ||
      (file.folder &&
        (await validateFolderAccess(file.folder._id, req.user._id)));

    if (!hasAccess) {
      console.warn("[AUTH] Access denied for this file");
      return res.status(403).json({
        success: false,
        error: "Access denied",
      });
    }
    console.log("[AUTH] Access granted ✅");

    // File path check
    let filePath;
    if (path.isAbsolute(file.path)) {
      filePath = file.path;
    } else {
      filePath = path.join(storage.STORAGE_ROOT, file.path);
    }
    console.log(`[FS] Checking file path: ${filePath}`);

    if (!fs.existsSync(filePath)) {
      console.error("[FS] File not found on disk ❌");
      return res.status(404).json({
        success: false,
        error: "File not found on disk",
      });
    }
    console.log("[FS] File exists ✅");

    // Get file stats
    const stats = fs.statSync(filePath);

    // Set basic headers
    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Accept-Ranges", "bytes");

    // Handle preview vs download
    if (req.query.preview) {
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(file.originalFilename)}"`
      );
      console.log("[HTTP] Headers set for preview (inline)");

      // Special handling for PDFs
      if (file.mimetype === "application/pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.setHeader("X-Content-Type-Options", "nosniff");
      }
    } else {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(file.originalFilename)}"`
      );
      console.log("[HTTP] Headers set for download (attachment)");
    }

    // Set caching headers
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("ETag", file.fileHash || file._id.toString());

    // Handle range requests (for video and large files)
    const range = req.headers.range;
    if (
      range &&
      (file.mimetype?.startsWith("video/") || stats.size > 10 * 1024 * 1024)
    ) {
      console.log("[RANGE] Processing range request:", range);

      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stats.size}`);
      res.setHeader("Content-Length", chunkSize);

      console.log(`[RANGE] Serving bytes ${start}-${end}/${stats.size}`);

      fileStream = fs.createReadStream(filePath, { start, end });

      fileStream.on("error", (err) => {
        console.error("[RANGE_STREAM] Error:", err);
        cleanup("range_stream_error");
        if (!res.headersSent) {
          res
            .status(500)
            .json({ success: false, error: "Failed to stream file range" });
        }
      });

      fileStream.pipe(res);
      return;
    }

    console.log("[HTTP] Starting full file stream...");
    fileStream = fs.createReadStream(filePath);

    // Enhanced stream event handlers
    fileStream.on("open", () => {
      console.log("[STREAM] File stream opened successfully");
    });

    fileStream.on("error", (err) => {
      console.error("[STREAM] Error while streaming file:", err);
      cleanup("stream_error");
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Failed to stream file",
        });
      } else {
        res.end();
      }
    });

    fileStream.on("end", () => {
      console.log("[STREAM] File streaming completed ✅");
      isRequestCompleted = true;
    });

    fileStream.on("close", () => {
      console.log("[STREAM] File stream closed");
    });

    // Handle client disconnect
    req.on("close", () => {
      console.log("[CLIENT] Client disconnected");
      cleanup("client_disconnect");
    });

    req.on("aborted", () => {
      console.log("[CLIENT] Request aborted");
      cleanup("request_aborted");
    });

    // Handle response events
    res.on("error", (err) => {
      console.error("[RESPONSE] Response error:", err);
      cleanup("response_error");
    });

    res.on("finish", () => {
      console.log("[RESPONSE] Response finished successfully");
      isRequestCompleted = true;
    });

    res.on("close", () => {
      console.log("[RESPONSE] Response closed");
      if (!isRequestCompleted) {
        cleanup("response_closed_early");
      }
    });

    // Set timeout for preview requests
    if (req.query.preview) {
      const timeout = setTimeout(() => {
        if (!isRequestCompleted) {
          console.log("[TIMEOUT] Preview request timeout (45s)");
          cleanup("timeout");
          if (!res.headersSent) {
            res.status(408).json({
              success: false,
              error: "Request timeout",
            });
          }
        }
      }, 45000); // 45 second timeout

      res.on("finish", () => {
        clearTimeout(timeout);
      });

      res.on("close", () => {
        clearTimeout(timeout);
      });
    }

    // Start piping the file
    fileStream.pipe(res);
  } catch (error) {
    console.error("[SERVER] Unexpected error during file download:", error);
    cleanup("server_error");

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Failed to serve file",
      });
    }
  }
});

// Additional helper route for file info (if you need it)
router.get("/files/:id/info", auth(), async (req, res) => {
  try {
    const file = await File.findById(req.params.id).populate(
      "folder uploadedBy"
    );

    if (!file) {
      return res.status(404).json({
        success: false,
        error: "File not found",
      });
    }

    // Permission check
    const hasAccess =
      req.user.role === "admin" ||
      file.uploadedBy._id.equals(req.user._id) ||
      (file.folder &&
        (await validateFolderAccess(file.folder._id, req.user._id)));

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
      });
    }

    // Check if file exists on disk
    let filePath;
    if (path.isAbsolute(file.path)) {
      filePath = file.path;
    } else {
      filePath = path.join(storage.STORAGE_ROOT, file.path);
    }

    const fileExists = fs.existsSync(filePath);

    res.json({
      success: true,
      data: {
        ...file.toObject(),
        fileExists,
        canPreview: ["image/", "video/", "audio/", "application/pdf"].some(
          (type) =>
            file.mimetype?.startsWith(type) ||
            file.mimetype === "application/pdf"
        ),
      },
    });
  } catch (error) {
    console.error("[SERVER] Error fetching file info:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch file info",
    });
  }
});

router.delete(
  "/files/:id",
  auth(["admin", "sub-admin", "user"]),
  async (req, res) => {
    try {
      const file = await File.findById(req.params.id);
      if (!file) {
        return res
          .status(404)
          .json({ success: false, error: "File not found" });
      }

      // Check permissions
      const hasAccess =
        req.user.role === "admin" ||
        file.owner.equals(req.user._id) ||
        (file.folder &&
          (await validateFolderAccess(file.folder, req.user._id)));

      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      // Delete physical file
      try {
        const fullPath = path.join(storage.STORAGE_ROOT, file.path);

        // Security check
        if (
          !fullPath.startsWith(path.normalize(storage.STORAGE_ROOT + path.sep))
        ) {
          return res.status(400).json({
            success: false,
            error: "Invalid file path",
          });
        }

        try {
          await fsp.unlink(fullPath);
        } catch (err) {
          // ignore missing file
          if (err.code !== "ENOENT") throw err;
        }

        console.log(`[${new Date().toISOString()}] Deleted file:`, {
          fileId: file._id,
          path: fullPath,
          deletedBy: req.user._id,
        });
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }

      // Delete database record
      await file.deleteOne();

      res.json({ success: true, message: "File deleted successfully" });
    } catch (error) {
      console.error("Delete file error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to delete file",
        details: error.message,
      });
    }
  }
);

router.patch(
  "/files/:id/rename",
  auth(["admin", "sub-admin", "user"]),
  [
    check("newName")
      .trim()
      .notEmpty()
      .withMessage("New filename is required")
      .matches(/^[\w\s\-().]+$/)
      .withMessage("Invalid characters in filename"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const file = await File.findById(req.params.id);
      if (!file) {
        return res
          .status(404)
          .json({ success: false, error: "File not found" });
      }

      // Check permissions
      const hasAccess =
        req.user.role === "admin" ||
        file.owner.equals(req.user._id) ||
        (file.folder &&
          (await validateFolderAccess(file.folder, req.user._id)));

      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      const newName = req.body.newName;
      const folder = await Folder.findById(file.folder);
      const newPath = path.join(folder.path, newName).replace(/\\/g, "/");

      // Rename physical file (if storage supports it)
      const fullOldPath = path.join(storage.STORAGE_ROOT, file.path);
      const fullNewPath = path.join(storage.STORAGE_ROOT, newPath);

      await fsp.rename(fullOldPath, fullNewPath);

      // Update BOTH filename and originalFilename in DB
      file.filename = newName;
      file.originalFilename = newName;
      file.path = newPath;
      await file.save();

      res.json({
        success: true,
        data: file,
      });
    } catch (error) {
      console.error("Rename file error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to rename file",
        details: error.message,
      });
    }
  }
);

// Get all versions of a file
router.get('/files/:id/versions', auth(), async (req, res) => {
  try {
    const versions = await File.findVersions(req.params.id);
    
    if (!versions || versions.length === 0) {
      return res.status(404).json({
        success: false,
        error: "File not found or no versions available"
      });
    }

    // Check access to the original file
    const hasAccess = req.user.role === "admin" || 
      versions[0].owner.equals(req.user._id) ||
      (versions[0].folder && await validateFolderAccess(versions[0].folder, req.user._id));

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: "Access denied"
      });
    }

    res.json({
      success: true,
      data: versions
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to retrieve versions"
    });
  }
});

// Restore a previous version
router.post('/files/:id/restore', auth(["admin", "sub-admin", "user"]), async (req, res) => {
  try {
    const versionToRestore = await File.findById(req.params.id);
    
    if (!versionToRestore) {
      return res.status(404).json({
        success: false,
        error: "Version not found"
      });
    }

    // Check access
    const hasAccess = req.user.role === "admin" || 
      versionToRestore.owner.equals(req.user._id) ||
      (versionToRestore.folder && await validateFolderAccess(versionToRestore.folder, req.user._id));

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: "Access denied"
      });
    }

    // Get current version
    const currentVersion = await File.findOne({
      originalFile: versionToRestore.originalFile || versionToRestore._id,
      isCurrentVersion: true
    });

    if (!currentVersion) {
      return res.status(400).json({
        success: false,
        error: "Current version not found"
      });
    }

    // Create a copy of the version we're restoring (as a new version)
    const newVersion = new File({
      ...versionToRestore.toObject(),
      _id: undefined,
      version: currentVersion.version + 1,
      isCurrentVersion: true,
      previousVersions: [...currentVersion.previousVersions, currentVersion._id],
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Copy the physical file
    const newPath = path.join(
      path.dirname(versionToRestore.path),
      File.generateVersionedName(
        versionToRestore.originalFilename,
        newVersion.version,
        'number'
      )
    );

    await fsp.copyFile(versionToRestore.path, newPath);
    newVersion.path = newPath;

    // Save new version
    await newVersion.save();

    // Mark old versions as not current
    await File.updateMany(
      { 
        _id: { $in: [versionToRestore._id, currentVersion._id] },
        originalFilename: versionToRestore.originalFilename 
      },
      { isCurrentVersion: false }
    );

    res.json({
      success: true,
      data: newVersion,
      message: "Version restored successfully"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to restore version"
    });
  }
});
module.exports = router;
