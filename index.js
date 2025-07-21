const admin = require('firebase-admin');
const express = require('express');
const http = require('http'); // NEW: For Socket.IO
const socketIo = require('socket.io'); // NEW: Socket.IO
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// WITH THIS NEW CODE:
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Production: Use environment variable
        console.log('🔄 Loading service account from environment variable...');
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('✅ Service account loaded from environment');
    } else {
        // Development: Use local file
        console.log('🔄 Loading service account from local file...');
        const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
        
        if (!fs.existsSync(serviceAccountPath)) {
            console.error('❌ serviceAccountKey.json not found and no environment variable set!');
            console.error('💡 Set FIREBASE_SERVICE_ACCOUNT environment variable or add serviceAccountKey.json file');
            process.exit(1);
        }
        
        serviceAccount = require('./serviceAccountKey.json');
        console.log('✅ Service account loaded from file');
    }
    
    console.log('📋 Project ID:', serviceAccount.project_id);
    console.log('📧 Client Email:', serviceAccount.client_email);
    
    // Validate required fields
    if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
        throw new Error('Invalid service account: missing required fields');
    }
    
} catch (error) {
    console.error('❌ Error loading service account:', error);
    console.error('💡 Make sure your service account JSON is valid');
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
const server = http.createServer(app); // NEW: Create HTTP server for Socket.IO

// NEW: Initialize Socket.IO with CORS configuration
const io = socketIo(server, {
    cors: {
         origin: ['https://reliancewebapp-cbffa.web.app/admin.html', 'https://reliancewebapp-cbffa.web.app/admin.html'],
        methods: ["GET", "POST"]
    }
});

// NEW: Store connected clients by order ID for targeted updates
const orderClients = new Map(); // orderId -> Set of socket IDs
const clientOrders = new Map(); // socket ID -> Set of order IDs


// Add this BEFORE your existing CORS configuration
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Keep your existing CORS configuration
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
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


// NEW: WebSocket connection handling
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    // Handle client subscribing to order updates
    socket.on('subscribe-to-order', (orderId) => {
        console.log(`📱 Client ${socket.id} subscribing to order: ${orderId}`);
        
        // Add client to order's subscriber list
        if (!orderClients.has(orderId)) {
            orderClients.set(orderId, new Set());
        }
        orderClients.get(orderId).add(socket.id);
        
        // Add order to client's subscription list
        if (!clientOrders.has(socket.id)) {
            clientOrders.set(socket.id, new Set());
        }
        clientOrders.get(socket.id).add(orderId);
        
        // Join socket room for this order (alternative approach)
        socket.join(`order-${orderId}`);
        
        // Send confirmation
        socket.emit('subscription-confirmed', {
            orderId,
            message: `Subscribed to updates for order ${orderId}`
        });
    });

    // Handle client unsubscribing from order updates
    socket.on('unsubscribe-from-order', (orderId) => {
        console.log(`📱 Client ${socket.id} unsubscribing from order: ${orderId}`);
        
        // Remove client from order's subscriber list
        if (orderClients.has(orderId)) {
            orderClients.get(orderId).delete(socket.id);
            if (orderClients.get(orderId).size === 0) {
                orderClients.delete(orderId);
            }
        }
        
        // Remove order from client's subscription list
        if (clientOrders.has(socket.id)) {
            clientOrders.get(socket.id).delete(orderId);
        }
        
        // Leave socket room
        socket.leave(`order-${orderId}`);
        
        socket.emit('unsubscription-confirmed', {
            orderId,
            message: `Unsubscribed from order ${orderId}`
        });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
        
        // Clean up subscriptions for this client
        if (clientOrders.has(socket.id)) {
            const orderIds = clientOrders.get(socket.id);
            orderIds.forEach(orderId => {
                if (orderClients.has(orderId)) {
                    orderClients.get(orderId).delete(socket.id);
                    if (orderClients.get(orderId).size === 0) {
                        orderClients.delete(orderId);
                    }
                }
            });
            clientOrders.delete(socket.id);
        }
    });

    // Handle request for current order status
    socket.on('get-order-status', async (orderId) => {
        try {
            const deliveriesQuery = await db.collection('deliveries')
                .where('id', '==', orderId)
                .limit(1)
                .get();

            if (!deliveriesQuery.empty) {
                const deliveryDoc = deliveriesQuery.docs[0];
                const deliveryData = deliveryDoc.data();
                
                socket.emit('order-status-response', {
                    orderId,
                    status: deliveryData.status,
                    serviceType: deliveryData.serviceType,
                    estimatedDeliveryTime: deliveryData.estimatedDeliveryTime,
                    estimatedPickupTime: deliveryData.estimatedPickupTime,
                    pickupCompleted: deliveryData.pickupCompleted || false
                });
            } else {
                socket.emit('order-status-error', {
                    orderId,
                    error: 'Order not found'
                });
            }
        } catch (error) {
            socket.emit('order-status-error', {
                orderId,
                error: error.message
            });
        }
    });
});

