const { verifyToken } = require("../utils/jwt");
const User = require("../models/user.model");

const auth = (roles = []) => {
  if (typeof roles === 'string') {
    roles = [roles];
  }

  return async (req, res, next) => {
    try {
      // Get token from cookie or Authorization header
      const token = req.cookies?.token ||
      req.header("Authorization")?.replace("Bearer ", "");

      if (!token) {
        return res.status(401).json({ message: "Authorization required" });
      }

      // Verify token
      const decoded = verifyToken(token);
      
      if (!decoded || !decoded.userId) {
        return res.status(401).json({ message: "Invalid token" });
      }

      // Find user
      const user = await User.findById(decoded.userId);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      // Role check
      if (roles.length > 0 && !roles.includes(user.role)) {
        return res.status(403).json({ 
          message: `Access denied. Required roles: ${roles.join(", ")}` 
        });
      }

      // Attach user to request
      req.user = user;
      req.token = token;

      next();
    } catch (err) {
      return res.status(401).json({ message: "Invalid token" });
    }
  };
};

module.exports = auth;