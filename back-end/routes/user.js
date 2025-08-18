const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/user.model');

// this wull get all users (admin only)
router.get('/', auth(['admin']), async (req, res) => {
    try {
        const users = await User.find().select('-password');
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// this will ,Create new user (admin only)
router.post('/', auth(['admin']), async (req, res) => {
    try {
        const { username, email, password, role } = req.body;
        if (!username || !email || !password || !role) {
            return res.status(400).json({ message: 'All fields are required' });
        }
        if (!['admin', 'sub-admin', 'user'].includes(role)) {
            return res.status(400).json({ message: 'Invalid role' });
        }
        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists' });
        }
        // Create new user
        const newUser = new User({
            username,
            email,
            password,
            role
        });

        await newUser.save();
        
        // Return user without password
        const userResponse = newUser.toObject();
        delete userResponse.password;
        res.status(201).json(userResponse);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// this will,Get current user details (for everyone)
router.get('/me', auth(['admin', 'sub-admin', 'user']), async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json(user);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update user role (admin only)
router.put('/:id/role', auth(['admin']), async (req, res) => {
    try {
        const { role } = req.body;
        if (!['admin', 'sub-admin', 'user'].includes(role)) {
            return res.status(400).json({ message: 'Invalid role' });
        }
        const user = await User.findByIdAndUpdate(
            req.params.id,
            { role },
            { new: true }
        ).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(user);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete a user (admin only)
router.delete('/:id', auth(['admin']), async (req, res) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;