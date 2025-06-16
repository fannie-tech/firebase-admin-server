const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Load service account
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(serviceAccountPath)) {
    console.error('❌ serviceAccountKey.json not found!');
    process.exit(1);
}

let serviceAccount;
try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log('✅ Service account loaded');
    console.log('📋 Project ID:', serviceAccount.project_id);
    console.log('📧 Client Email:', serviceAccount.client_email);
} catch (error) {
    console.error('❌ Error loading service account:', error);
    process.exit(1);
}

// 🔥 BETTER: Initialize Firebase Admin with explicit project ID
try {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: serviceAccount.project_id
        });
        console.log('✅ Firebase Admin initialized successfully');
    }
} catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error);
    process.exit(1);
}

const app = express();

// CORS configuration
app.use(cors({
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Get Firebase services
const auth = admin.auth();
const db = admin.firestore();

// 🔥 BETTER: Set Firestore settings
try {
    db.settings({
        ignoreUndefinedProperties: true
    });
    console.log('✅ Firestore settings configured');
} catch (error) {
    console.log('⚠️ Firestore settings warning:', error.message);
}

// List of allowed admin emails
const ALLOWED_ADMIN_EMAILS = [
    'godtim007@gmail.com',
    'reliancepremiumservices@gmail.com',
    'julietfredrick21@gmail.com'
];

// Authentication middleware
async function authenticateUser(req, res, next) {
    try {
        const idToken = req.headers.authorization?.split('Bearer ')[1];
        if (!idToken) {
            return res.status(401).json({ error: 'Unauthorized - No token provided' });
        }

        const decodedToken = await auth.verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(401).json({ error: 'Authentication failed' });
    }
}

// 🔥 MAIN NOTIFICATION ENDPOINT
app.post('/api/notify-user-delivery', async (req, res) => {
    console.log('📨 Notification request received');
    console.log('📋 Request body:', JSON.stringify(req.body, null, 2));

    try {
        const { userId, status, deliveryData, feedback } = req.body;

        if (!userId || !status) {
            console.log('❌ Missing required fields');
            return res.status(400).json({ error: 'Missing userId or status' });
        }

        console.log(`🔍 Processing notification for user: ${userId}, status: ${status}`);

        let title, body;

        switch (status) {
            case 'viewed':
                title = "📋 Delivery Viewed";
                body = "Your delivery request has been reviewed by our team.";
                break;
            case 'in-progress':
                title = "🚚 Delivery In Progress";
                body = "Great news! Your delivery is now in progress and on its way.";
                break;
            case 'delivered':
                title = "✅ Delivery Completed";
                body = "Your delivery has been successfully completed. Thank you for using our service!";
                break;
            case 'failed':
                title = "❌ Delivery Failed";
                body = "Unfortunately, your delivery could not be completed. Please contact support.";
                break;
            case 'feedback':
                title = "💬 Admin Feedback";
                body = feedback || "You have received feedback from our admin team.";
                break;
            default:
                title = "📦 Delivery Update";
                body = `Your delivery status has been updated to: ${status}`;
        }

        if (feedback && status !== 'feedback') {
            body += `\n\nAdmin Note: ${feedback}`;
        }

        console.log('📝 Creating notification documents...');

        const userNotificationData = {
            userId: userId,
            title: title,
            body: body,
            type: 'delivery_update',
            data: {
                deliveryId: deliveryData?.id || 'unknown',
                status: status,
                deliveryType: deliveryData?.deliveryType || 'unknown'
            },
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        console.log('📄 Creating USER notification...');
        const userNotificationRef = await db.collection('user_notifications').add(userNotificationData);
        console.log('✅ User notification created with ID:', userNotificationRef.id);

        let adminNotificationRef = null;
        const shouldNotifyAdmin = ['delivered', 'failed'].includes(status);

        if (shouldNotifyAdmin) {
            const adminNotificationData = {
                type: 'delivery_completed',
                title: `📦 Delivery ${status.charAt(0).toUpperCase() + status.slice(1)}`,
                body: `Delivery ${deliveryData?.id?.substring(0, 8) || 'unknown'} has been marked as ${status}`,
                data: {
                    deliveryId: deliveryData?.id || 'unknown',
                    userId: userId,
                    status: status,
                    deliveryType: deliveryData?.deliveryType || 'unknown'
                },
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };

            console.log('📄 Creating ADMIN notification...');
            adminNotificationRef = await db.collection('admin_notifications').add(adminNotificationData);
            console.log('✅ Admin notification created with ID:', adminNotificationRef.id);
        } else {
            console.log('⏭️ Skipping admin notification for status:', status);
        }

        res.status(200).json({
            success: true,
            message: 'Notification sent successfully',
            userNotificationId: userNotificationRef.id,
            adminNotificationId: adminNotificationRef?.id || null
        });

    } catch (error) {
        console.error('❌ Notification endpoint error:', error);
        res.status(500).json({
            error: 'Server error: ' + error.message,
            code: error.code || 'UNKNOWN'
        });
    }
});

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        firebase: {
            adminInitialized: admin.apps.length > 0,
            projectId: serviceAccount.project_id
        }
    });
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const testRef = db.collection('_health').doc('check');
        await testRef.set({ timestamp: new Date() });
        await testRef.delete();

        res.json({
            status: 'healthy',
            firestore: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            firestore: 'disconnected',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Update the admin-status endpoint
app.get('/api/admin-status', authenticateUser, async (req, res) => {
    try {
        const uid = req.user.uid;
        const userEmail = req.user.email;

        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = userDoc.data();

        const isAdminByEmail = ALLOWED_ADMIN_EMAILS.includes(userEmail);
        const isAdminByDatabase = userData.isAdmin === true;
        const isAdmin = isAdminByEmail || isAdminByDatabase;

        if (isAdminByEmail && !isAdminByDatabase) {
            console.log(`🔧 Updating admin status for ${userEmail}`);
            await db.collection('users').doc(uid).update({ isAdmin: true });
        }

        res.json({
            uid,
            email: userData.email || userEmail,
            isAdmin
        });
    } catch (error) {
        console.error('Error checking admin status:', error);
        res.status(500).json({ error: 'Server error while checking admin status' });
    }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
