const mongoose = require('mongoose');

const assetSchema = new mongoose.Schema({
    sNo: {
        type: Number,
        required: true,
        unique: true
    },
    productName: {
        type: String,
        required: true,
        trim: true,
        minlength: [2, "Product name must be at least 2 characters"]
    },
    productDescription: {
        type: String,
        required: true,
        trim: true,
        minlength: [5, "Product description must be at least 5 characters"]
    },
    assignedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        required: true,
        default: Date.now
    },
    remarks: {
        type: String,
        trim: true,
        maxlength: [500, "Remarks cannot exceed 500 characters"]
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'maintenance'],
        default: 'active'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// Auto-increment sNo
assetSchema.pre('save', async function(next) {
    if (!this.sNo) {
        try {
            const lastAsset = await this.constructor.findOne({}, {}, { sort: { sNo: -1 } });
            this.sNo = lastAsset ? lastAsset.sNo + 1 : 1;
        } catch (error) {
            return next(error);
        }
    }
    next();
});

// Indexes for better performance
// assetSchema.index({ sNo: 1 });
assetSchema.index({ assignedTo: 1 });
assetSchema.index({ assignedBy: 1 });
assetSchema.index({ status: 1 });

const Asset = mongoose.model('Asset', assetSchema);

module.exports = Asset;