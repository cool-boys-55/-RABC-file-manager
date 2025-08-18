// db.js
require('dotenv').config();
const mongoose = require('mongoose');
const retryInterval = 5000;
const maxRetries = 5;

const connectDB = async (retryCount = 0) => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            heartbeatFrequencyMS: 30000,
            socketTimeoutMS: 45000
        });
        console.log("✅ Successfully connected to MongoDB");
        return mongoose.connection; // Return the connection
    } catch (err) {
        console.error('❌ MongoDB connection error:', err);
        
        if (retryCount < maxRetries) {
            console.log(`↻ Retrying in ${retryInterval/1000}s (${retryCount + 1}/${maxRetries})`);
            return new Promise(resolve => 
                setTimeout(() => resolve(connectDB(retryCount + 1)), retryInterval)
            );
        } else {
            console.error('🛑 Max retries reached. Exiting...');
            process.exit(1);
        }
    }
};

mongoose.connection.on('disconnected', () => {
    console.log('🔌 MongoDB disconnected. Reconnecting...');
    connectDB();
});

mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB connection error:', err);
});

module.exports = connectDB;