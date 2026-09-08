import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.routes.js";
import customerRoutes from "./routes/customer.routes.js";
import productRoutes from "./routes/product.routes.js";
import membershipRoutes from "./routes/membership.routes.js";
import orderRoutes from "./routes/order.routes.js";
import addressRoutes from "./routes/address.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import deliveryFeeRoutes from "./routes/delivery-fee.routes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "QR Shop API is running",
    modules: ["auth", "customer", "product", "membership"],
  });
});

app.get("/api/app-config", (req, res) => {
  // Shared fallback stays low so a single APP_MIN_VERSION cannot force Android
  // users onto an iOS-only marketing version.
  const minVersion = String(process.env.APP_MIN_VERSION || "1.0.0").trim() || "1.0.0";
  // Platform mins: iOS App Store 1.3, Play Production 1.0.3 (code 21).
  const minIosVersion =
    String(process.env.APP_MIN_IOS_VERSION || "1.3").trim() || "1.3";
  const minAndroidVersion =
    String(process.env.APP_MIN_ANDROID_VERSION || "1.0.3").trim() || "1.0.3";

  res.json({
    success: true,
    min_version: minVersion,
    min_ios_version: minIosVersion,
    min_android_version: minAndroidVersion,
    ios_store_url: String(process.env.IOS_STORE_URL || "").trim(),
    android_store_url:
      String(
        process.env.ANDROID_STORE_URL ||
          "https://play.google.com/store/apps/details?id=com.qrshop.myanmar"
      ).trim(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api", productRoutes);
app.use("/api/membership", membershipRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/delivery-fee", deliveryFeeRoutes);
app.use("/api/notifications", notificationRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

export default app;

// Local / traditional hosting only — Vercel and Netlify invoke the exported app.
if (!process.env.VERCEL && !process.env.NETLIFY) {
  const PORT = process.env.PORT || 10000;

  app.listen(PORT, () => {
    console.log(`QR Shop API running on port ${PORT}`);
  });
}
