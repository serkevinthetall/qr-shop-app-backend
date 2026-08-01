import express from "express";
import {
  getNotifications,
  getPushStatus,
  registerPushToken,
  sendTestPush,
  unregisterPushToken,
  webhookNewCoupon,
  webhookNewProduct,
} from "../controllers/notification.controller.js";

const router = express.Router();

router.get("/", getNotifications);
router.get("/push-status", getPushStatus);
router.post("/register-token", registerPushToken);
router.delete("/register-token", unregisterPushToken);
router.post("/test-push", sendTestPush);
router.post("/webhook/product", webhookNewProduct);
router.post("/webhook/coupon", webhookNewCoupon);

export default router;
