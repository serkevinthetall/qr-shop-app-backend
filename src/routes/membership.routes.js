import express from "express";
import {
  getMembership,
  getMembershipCoupons,
  checkMembership,
  createMembershipApplication,
  getMembershipApplication,
} from "../controllers/membership.controller.js";

const router = express.Router();

router.get("/", getMembership);
router.get("/coupons", getMembershipCoupons);
router.get("/application", getMembershipApplication);
router.post("/application", createMembershipApplication);
router.post("/check", checkMembership);

export default router;
