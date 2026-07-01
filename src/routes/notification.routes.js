import express from "express";
import {
  getNotifications,
  registerPushToken,
  sendTestPush,
  unregisterPushToken,
  webhookNewCoupon,
  webhookNewProduct,
} from "../controllers/notification.controller.js";

const router = express.Router();

router.get("/", getNotifications);
router.post("/register-token", registerPushToken);
router.delete("/register-token", unregisterPushToken);
router.post("/test-push", sendTestPush);
router.post("/webhook/product", webhookNewProduct);
router.post("/webhook/coupon", webhookNewCoupon);

export default router;
