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

app.use("/api/auth", authRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api", productRoutes);
app.use("/api/membership", membershipRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/notifications", notificationRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

export default app;

// Local / traditional hosting only — Vercel invokes the exported app.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 10000;

  app.listen(PORT, () => {
    console.log(`QR Shop API running on port ${PORT}`);
  });
}
