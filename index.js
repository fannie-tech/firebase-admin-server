const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

// Initialize Firebase Admin with service account
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://reliancewebapp-cbffa.firebaseio.com'
});

const app = express();
 // Update your CORS configuration
app.use(cors({
  origin: true,  // Allow requests from any origin
  methods: ['GET', 'POST'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

app.get('/firebase-messaging-sw.js', (req, res) => {
  console.log('Service worker requested');
  const filePath = path.join(__dirname, 'firebase-messaging-sw.js');
  
  if (fs.existsSync(filePath)) {
    res.set('Content-Type', 'application/javascript');
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('Error serving service worker file:', err);
        res.status(500).send('Error serving service worker file');
      } else {
        console.log('Service worker file sent successfully');
      }
    });
  } else {
    console.error('Service worker file not found at:', filePath);
    res.status(404).send('Service worker file not found');
  }
});

// Render requires this
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Store references
const auth = admin.auth();
const db = admin.firestore();

// FCM HTTP v1 API configuration
const PROJECT_ID = 'reliancewebapp-cbffa'; // Your Firebase Project ID
const FCM_ENDPOINT = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
const SCOPES = ['https://www.googleapis.com/auth/firebase.messaging'];


// List of allowed admin emails
const ALLOWED_ADMIN_EMAILS = [
  'godtim007@gmail.com',
  'reliancepremiumservices@gmail.com'
];


// Middleware to verify admin token
async function verifyAdmin(req, res, next) {
  try {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const decodedToken = await auth.verifyIdToken(idToken);
    const uid = decodedToken.uid;
    
    // Check if user's email is in the allowed admin list
    const userRecord = await auth.getUser(uid);
    if (!ALLOWED_ADMIN_EMAILS.includes(userRecord.email)) {
      return res.status(403).json({ error: 'Forbidden: Not an admin' });
    }
    
    req.user = userRecord;
    next();
  } catch (error) {
    console.error('Admin verification error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

// Function to get OAuth 2.0 access token for FCM
async function getAccessToken() {
  try {
    const jwtClient = new google.auth.JWT(
      serviceAccount.client_email,
      null,
      serviceAccount.private_key,
      SCOPES,
      null
    );
    const tokens = await jwtClient.authorize();
    return tokens.access_token;
  } catch (error) {
    console.error('Error getting access token:', error);
    throw new Error('Failed to get access token');
  }
}

// Endpoint to send FCM notification (admin-only)
app.post('/api/send-notification', verifyAdmin, async (req, res) => {
  try {
    const { userId, title, body, fcmToken } = req.body;

    if (!userId || !title || !body || !fcmToken) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const accessToken = await getAccessToken();

    const message = {
      message: {
        token: fcmToken,
        notification: {
          title,
          body,
        },
      },
    };

    const response = await fetch(FCM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('FCM error:', responseData);
      return res.status(response.status).json({ error: responseData });
    }

    res.status(200).json({ success: true, message: 'Notification sent successfully' });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Endpoint to make a user admin (only current admins can access)
app.post('/api/make-admin', verifyAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    
    // Validate request
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Check if email is in allowed admin list
    if (!ALLOWED_ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ 
        error: 'This email is not authorized to be an admin'
      });
    }
    
    // Get user by email
    const userRecord = await auth.getUserByEmail(email);
    
    // Set custom claims
    await auth.setCustomUserClaims(userRecord.uid, { admin: true });
    
    // Update Firestore document
    await db.collection('users').doc(userRecord.uid).update({
      isAdmin: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.status(200).json({ message: 'User is now an admin' });
  } catch (error) {
    console.error('Error making user admin:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get admin status
app.get('/api/admin-status', async (req, res) => {
  try {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
      return res.status(401).json({ isAdmin: false });
    }
    
    const decodedToken = await auth.verifyIdToken(idToken);
    res.status(200).json({ 
      isAdmin: !!decodedToken.admin,
      email: decodedToken.email
    });
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(200).json({ isAdmin: false });
  }
});

// TEMPORARY: Seed first admin without requiring auth (remove after use!)
app.post('/api/seed-admin', async (req, res) => {
  const { email } = req.body;

  if (!email || !ALLOWED_ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ error: 'Email not allowed to be seeded as admin.' });
  }

  try {
    const userRecord = await auth.getUserByEmail(email);

    await auth.setCustomUserClaims(userRecord.uid, { admin: true });

    await db.collection('users').doc(userRecord.uid).set({
      isAdmin: true,
      seededBy: 'server',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ message: `${email} is now seeded as an admin.` });
  } catch (err) {
    console.error("Seeding error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-claims/:email', async (req, res) => {
  const email = req.params.email;

  try {
    const user = await auth.getUserByEmail(email);
    res.json({
      email: user.email,
      customClaims: user.customClaims || {}
    });
  } catch (error) {
    console.error("Error checking custom claims:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/test', (req, res) => {
  res.send("Server is active");
});

