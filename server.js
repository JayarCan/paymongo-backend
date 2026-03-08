/* eslint-disable no-console */
require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

const {
  PAYMONGO_SECRET_KEY,
  SERP_API_KEY,
  PAYMONGO_WEBHOOK_SECRET,
  PAYMONGO_MODE = "test",
  PAYMONGO_QR_EXPIRY_SECONDS,
  FIREBASE_SERVICE_ACCOUNT_JSON,
  SILENT_CALC_FIREBASE_JSON, // For SilentCalculator - use this if available
  PORT = 8080,
} = process.env;

// Use SilentCalculator Firebase if available, otherwise fallback to default
const FIREBASE_JSON = SILENT_CALC_FIREBASE_JSON || FIREBASE_SERVICE_ACCOUNT_JSON;

if (!PAYMONGO_SECRET_KEY) {
  throw new Error("Missing PAYMONGO_SECRET_KEY env var");
}
if (!PAYMONGO_WEBHOOK_SECRET) {
  throw new Error("Missing PAYMONGO_WEBHOOK_SECRET env var");
}

if (!admin.apps.length) {
  if (FIREBASE_JSON) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(FIREBASE_JSON)),
    });
  } else {
    admin.initializeApp();
  }
}

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use("/paymongo/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const PAYMONGO_API = "https://api.paymongo.com/v1";

// ============================================
// HELPER FUNCTIONS
// ============================================

function paymongoAuthHeader() {
  const token = Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString("base64");
  return `Basic ${token}`;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split(",").reduce((acc, entry) => {
    const [key, value] = entry.split("=");
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {});

  const timestamp = parts.t;
  const signatureKey = PAYMONGO_MODE.toLowerCase() === "live" ? "li" : "te";
  const signature = parts[signatureKey];
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", PAYMONGO_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest("hex");

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
    return false;
  }

  return timingSafeEqual(expected, signature);
}

async function paymongoRequest(method, path, data) {
  const response = await axios({
    method,
    url: `${PAYMONGO_API}${path}`,
    headers: {
      Authorization: paymongoAuthHeader(),
      "Content-Type": "application/json",
    },
    data,
  });
  return response.data;
}

async function getOrderForPayment(orderId) {
  const orderRef = db.collection("orders").doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw new Error("Order not found");
  }
  return { ref: orderRef, data: snap.data() };
}

async function getCustomerEmail(customerId) {
  if (!customerId) return null;
  const userSnap = await db.collection("users").doc(customerId).get();
  if (!userSnap.exists) return null;
  const data = userSnap.data() || {};
  return data.email || data.userEmail || null;
}

