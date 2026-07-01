import express from "express";
import {
  getMembership,
  getMembershipCoupons,
  checkMembership,
} from "../controllers/membership.controller.js";

const router = express.Router();

router.get("/", getMembership);
router.get("/coupons", getMembershipCoupons);
router.post("/check", checkMembership);

export default router;