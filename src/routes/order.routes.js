import express from "express";
import multer from "multer";

import {
  getOrders,
  getOrderById,
  createCheckout,
  reorder,
} from "../controllers/order.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get("/", getOrders);
router.get("/:id", getOrderById);
router.post("/checkout", upload.single("payment_screenshot"), createCheckout);
router.post("/:id/reorder", reorder);

export default router;