// Calculate distance between two coordinates (in meters)
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Check if location is inside any safe zone and notify parent
async function checkGeofencesAndNotify(kidId, location) {
  try {
    const zonesSnap = await db.collection("safezones")
      .where("kidId", "==", kidId)
      .where("isActive", "==", true)
      .get();

    if (zonesSnap.empty) return;

    // Get previous geofence state
    const stateRef = db.collection("geofence_states").doc(kidId);
    const stateSnap = await stateRef.get();
    const prevStates = stateSnap.exists ? stateSnap.data().zones || {} : {};

    const newStates = {};

    for (const doc of zonesSnap.docs) {
      const zone = doc.data();
      const distance = haversineDistance(
        location.latitude,
        location.longitude,
        zone.latitude,
        zone.longitude
      );

      const isInside = distance <= zone.radius;
      const wasInside = prevStates[doc.id] === true;

      newStates[doc.id] = isInside;

      // Detect zone entry/exit
      if (isInside && !wasInside) {
        await notifyParent(kidId, {
          type: "geofence_enter",
          title: "Entered Safe Zone",
          body: `Your child entered "${zone.name}"`,
          data: { kidId, zoneId: doc.id, zoneName: zone.name, action: "enter" },
        });
      } else if (!isInside && wasInside) {
        await notifyParent(kidId, {
          type: "geofence_exit",
          title: "⚠️ Left Safe Zone",
          body: `Your child left "${zone.name}"`,
          data: { kidId, zoneId: doc.id, zoneName: zone.name, action: "exit" },
          priority: "high",
        });
      }
    }

    // Save new state
    await stateRef.set({ zones: newStates, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  } catch (err) {
    console.error("geofence check error:", err);
  }
}

// Send FCM notification to parent (NO SMS NEEDED - FREE!)
async function notifyParent(kidId, notification) {
  try {
    // Find parent for this kid
    const pairingsSnap = await db.collection("pairings")
      .where("kidId", "==", kidId)
      .where("isActive", "==", true)
      .get();

    if (pairingsSnap.empty) {
      console.log(`No active pairing found for kid ${kidId}`);
      return;
    }

    for (const pairingDoc of pairingsSnap.docs) {
      const pairing = pairingDoc.data();
      const parentId = pairing.parentId;

      // Get parent's FCM token
      const deviceSnap = await db.collection("devices").doc(parentId).get();
      if (!deviceSnap.exists) continue;

      const fcmToken = deviceSnap.data().fcmToken;
      if (!fcmToken) continue;

      // Send data-only FCM message so Android app handles alert logic in onMessageReceived
      const isHighPriority = notification.priority === "high";
      const message = {
        token: fcmToken,
        data: {
          type: notification.type || "alert",
          kidId: kidId,
          title: String(notification.title || "Silent Calculator Alert"),
          body: String(notification.body || ""),
          priority: isHighPriority ? "high" : "normal",
          ...Object.fromEntries(
            Object.entries(notification.data || {}).map(([k, v]) => [k, String(v)])
          ),
        },
        android: {
          priority: isHighPriority ? "high" : "normal",
        },
      };

      await admin.messaging().send(message);
      console.log(`FCM sent to parent ${parentId} for kid ${kidId}: ${notification.type}`);
    }
  } catch (err) {
    console.error("notify parent error:", err);
  }
}

// ============================================
// HEALTH & SEARCH ENDPOINTS
// ============================================

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ error: "Missing q" });
    }

    if (!SERP_API_KEY) {
      return res.status(500).json({ error: "SERP_API_KEY not configured" });
    }

    const response = await axios.get("https://serpapi.com/search.json", {
      params: {
        engine: "google",
        q,
        api_key: SERP_API_KEY,
        num: 10,
        hl: "en",
        gl: "ph",
      },
      timeout: 15000,
    });

    const results = (response.data?.organic_results || []).map((item) => ({
      title: item.title || "",
      snippet: item.snippet || "",
      link: item.link || "",
      source: item.source || "",
    }));

    return res.json({ query: q, results });
  } catch (err) {
    console.error("serp search error", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "Search failed" });
  }
});

// ============================================
// PAYMONGO ENDPOINTS
// ============================================

