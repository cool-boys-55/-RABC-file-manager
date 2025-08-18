const fs = require("fs");
const path = require("path");
const os = require("os");
const { promisify } = require("util");

const mkdir = promisify(fs.mkdir);
const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);

// Use absolute path to storage directory
const STORAGE_ROOT = path.resolve(__dirname, "../storage");

// Create storage directory if it doesn't exist
if (!fs.existsSync(STORAGE_ROOT)) {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
}

/**
 * Ensures a file is available for reading.
 * - Tries reading the first byte
 * - If permission error (EPERM), copies it to a temp path
 * @param {string} filePath - Absolute path to file
 * @returns {Promise<string|true>} True if accessible, or temp path if copied
 */
async function ensureFileAvailable(filePath) {
  try {
    const fd = await fs.promises.open(filePath, "r");
    await fd.read(Buffer.alloc(1), 0, 1, 0); // Try to read 1 byte
    await fd.close();
    return filePath; // File is fine, return original path
  } catch (err) {
    if (err.code === "EPERM") {
      // Copy to temporary location for access
      const tempPath = path.join(os.tmpdir(), path.basename(filePath));
      await fs.promises.copyFile(filePath, tempPath);
      return tempPath;
    }
    throw err;
  }
}

module.exports = {
  STORAGE_ROOT,

  getFullPath(relativePath) {
    return path.join(STORAGE_ROOT, relativePath);
  },

  async createDirectory(relativePath) {
    const fullPath = this.getFullPath(relativePath);
    await mkdir(fullPath, { recursive: true });
    return fullPath;
  },

  async deleteDirectory(relativePath) {
    const fullPath = this.getFullPath(relativePath);

    if (fullPath === STORAGE_ROOT || !fullPath.startsWith(STORAGE_ROOT)) {
      throw new Error("Attempted to delete protected directory");
    }

    const files = await readdir(fullPath);
    await Promise.all(
      files.map(async (file) => {
        const currentPath = path.join(fullPath, file);
        const stats = await stat(currentPath);

        if (stats.isDirectory()) {
          await this.deleteDirectory(path.relative(STORAGE_ROOT, currentPath));
        } else {
          await unlink(currentPath);
        }
      })
    );

    await rmdir(fullPath);
  },

  async moveDirectory(oldRelativePath, newRelativePath) {
    const fullOldPath = this.getFullPath(oldRelativePath);
    const fullNewPath = this.getFullPath(newRelativePath);

    // Ensure parent directory exists
    await mkdir(path.dirname(fullNewPath), { recursive: true });
    await rename(fullOldPath, fullNewPath);
  },

  async pathExists(relativePath) {
    try {
      await stat(this.getFullPath(relativePath));
      return true;
    } catch {
      return false;
    }
  },

  async readFile(relativePath) {
    const fullPath = this.getFullPath(relativePath);
    const effectivePath = await ensureFileAvailable(fullPath);
    return fs.promises.readFile(effectivePath);
  },

  async fileExists(relativePath) {
    return this.pathExists(relativePath);
  },

  async rename(oldPath, newPath) {
    const fullOldPath = this.getFullPath(oldPath);
    const fullNewPath = this.getFullPath(newPath);

    // Ensure parent directory exists
    await mkdir(path.dirname(fullNewPath), { recursive: true });

    await rename(fullOldPath, fullNewPath);
  },

  // Expose the helper if needed for other read ops
  ensureFileAvailable,
};
