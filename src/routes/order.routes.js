import express from "express";
import multer from "multer";

import {
  getOrders,
  getOrderById,
  createCheckout,
  reorder,
} from "../controllers/order.controller.js";
import { error } from "../utils/response.js";

const router = express.Router();

const ALLOWED_PAYMENT_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const MAX_PAYMENT_SCREENSHOT_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PAYMENT_SCREENSHOT_BYTES,
    files: 1,
  },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_PAYMENT_MIME.has(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("INVALID_PAYMENT_SCREENSHOT_TYPE"));
    }
    return cb(null, true);
  },
});

function paymentScreenshotUpload(req, res, next) {
  upload.single("payment_screenshot")(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return error(res, "Payment screenshot must be 5MB or smaller", 400, {
          code: "FILE_TOO_LARGE",
        });
      }
      return error(res, "Invalid payment screenshot upload", 400, {
        code: "UPLOAD_ERROR",
      });
    }

    if (String(err.message) === "INVALID_PAYMENT_SCREENSHOT_TYPE") {
      return error(res, "Payment screenshot must be a JPEG, PNG, or WebP image", 400, {
        code: "INVALID_FILE_TYPE",
      });
    }

    return error(res, "Invalid payment screenshot upload", 400, {
      code: "UPLOAD_ERROR",
    });
  });
}

router.get("/", getOrders);
router.get("/:id", getOrderById);
router.post("/checkout", paymentScreenshotUpload, createCheckout);
router.post("/:id/reorder", reorder);

export default router;