app.post("/paymongo/create-qr", async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "orderId is required" });
    }

    const { ref, data } = await getOrderForPayment(orderId);
    const amount = Math.round(Number(data.totalAmount || 0) * 100);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid order amount" });
    }

    const email = await getCustomerEmail(data.customerId);
    if (!email) {
      return res.status(400).json({ error: "Customer email is required" });
    }

    const intentPayload = {
      data: {
        attributes: {
          amount,
          currency: "PHP",
          payment_method_allowed: ["qrph"],
          capture_type: "automatic",
          description: `FastGas Order ${orderId}`,
          metadata: {
            orderId,
          },
        },
      },
    };

    const intent = await paymongoRequest("post", "/payment_intents", intentPayload);
    const intentId = intent?.data?.id;

    const deliveryAddress = data.deliveryAddress || {};
    const expirySeconds = Number(PAYMONGO_QR_EXPIRY_SECONDS);
    const methodPayload = {
      data: {
        attributes: {
          type: "qrph",
          ...(Number.isFinite(expirySeconds) && expirySeconds > 0
            ? { expiry_seconds: expirySeconds }
            : {}),
          billing: {
            name: data.customerName || "FastGas Customer",
            email,
            phone: data.customerPhone || "",
            address: {
              line1: deliveryAddress.fullAddress || deliveryAddress.shortAddress || "",
              city: deliveryAddress.city || "",
              state: deliveryAddress.province || "",
              postal_code: deliveryAddress.postalCode || "",
              country: "PH",
            },
          },
          metadata: {
            orderId,
          },
        },
      },
    };

    const paymentMethod = await paymongoRequest("post", "/payment_methods", methodPayload);
    const paymentMethodId = paymentMethod?.data?.id;

    const attachPayload = {
      data: {
        attributes: {
          payment_method: paymentMethodId,
        },
      },
    };

    const attached = await paymongoRequest(
      "post",
      `/payment_intents/${intentId}/attach`,
      attachPayload,
    );

    const qrImageUrl =
      attached?.data?.attributes?.next_action?.code?.image_url || null;

    await ref.set(
      {
        paymentMethod: "online",
        paymentStatus: "pending",
        paymentProvider: "paymongo",
        paymentProviderMode: PAYMONGO_MODE.toLowerCase(),
        paymentIntentId: intentId,
        paymentMethodId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.json({
      orderId,
      paymentIntentId: intentId,
      paymentMethodId,
      qrImageUrl,
    });
  } catch (err) {
    console.error("create-qr error", err?.response?.data || err);
    return res.status(500).json({ error: "Failed to create QR payment" });
  }
});

