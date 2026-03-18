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
  OPENAI_API_KEY, // <-- ADDED
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

// === OPENAI HELPER ADDED ===
async function callOpenAILeafAdvisor(input) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const prompt = `
You are an agriculture assistant. Return ONLY valid JSON with this exact shape:
{
  "disease_name": "string",
  "confidence": number,
  "treatment_name": "string",
  "ingredients": ["string"],
  "preparation": "string",
  "notes": "string"
}

Context:
- crop: ${input.crop || ""}
- predicted_label: ${input.predicted_label || ""}
- confidence: ${input.confidence ?? ""}
- symptoms: ${input.symptoms || ""}
- region: ${input.region || "NCR"}

Rules:
- Keep advice practical and safe.
- If uncertain, say so in "notes".
- No markdown, no extra text, JSON only.
`;

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "You must output strict JSON only." },
        { role: "user", content: prompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  const raw = response?.data?.choices?.[0]?.message?.content?.trim() || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON from OpenAI");
  }

  return {
    disease_name: String(parsed.disease_name || input.predicted_label || "Unknown"),
    confidence: Number(parsed.confidence ?? input.confidence ?? 0),
    treatment_name: String(parsed.treatment_name || "General plant care"),
    ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients.map(String) : [],
    preparation: String(parsed.preparation || ""),
    notes: String(parsed.notes || ""),
  };
}

// ... keep all your existing helper functions and routes exactly as-is ...

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

// === OPENAI ENDPOINT ADDED ===
app.post("/api/ai/analyze-leaf", async (req, res) => {
  try {
    const { crop, predicted_label, confidence, symptoms, region } = req.body || {};

    if (!crop && !predicted_label) {
      return res.status(400).json({ error: "crop or predicted_label is required" });
    }

    const result = await callOpenAILeafAdvisor({
      crop,
      predicted_label,
      confidence,
      symptoms,
      region,
    });

    return res.json({ ok: true, result });
  } catch (err) {
    console.error("ai analyze error:", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "AI analysis failed" });
  }
});

// ... keep ALL your existing PAYMONGO / LOCATION / SAFEZONE / PAIRING / ALERT routes unchanged ...

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
