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
            projectId: serviceAccount.project_id  // Explicitly set project ID
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
    // Set Firestore settings to avoid some authentication issues
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
    'reliancepremiumservices@gmail.com'
   'julietfredrick21@gmail.com'
];

// 🔥 IMPROVED: Test Firestore connection with retry
async function testFirestore(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`🧪 Testing Firestore connection (attempt ${i + 1}/${retries})...`);
            
            // Try a simple operation
            const testRef = db.collection('_connection_test').doc('test');
            await testRef.set({ 
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                test: true 
            });
            
            console.log('✅ Firestore write test successful');
            
            // Clean up test document
            await testRef.delete();
            console.log('✅ Firestore connection fully verified');
            
            return true;
        } catch (error) {
            console.error(`❌ Firestore test attempt ${i + 1} failed:`, error.message);
            
            if (i < retries - 1) {
                console.log('⏳ Retrying in 2 seconds...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    console.error('❌ All Firestore connection attempts failed');
    return false;
}

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

        // Generate notification content
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

        // 🔥 Create USER notification (for the user's profile page)
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

        // 🔥 Create ADMIN notification ONLY for completed deliveries
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

        // Try to get user for FCM (optional)
        try {
            console.log('👤 Looking up user for FCM...');
            const userDoc = await db.collection('users').doc(userId).get();

            if (userDoc.exists) {
                const userData = userDoc.data();
                console.log('✅ User found:', {
                    email: userData.email,
                    hasFCMToken: !!userData.fcmToken
                });

                // Try FCM if token exists
                if (userData.fcmToken) {
                    console.log('📱 Attempting FCM notification...');

                    const message = {
                        token: userData.fcmToken,
                        notification: {
                            title: title,
                            body: body
                        },
                        data: {
                            type: 'delivery_update',
                            deliveryId: deliveryData?.id || 'unknown',
                            status: status
                        },
                        webpush: {
                            headers: {
                                Urgency: 'high'
                            },
                            notification: {
                                icon: '/assets/img/favicon_io/android-chrome-192x192.png',
                                badge: '/assets/img/favicon_io/android-chrome-192x192.png',
                                vibrate: [100, 50, 100],
                                requireInteraction: true
                            }
                        }
                    };

                    const fcmResponse = await admin.messaging().send(message);
                    console.log('✅ FCM notification sent:', fcmResponse);
                }
            } else {
                console.log('⚠️ User document not found');
            }
        } catch (userError) {
            console.log('⚠️ User lookup/FCM failed (continuing anyway):', userError.message);
        }

        res.status(200).json({
            success: true,
            message: 'Notification sent successfully',
            userNotificationId: userNotificationRef.id,
            adminNotificationId: adminNotificationRef?.id || null
        });

    } catch (error) {
        console.error('❌ Notification endpoint error:', error);
        console.error('Error code:', error.code);
        console.error('Error stack:', error.stack);

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
        // Quick Firestore test
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

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    
    // Test Firestore connection with retry
    const firestoreWorking = await testFirestore();
    
    if (firestoreWorking) {
        console.log('🎉 Server ready to handle notifications!');
        console.log('🔗 Test the server: http://localhost:3000/api/test');
        console.log('🔗 Health check: http://localhost:3000/api/health');
    } else {
        console.log('⚠️ Server started but Firestore connection failed');
        console.log('📝 The notification endpoint may still work for some operations');
    }
});