// NEW: Function to broadcast order updates via WebSocket
function broadcastOrderUpdate(orderId, updateData) {
    console.log(`📡 Broadcasting update for order ${orderId}:`, updateData);
    
    // Method 1: Send to specific clients subscribed to this order
    if (orderClients.has(orderId)) {
        const subscribedClients = orderClients.get(orderId);
        subscribedClients.forEach(socketId => {
            io.to(socketId).emit('order-update', {
                orderId,
                ...updateData,
                timestamp: new Date().toISOString()
            });
        });
    }
    
    // Method 2: Send to room (alternative approach)
    io.to(`order-${orderId}`).emit('order-update', {
        orderId,
        ...updateData,
        timestamp: new Date().toISOString()
    });
    

    const subs = orderClients.get(orderId);
    const num = subs?.size ?? 0;
    console.log(`📊 Update sent to ${num} clients`);

}

// NEW: Function to broadcast general notifications
function broadcastGeneralUpdate(data) {
    io.emit('general-update', {
        ...data,
        timestamp: new Date().toISOString()
    });
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



// UPDATED: E-COMMERCE ORDER ENDPOINT with WebSocket integration
app.post('/api/ecommerce/create-order', async (req, res) => {
    console.log('🛒 Simplified e-commerce order received');
    console.log('📋 Request body:', JSON.stringify(req.body, null, 2));

    try {
        const {
            customerName,
            phoneNumber,
            dropOffLocation,
            dropOffPhoneNumber, // NEW: Drop-off phone number
            productName,
            pickupLocation
        } = req.body;

        // Validate required fields (including new drop-off phone number)
        if (!customerName || !phoneNumber || !dropOffLocation || !dropOffPhoneNumber || !productName) {
            return res.status(400).json({
                error: 'Missing required fields: customerName, phoneNumber, dropOffLocation, dropOffPhoneNumber, productName'
            });
        }

        // Generate unique order ID
        const orderId = `ECO-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        // Prepare delivery data with optional pickup location and drop-off phone
        const deliveryData = {
            id: orderId,
            userId: 'ecommerce-system',
            customerInfo: {
                name: customerName,
                phone: phoneNumber
            },
            pickupAddress: pickupLocation ? {
                street: pickupLocation,
                city: '',
                state: '',
                postalCode: '',
                country: 'Nigeria',
                coordinates: null
            } : null,
            deliveryAddress: {
                street: dropOffLocation,
                phone: dropOffPhoneNumber, // NEW: Add drop-off phone number
                city: '',
                state: '',
                postalCode: '',
                country: 'Nigeria'
            },
            items: [{
                name: productName,
                quantity: 1,
                price: 0,
                total: 0,
                description: '',
                sku: '',
                category: 'General'
            }],
            deliveryType: 'ECOMMERCE',
            orderType: 'ecommerce_delivery',
            serviceType: pickupLocation ? 'PICKUP_AND_DELIVERY' : 'DELIVERY_ONLY',
            orderSummary: {
                subtotal: 0,
                deliveryFee: 0,
                pickupFee: pickupLocation ? 0 : null,
                tax: 0,
                discount: 0,
                total: 0
            },
            status: 'pending',
            priority: 'normal',
            estimatedDeliveryTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
            estimatedPickupTime: pickupLocation ? new Date(Date.now() + 2 * 60 * 60 * 1000) : null,
            specialInstructions: pickupLocation ? `Pickup from: ${pickupLocation}` : null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        console.log('📄 Creating delivery request with pickup info...');
        console.log(`📍 Pickup Location: ${pickupLocation || 'Not specified'}`);
        console.log(`📍 Drop-off Location: ${dropOffLocation}`);
        console.log(`📞 Drop-off Phone: ${dropOffPhoneNumber}`); // NEW: Log drop-off phone
        
        const deliveryRef = await db.collection('deliveries').add(deliveryData);
        console.log('✅ Order created with ID:', deliveryRef.id);

        // Prepare response data
        const responseData = {
            orderId: orderId,
            deliveryId: deliveryRef.id,
            status: 'pending',
            serviceType: deliveryData.serviceType,
            estimatedDelivery: deliveryData.estimatedDeliveryTime,
            dropOffPhoneNumber: dropOffPhoneNumber // NEW: Include in response
        };

        if (pickupLocation) {
            responseData.pickupLocation = pickupLocation;
            responseData.estimatedPickup = deliveryData.estimatedPickupTime;
        }

        // 🚀 NEW: Broadcast order creation via WebSocket
        broadcastOrderUpdate(orderId, {
            type: 'order-created',
            status: 'pending',
            customerName: customerName,
            serviceType: deliveryData.serviceType,
            pickupLocation: pickupLocation,
            deliveryLocation: dropOffLocation,
            dropOffPhoneNumber: dropOffPhoneNumber, // NEW: Include in WebSocket broadcast
            productName: productName,
            estimatedDelivery: deliveryData.estimatedDeliveryTime,
            estimatedPickup: deliveryData.estimatedPickupTime
        });

        // Also broadcast to admin dashboard
        broadcastGeneralUpdate({
            type: 'new-order',
            orderId: orderId,
            customerName: customerName,
            serviceType: deliveryData.serviceType,
            dropOffPhoneNumber: dropOffPhoneNumber // NEW: Include in general broadcast
        });

        res.status(200).json({
            success: true,
            message: pickupLocation ? 
                'Pickup and delivery order created successfully' : 
                'Delivery order created successfully',
            data: responseData
        });

    } catch (error) {
        console.error('❌ Error creating order:', error);
        res.status(500).json({
            error: 'Server error: ' + error.message,
            code: error.code || 'ORDER_CREATION_ERROR'
        });
    }
});

//GET E-COMMERCE ORDER STATUS (Updated to include pickup info and drop-off phone)
app.get('/api/ecommerce/order-status/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        console.log(`🔍 Checking status for order: ${orderId}`);

        // Query deliveries collection for the order
        const deliveriesQuery = await db.collection('deliveries')
            .where('id', '==', orderId)
            .limit(1)
            .get();

        if (deliveriesQuery.empty) {
            return res.status(404).json({
                error: 'Order not found',
                orderId: orderId
            });
        }

        const deliveryDoc = deliveriesQuery.docs[0];
        const deliveryData = deliveryDoc.data();

        res.status(200).json({
            success: true,
            data: {
                orderId: orderId,
                status: deliveryData.status,
                serviceType: deliveryData.serviceType || 'DELIVERY_ONLY',
                customerInfo: deliveryData.customerInfo,
                pickupAddress: deliveryData.pickupAddress || null,
                deliveryAddress: deliveryData.deliveryAddress, // This now includes the phone number
                items: deliveryData.items,
                orderSummary: deliveryData.orderSummary,
                estimatedPickupTime: deliveryData.estimatedPickupTime || null,
                estimatedDeliveryTime: deliveryData.estimatedDeliveryTime,
                specialInstructions: deliveryData.specialInstructions,
                createdAt: deliveryData.createdAt,
                updatedAt: deliveryData.updatedAt
            }
        });

    } catch (error) {
        console.error('❌ Order status check error:', error);
        res.status(500).json({
            error: 'Server error: ' + error.message,
            code: error.code || 'ORDER_STATUS_ERROR'
        });
    }
});

// UPDATED: UPDATE E-COMMERCE ORDER STATUS with WebSocket integration
app.put('/api/ecommerce/update-order/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { status, feedback, trackingInfo, pickupCompleted } = req.body;

        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        console.log(`🔄 Updating order ${orderId} to status: ${status}`);

        // Find the delivery document
        const deliveriesQuery = await db.collection('deliveries')
            .where('id', '==', orderId)
            .limit(1)
            .get();

        if (deliveriesQuery.empty) {
            return res.status(404).json({
                error: 'Order not found',
                orderId: orderId
            });
        }

        const deliveryDoc = deliveriesQuery.docs[0];
        const deliveryData = deliveryDoc.data();
        
        const updateData = {
            status: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (feedback) {
            updateData.adminFeedback = feedback;
        }

        if (trackingInfo) {
            updateData.trackingInfo = trackingInfo;
        }

        if (pickupCompleted !== undefined) {
            updateData.pickupCompleted = pickupCompleted;
            if (pickupCompleted) {
                updateData.pickupCompletedAt = admin.firestore.FieldValue.serverTimestamp();
            }
        }

        // Update the delivery document
        await deliveryDoc.ref.update(updateData);

        // 🚀 NEW: Broadcast status update via WebSocket
        const wsUpdateData = {
            type: 'status-update',
            status: status,
            feedback: feedback,
            trackingInfo: trackingInfo,
            pickupCompleted: pickupCompleted,
            serviceType: deliveryData.serviceType,
            customerName: deliveryData.customerInfo?.name,
            hasPickup: !!deliveryData.pickupAddress,
            dropOffPhoneNumber: deliveryData.deliveryAddress?.phone // NEW: Include drop-off phone in WebSocket updates
        };

        // Get user-friendly status message
        let statusMessage = '';
        switch (status) {
            case 'confirmed':
                statusMessage = 'Your order has been confirmed and is being prepared.';
                break;
            case 'pickup-ready':
                statusMessage = 'Your order is ready for pickup.';
                break;
            case 'picked-up':
                statusMessage = 'Your order has been picked up and is on its way.';
                break;
            case 'in-progress':
                statusMessage = 'Your order is out for delivery.';
                break;
            case 'delivered':
                statusMessage = 'Your order has been successfully delivered!';
                break;
            case 'failed':
                statusMessage = 'There was an issue with your order delivery.';
                break;
            default:
                statusMessage = `Order status updated to: ${status}`;
        }

        wsUpdateData.message = statusMessage;
        if (feedback) {
            wsUpdateData.message += ` Note: ${feedback}`;
        }

        broadcastOrderUpdate(orderId, wsUpdateData);

        // Send notification to customer if email exists
        if (deliveryData.customerInfo?.email) {
            let title, body;
            
            switch (status) {
                case 'confirmed':
                    title = "✅ Order Confirmed";
                    body = `Your order #${orderId} has been confirmed and is being prepared.`;
                    if (deliveryData.pickupAddress) {
                        body += `\n📍 Pickup Location: ${deliveryData.pickupAddress.street}`;
                    }
                    body += `\n📍 Delivery Location: ${deliveryData.deliveryAddress.street}`;
                    body += `\n📞 Delivery Contact: ${deliveryData.deliveryAddress.phone}`; // NEW: Include drop-off phone in notifications
                    break;
                case 'pickup-ready':
                    title = "📦 Ready for Pickup";
                    body = `Your order #${orderId} is ready for pickup at ${deliveryData.pickupAddress?.street || 'the specified location'}.`;
                    break;
                case 'picked-up':
                    title = "🚚 Item Picked Up";
                    body = `Your order #${orderId} has been picked up and is now on its way for delivery to ${deliveryData.deliveryAddress.street}. Contact: ${deliveryData.deliveryAddress.phone}`;
                    break;
                case 'in-progress':
                    title = "🚚 Order In Transit";
                    body = `Your order #${orderId} is now out for delivery to ${deliveryData.deliveryAddress.street}. Contact: ${deliveryData.deliveryAddress.phone}`;
                    break;
                case 'delivered':
                    title = "📦 Order Delivered";
                    body = `Your order #${orderId} has been successfully delivered to ${deliveryData.deliveryAddress.street}. Thank you!`;
                    break;
                case 'failed':
                    title = "❌ Delivery Failed";
                    body = `Unfortunately, we couldn't ${deliveryData.pickupAddress ? 'pickup or ' : ''}deliver your order #${orderId}. We'll contact you at ${deliveryData.deliveryAddress.phone} soon.`;
                    break;
                default:
                    title = "📋 Order Update";
                    body = `Your order #${orderId} status has been updated to: ${status}`;
            }

            if (feedback) {
                body += `\n\nNote: ${feedback}`;
            }

            const customerNotificationData = {
                userId: 'ecommerce-customer',
                email: deliveryData.customerInfo.email,
                title: title,
                body: body,
                type: 'order_update',
                data: {
                    orderId: orderId,
                    status: status,
                    serviceType: deliveryData.serviceType,
                    hasPickup: !!deliveryData.pickupAddress,
                    dropOffPhoneNumber: deliveryData.deliveryAddress?.phone, // NEW: Include in notification data
                    feedback: feedback || null
                },
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };

            await db.collection('user_notifications').add(customerNotificationData);
        }

        res.status(200).json({
            success: true,
            message: 'Order status updated successfully',
            data: {
                orderId: orderId,
                status: status,
                serviceType: deliveryData.serviceType,
                hasPickup: !!deliveryData.pickupAddress,
                pickupCompleted: updateData.pickupCompleted,
                dropOffPhoneNumber: deliveryData.deliveryAddress?.phone, // NEW: Include in response
                updatedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Order update error:', error);
        res.status(500).json({
            error: 'Server error: ' + error.message,
            code: error.code || 'ORDER_UPDATE_ERROR'
        });
    }
});

// GET E-COMMERCE ORDERS SUMMARY (Updated to include pickup info and drop-off phone)
app.get('/api/ecommerce/orders-summary', async (req, res) => {
    try {
        const { startDate, endDate, status, serviceType } = req.query;
        
        console.log('📊 Fetching e-commerce orders summary...');

        let query = db.collection('deliveries').where('deliveryType', '==', 'ECOMMERCE');

        // Add date filters if provided
        if (startDate) {
            query = query.where('createdAt', '>=', new Date(startDate));
        }
                if (endDate) {
            query = query.where('createdAt', '<=', new Date(endDate));
        }
        if (status) {
            query = query.where('status', '==', status);
        }
        if (serviceType) {
            query = query.where('serviceType', '==', serviceType);
        }

        const ordersSnapshot = await query.get();
        const orders = [];
        let totalRevenue = 0;

        ordersSnapshot.forEach(doc => {
            const orderData = doc.data();
            orders.push({
                id: doc.id,
                orderId: orderData.id,
                customerName: orderData.customerInfo?.name,
                customerPhone: orderData.customerInfo?.phone,
                status: orderData.status,
                serviceType: orderData.serviceType || 'DELIVERY_ONLY',
                hasPickup: !!orderData.pickupAddress,
                pickupLocation: orderData.pickupAddress?.street || null,
                deliveryLocation: orderData.deliveryAddress?.street,
                dropOffPhoneNumber: orderData.deliveryAddress?.phone || null, // NEW: Include drop-off phone in summary
                total: orderData.orderSummary?.total || 0,
                itemCount: orderData.items?.length || 0,
                createdAt: orderData.createdAt,
                source: orderData.source
            });
            
            if (orderData.status === 'delivered') {
                totalRevenue += orderData.orderSummary?.total || 0;
            }
        });

        // Calculate statistics
        const stats = {
            totalOrders: orders.length,
            pendingOrders: orders.filter(o => o.status === 'pending').length,
            inProgressOrders: orders.filter(o => o.status === 'in-progress').length,
            deliveredOrders: orders.filter(o => o.status === 'delivered').length,
            failedOrders: orders.filter(o => o.status === 'failed').length,
            pickupAndDeliveryOrders: orders.filter(o => o.serviceType === 'PICKUP_AND_DELIVERY').length,
            deliveryOnlyOrders: orders.filter(o => o.serviceType === 'DELIVERY_ONLY').length,
            totalRevenue: totalRevenue,
            averageOrderValue: orders.length > 0 ? totalRevenue / orders.filter(o => o.status === 'delivered').length : 0
        };

        res.status(200).json({
            success: true,
            data: {
                orders: orders,
                statistics: stats,
                period: {
                    startDate: startDate || null,
                    endDate: endDate || null
                }
            }
        });

    } catch (error) {
        console.error('❌ Orders summary error:', error);
        res.status(500).json({
            error: 'Server error: ' + error.message,
            code: error.code || 'ORDERS_SUMMARY_ERROR'
        });
    }
});

// NEW: Health check endpoint for WebSocket
app.get('/api/websocket/health', (req, res) => {
    res.json({
        success: true,
        connectedClients: io.sockets.sockets.size,
        activeSubscriptions: orderClients.size,
        timestamp: new Date().toISOString()
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
            websocket: {
                connectedClients: io.sockets.sockets.size,
                activeSubscriptions: orderClients.size
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            firestore: 'disconnected',
            websocket: {
                connectedClients: io.sockets.sockets.size,
                activeSubscriptions: orderClients.size
            },
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Update the admin-status endpoint with better error handling
app.get('/api/admin-status', authenticateUser, async (req, res) => {
    try {
        console.log("🔍 Admin status check requested");
        
        const uid = req.user.uid;
        const userEmail = req.user.email;
        
        console.log(`📧 Checking admin status for: ${userEmail} (${uid})`);

        // Check if user exists in database
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            console.log("❌ User document not found in database");
            return res.status(404).json({ 
                error: 'User not found',
                uid,
                email: userEmail 
            });
        }

        const userData = userDoc.data();
        console.log("📋 User data from database:", {
            email: userData.email,
            isAdmin: userData.isAdmin,
            userType: userData.userType
        });

        // Check admin status by email and database
        const isAdminByEmail = ALLOWED_ADMIN_EMAILS.includes(userEmail);
        const isAdminByDatabase = userData.isAdmin === true;
        const isAdmin = isAdminByEmail || isAdminByDatabase;

        console.log("🔍 Admin status check results:", {
            email: userEmail,
            isAdminByEmail,
            isAdminByDatabase,
            finalIsAdmin: isAdmin
        });

        // Update database if user is admin by email but not in database
        if (isAdminByEmail && !isAdminByDatabase) {
            console.log(`🔧 Updating admin status in database for ${userEmail}`);
            try {
                await db.collection('users').doc(uid).update({ 
                    isAdmin: true,
                    userType: 'ADMIN'
                });
                console.log("✅ Admin status updated in database");
            } catch (updateError) {
                console.error("❌ Error updating admin status:", updateError);
            }
        }

        res.json({
            uid,
            email: userData.email || userEmail,
            isAdmin,
            isAdminByEmail,
            isAdminByDatabase,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error checking admin status:', error);
        res.status(500).json({ 
            error: 'Server error while checking admin status',
            details: error.message,
            code: error.code
        });
    }
});

// Add a debug endpoint to check user data
app.get('/api/debug-user/:uid', authenticateUser, async (req, res) => {
    try {
        const { uid } = req.params;
        const requestingUid = req.user.uid;
        
        // Only allow admins or the user themselves to access this
        if (requestingUid !== uid) {
            const requestingUserDoc = await db.collection('users').doc(requestingUid).get();
            if (!requestingUserDoc.exists || !requestingUserDoc.data().isAdmin) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        }
        
        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userData = userDoc.data();
        
        res.json({
            uid,
            exists: userDoc.exists,
            data: userData,
            isAdminByEmail: ALLOWED_ADMIN_EMAILS.includes(userData.email),
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Debug user endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
});

// NEW: WebSocket test endpoint for debugging
app.get('/api/websocket/test/:orderId', (req, res) => {
    const { orderId } = req.params;
    const { message } = req.query;
    
    // Test broadcasting to a specific order
    broadcastOrderUpdate(orderId, {
        type: 'test-update',
        message: message || 'This is a test WebSocket message',
        status: 'test'
    });
    
    res.json({
        success: true,
        message: `Test broadcast sent to order ${orderId}`,
        connectedClients: io.sockets.sockets.size,
        subscribedClients: orderClients.get(orderId)?.size || 0
    });
});

// NEW: General broadcast test endpoint
app.get('/api/websocket/broadcast-test', (req, res) => {
    const { message } = req.query;
    
    broadcastGeneralUpdate({
        type: 'test-broadcast',
        message: message || 'This is a test general broadcast',
        data: { timestamp: new Date().toISOString() }
    });
    
    res.json({
        success: true,
        message: 'Test general broadcast sent',
        connectedClients: io.sockets.sockets.size
    });
});

// Start server with WebSocket support (UPDATED)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 WebSocket server ready`);
    console.log(`📊 WebSocket health check: http://localhost:${PORT}/api/websocket/health`);
});

// Export the broadcast functions for use in other modules
module.exports = {
    broadcastOrderUpdate,
    broadcastGeneralUpdate,
    io
};