app.post("/paymongo/webhook", async (req, res) => {
  const rawBody = req.body.toString("utf8");
  const signature = req.header("Paymongo-Signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const eventType = event?.data?.attributes?.type;
  const eventData = event?.data?.attributes?.data;
  const paymentAttributes = eventData?.attributes || {};
  const metadata = paymentAttributes?.metadata || {};
  const paymentIntentId =
    paymentAttributes?.payment_intent_id ||
    paymentAttributes?.payment_intent?.id ||
    metadata?.paymentIntentId;
  let orderId = metadata.orderId || metadata.order_id || null;

  if (!orderId && paymentIntentId) {
    const snap = await db
      .collection("orders")
      .where("paymentIntentId", "==", paymentIntentId)
      .limit(1)
      .get();
    if (!snap.empty) {
      orderId = snap.docs[0].id;
    }
  }

  if (!orderId) {
    return res.status(200).json({ received: true });
  }

  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    return res.status(200).json({ received: true });
  }

  const orderData = orderSnap.data() || {};
  if (orderData.paymentStatus === "paid" || orderData.status === "paid") {
    return res.status(200).json({ received: true });
  }

  if (eventType === "payment.paid") {
    await orderRef.set(
      {
        paymentStatus: "paid",
        status: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paymentProvider: "paymongo",
        paymentIntentId,
        paymentReference: eventData?.id || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } else if (eventType === "payment.failed" || eventType === "qrph.expired") {
    await orderRef.set(
      {
        paymentStatus: eventType === "qrph.expired" ? "expired" : "failed",
        paymentProvider: "paymongo",
        paymentIntentId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return res.json({ received: true });
});

// ============================================
// SILENT CALCULATOR - LOCATION TRACKING
// ============================================

// Store kid's location (called every 3 seconds by kid's app)
app.post("/api/location/update", async (req, res) => {
  try {
    const { kidId, latitude, longitude, accuracy, battery, timestamp } = req.body;
    
    if (!kidId || latitude == null || longitude == null) {
      return res.status(400).json({ error: "kidId, latitude, longitude required" });
    }

    const locationData = {
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: Number(accuracy) || 0,
      battery: Number(battery) || null,
      timestamp: timestamp || Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Save current location
    await db.collection("locations").doc(kidId).set(locationData, { merge: true });

    // Save to location history (for tracking path)
    await db.collection("locations").doc(kidId)
      .collection("history")
      .add({
        ...locationData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Check geofences and notify parent if needed
    await checkGeofencesAndNotify(kidId, locationData);

    return res.json({ success: true });
  } catch (err) {
    console.error("location update error:", err);
    return res.status(500).json({ error: "Failed to update location" });
  }
});

// Get kid's current location (for parent app)
app.get("/api/location/:kidId", async (req, res) => {
  try {
    const { kidId } = req.params;
    const snap = await db.collection("locations").doc(kidId).get();
    
    if (!snap.exists) {
      return res.status(404).json({ error: "Location not found" });
    }

    return res.json({ kidId, location: snap.data() });
  } catch (err) {
    console.error("get location error:", err);
    return res.status(500).json({ error: "Failed to get location" });
  }
});

// Get location history (for path tracking)
app.get("/api/location/:kidId/history", async (req, res) => {
  try {
    const { kidId } = req.params;
    const { hours = 24 } = req.query;
    
    const since = Date.now() - (Number(hours) * 60 * 60 * 1000);
    
    const snap = await db.collection("locations").doc(kidId)
      .collection("history")
      .where("timestamp", ">=", since)
      .orderBy("timestamp", "desc")
      .limit(500)
      .get();

    const history = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ kidId, history });
  } catch (err) {
    console.error("get history error:", err);
    return res.status(500).json({ error: "Failed to get history" });
  }
});

// ============================================
// SAFE ZONES / GEOFENCE MANAGEMENT
// ============================================

// Create/Update safe zone
app.post("/api/safezone", async (req, res) => {
  try {
    const { kidId, name, latitude, longitude, radius, isActive = true } = req.body;

    if (!kidId || !name || latitude == null || longitude == null || !radius) {
      return res.status(400).json({ error: "kidId, name, latitude, longitude, radius required" });
    }

    const zoneData = {
      kidId,
      name,
      latitude: Number(latitude),
      longitude: Number(longitude),
      radius: Number(radius), // in meters
      isActive: Boolean(isActive),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("safezones").add(zoneData);
    
    // Notify parent about new safe zone
    await notifyParent(kidId, {
      type: "safezone_created",
      title: "Safe Zone Created",
      body: `New safe zone "${name}" has been set up`,
      data: { zoneId: docRef.id, ...zoneData },
    });

    return res.json({ success: true, zoneId: docRef.id });
  } catch (err) {
    console.error("create safezone error:", err);
    return res.status(500).json({ error: "Failed to create safe zone" });
  }
});

// Get all safe zones for a kid
app.get("/api/safezone/:kidId", async (req, res) => {
  try {
    const { kidId } = req.params;
    
    const snap = await db.collection("safezones")
      .where("kidId", "==", kidId)
      .get();

    const zones = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ kidId, safezones: zones });
  } catch (err) {
    console.error("get safezones error:", err);
    return res.status(500).json({ error: "Failed to get safe zones" });
  }
});

// Delete safe zone
app.delete("/api/safezone/:zoneId", async (req, res) => {
  try {
    const { zoneId } = req.params;
    await db.collection("safezones").doc(zoneId).delete();
    return res.json({ success: true });
  } catch (err) {
    console.error("delete safezone error:", err);
    return res.status(500).json({ error: "Failed to delete safe zone" });
  }
});

// ============================================
// PAIRING & DEVICE MANAGEMENT
// ============================================

// Generate pairing code (from parent device)
app.post("/api/pairing/generate", async (req, res) => {
  try {
    const { parentId } = req.body;
    
    if (!parentId) {
      return res.status(400).json({ error: "parentId required" });
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store with 10 minute expiry
    await db.collection("pairing_codes").doc(code).set({
      parentId,
      code,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      used: false,
    });

    return res.json({ code, expiresIn: 600 }); // 600 seconds
  } catch (err) {
    console.error("generate pairing code error:", err);
    return res.status(500).json({ error: "Failed to generate code" });
  }
});

// Verify pairing code (from kid device)
app.post("/api/pairing/verify", async (req, res) => {
  try {
    const { code, kidId, kidName, fcmToken } = req.body;

    if (!code || !kidId) {
      return res.status(400).json({ error: "code and kidId required" });
    }

    const codeSnap = await db.collection("pairing_codes").doc(code).get();
    
    if (!codeSnap.exists) {
      return res.status(400).json({ error: "Invalid code" });
    }

    const codeData = codeSnap.data();
    
    if (codeData.used) {
      return res.status(400).json({ error: "Code already used" });
    }

    if (codeData.expiresAt.toDate() < new Date()) {
      return res.status(400).json({ error: "Code expired" });
    }

    const parentId = codeData.parentId;

    // Create pairing relationship
    await db.collection("pairings").doc(`${parentId}_${kidId}`).set({
      parentId,
      kidId,
      kidName: kidName || "Child Device",
      kidFcmToken: fcmToken || null,
      pairedAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true,
    });

    // Mark code as used
    await db.collection("pairing_codes").doc(code).update({ used: true });

    // Add kid to parent's kids list
    await db.collection("users").doc(parentId).set({
      kids: admin.firestore.FieldValue.arrayUnion(kidId),
    }, { merge: true });

    // Notify parent
    await notifyParent(kidId, {
      type: "device_paired",
      title: "Device Paired",
      body: `${kidName || "Child device"} has been successfully paired`,
      data: { kidId, kidName },
    });

    return res.json({ success: true, parentId });
  } catch (err) {
    console.error("verify pairing error:", err);
    return res.status(500).json({ error: "Failed to verify code" });
  }
});

// Update FCM token (for push notifications)
app.post("/api/device/token", async (req, res) => {
  try {
    const { deviceId, fcmToken, deviceType } = req.body; // deviceType: 'parent' or 'kid'

    if (!deviceId || !fcmToken) {
      return res.status(400).json({ error: "deviceId and fcmToken required" });
    }

    await db.collection("devices").doc(deviceId).set({
      fcmToken,
      deviceType: deviceType || "unknown",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Also update in pairings if kid device
    if (deviceType === "kid") {
      const pairings = await db.collection("pairings")
        .where("kidId", "==", deviceId)
        .get();
      
      for (const doc of pairings.docs) {
        await doc.ref.update({ kidFcmToken: fcmToken });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("update token error:", err);
    return res.status(500).json({ error: "Failed to update token" });
  }
});

// ============================================
// ALERT/NOTIFICATION SYSTEM
// ============================================

// Kid triggers SOS alert
app.post("/api/alert/sos", async (req, res) => {
  try {
    const { kidId, latitude, longitude, message } = req.body;

    if (!kidId) {
      return res.status(400).json({ error: "kidId required" });
    }

    const alertData = {
      kidId,
      type: "sos",
      latitude: latitude || null,
      longitude: longitude || null,
      message: message || "SOS Alert triggered!",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("alerts").add(alertData);

    // Send HIGH PRIORITY notification to parent
    await notifyParent(kidId, {
      type: "sos",
      title: "🚨 SOS ALERT",
      body: message || "Your child triggered an SOS alert!",
      data: { kidId, latitude, longitude, priority: "high" },
      priority: "high",
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("sos alert error:", err);
    return res.status(500).json({ error: "Failed to send SOS" });
  }
});

// Generic alert from kid device (SMS received, call received, etc.)
app.post("/api/alert/notify", async (req, res) => {
  try {
    const { kidId, type, title, body, data } = req.body;

    if (!kidId || !type) {
      return res.status(400).json({ error: "kidId and type required" });
    }

    // Store alert
    await db.collection("alerts").add({
      kidId,
      type,
      title,
      body,
      data: data || {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify parent
    await notifyParent(kidId, {
      type,
      title: title || "Alert",
      body: body || "New alert from child device",
      data: { kidId, ...data },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("notify alert error:", err);
    return res.status(500).json({ error: "Failed to send notification" });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
