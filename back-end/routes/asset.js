const express = require('express');
const router = express.Router();
const Asset = require('../models/asset.model');
const User = require('../models/user.model');
const auth = require('../middleware/auth'); // Using your existing auth middleware

// Get all assets (accessible by all authenticated users)
router.get('/', auth(['admin', 'sub-admin', 'user']), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;

        const assets = await Asset.find(filter)
            .populate('assignedBy', 'username email')
            .populate('assignedTo', 'username email')
            .populate('createdBy', 'username')
            .populate('updatedBy', 'username')
            .sort({ sNo: 1 })
            .skip(skip)
            .limit(limit);

        const total = await Asset.countDocuments(filter);

        res.json({
            success: true,
            data: assets,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalItems: total,
                itemsPerPage: limit
            }
        });
    } catch (error) {
        console.error('Error fetching assets:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get single asset by ID
router.get('/:id', auth(['admin', 'sub-admin', 'user']), async (req, res) => {
    try {
        const asset = await Asset.findById(req.params.id)
            .populate('assignedBy', 'username email')
            .populate('assignedTo', 'username email')
            .populate('createdBy', 'username')
            .populate('updatedBy', 'username');

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        res.json({
            success: true,
            data: asset
        });
    } catch (error) {
        console.error('Error fetching asset:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Create new asset (admin only)
router.post('/', auth(['admin']), async (req, res) => {
    try {
        const { sNo, productName, productDescription, assignedBy, assignedTo, date, remarks } = req.body;

        // Validate required fields
        if (!sNo || !productName || !productDescription || !assignedBy || !assignedTo) {
            return res.status(400).json({ message: 'Missing required fields: productName, productDescription, assignedBy, assignedTo' });
        }

        // Verify assigned users exist
        const [assignedByUser, assignedToUser] = await Promise.all([
            User.findById(assignedBy),
            User.findById(assignedTo)
        ]);

        if (!assignedByUser) {
            return res.status(400).json({ message: 'Assigned by user not found' });
        }

        if (!assignedToUser) {
            return res.status(400).json({ message: 'Assigned to user not found' });
        }

        const asset = new Asset({
            sNo, 
            productName,
            productDescription,
            assignedBy,
            assignedTo,
            date: date ? new Date(date) : new Date(),
            remarks,
            createdBy: req.user.id
        });

        await asset.save();
        
        // Populate the created asset
        await asset.populate([
            { path: 'assignedBy', select: 'username email' },
            { path: 'assignedTo', select: 'username email' },
            { path: 'createdBy', select: 'username' }
        ]);

        res.status(201).json({
            success: true,
            message: 'Asset created successfully',
            data: asset
        });
    } catch (error) {
        console.error('Error creating asset:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update asset (admin only)
router.put('/:id', auth(['admin']), async (req, res) => {
    try {
        const { productName, productDescription, assignedBy, assignedTo, date, remarks, status } = req.body;

        const asset = await Asset.findById(req.params.id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Verify users exist if they're being updated
        if (assignedBy) {
            const assignedByUser = await User.findById(assignedBy);
            if (!assignedByUser) {
                return res.status(400).json({ message: 'Assigned by user not found' });
            }
        }

        if (assignedTo) {
            const assignedToUser = await User.findById(assignedTo);
            if (!assignedToUser) {
                return res.status(400).json({ message: 'Assigned to user not found' });
            }
        }

        // Update fields
        if (productName) asset.productName = productName;
        if (productDescription) asset.productDescription = productDescription;
        if (assignedBy) asset.assignedBy = assignedBy;
        if (assignedTo) asset.assignedTo = assignedTo;
        if (date) asset.date = new Date(date);
        if (remarks !== undefined) asset.remarks = remarks;
        if (status) asset.status = status;
        asset.updatedBy = req.user.id;

        await asset.save();
        
        // Populate the updated asset
        await asset.populate([
            { path: 'assignedBy', select: 'username email' },
            { path: 'assignedTo', select: 'username email' },
            { path: 'createdBy', select: 'username' },
            { path: 'updatedBy', select: 'username' }
        ]);

        res.json({
            success: true,
            message: 'Asset updated successfully',
            data: asset
        });
    } catch (error) {
        console.error('Error updating asset:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete asset (admin only)
router.delete('/:id', auth(['admin']), async (req, res) => {
    try {
        const asset = await Asset.findById(req.params.id);
        
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        await Asset.findByIdAndDelete(req.params.id);

        res.json({ message: 'Asset deleted successfully' });
    } catch (error) {
        console.error('Error deleting asset:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get all users for dropdown (for assigned by/to fields)
router.get('/users/list', auth(['admin', 'sub-admin', 'user']), async (req, res) => {
    try {
        const users = await User.find({}, 'username email role').sort({ username: 1 });
        
        res.json({
            success: true,
            data: users
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;