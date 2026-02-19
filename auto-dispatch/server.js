const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

const DISPATCH_SECRET = process.env.DISPATCH_SECRET;
const DISPATCH_RADIUS_KM = Number(process.env.DISPATCH_RADIUS_KM || 10);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.firestore();

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "auto-dispatch" });
});

app.post("/dispatch/run", async (req, res) => {
  try {
    if (!DISPATCH_SECRET || req.header("x-dispatch-secret") !== DISPATCH_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const bookingsSnap = await db
      .collection("bookings")
      .where("adminStatus", "==", "approved")
      .where("dispatchStatus", "==", "pending")
      .get();

    if (bookingsSnap.empty) {
      return res.json({ scanned: 0, assigned: 0, message: "No pending approved bookings" });
    }

    const ridersSnap = await db
      .collection("riders")
      .where("riderStatus", "==", "available")
      .get();

    const riders = ridersSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter(
        (r) =>
          r.currentLocation &&
          typeof r.currentLocation.lat === "number" &&
          typeof r.currentLocation.lng === "number"
      );

    let assigned = 0;

    for (const bookingDoc of bookingsSnap.docs) {
      const booking = bookingDoc.data();
      const pickup = booking.pickup || {};
      if (typeof pickup.lat !== "number" || typeof pickup.lng !== "number") continue;

      const candidates = riders
        .map((r) => ({
          riderId: r.id,
          distanceKm: haversineKm(
            pickup.lat,
            pickup.lng,
            r.currentLocation.lat,
            r.currentLocation.lng
          ),
        }))
        .filter((c) => c.distanceKm <= DISPATCH_RADIUS_KM)
        .sort((a, b) => a.distanceKm - b.distanceKm);

      if (!candidates.length) continue;

      const chosen = candidates[0];
      const riderRef = db.collection("riders").doc(chosen.riderId);

      await db.runTransaction(async (tx) => {
        const latestBookingSnap = await tx.get(bookingDoc.ref);
        if (!latestBookingSnap.exists) return;
        const latestBooking = latestBookingSnap.data();

        if (
          latestBooking.adminStatus !== "approved" ||
          latestBooking.dispatchStatus !== "pending"
        ) {
          return;
        }

        const riderSnap = await tx.get(riderRef);
        if (!riderSnap.exists) return;
        const riderData = riderSnap.data();
        if (riderData.riderStatus !== "available") return;

        tx.update(bookingDoc.ref, {
          riderId: chosen.riderId,
          dispatchStatus: "assigned",
          status: "matched",
          matchedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        tx.update(riderRef, {
          riderStatus: "busy",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        assigned++;
      });
    }

    return res.json({
      scanned: bookingsSnap.size,
      assigned,
      radiusKm: DISPATCH_RADIUS_KM,
    });
  } catch (err) {
    console.error("dispatch error:", err);
    return res.status(500).json({ error: "dispatch_failed", details: String(err.message || err) });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("auto-dispatch running");
});
