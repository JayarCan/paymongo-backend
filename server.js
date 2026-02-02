/* eslint-disable no-console */
require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

const {
  PAYMONGO_SECRET_KEY,
  PAYMONGO_WEBHOOK_SECRET,
  PAYMONGO_MODE = "test",
  PAYMONGO_QR_EXPIRY_SECONDS,
  FIREBASE_SERVICE_ACCOUNT_JSON,
  PORT = 8080,
} = process.env;

if (!PAYMONGO_SECRET_KEY) {
  throw new Error("Missing PAYMONGO_SECRET_KEY env var");
}
if (!PAYMONGO_WEBHOOK_SECRET) {
  throw new Error("Missing PAYMONGO_WEBHOOK_SECRET env var");
}

if (!admin.apps.length) {
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON)),
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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

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

app.listen(PORT, () => {
  console.log(`PayMongo backend listening on ${PORT}`);
});
