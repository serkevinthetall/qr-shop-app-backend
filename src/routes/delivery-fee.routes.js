import express from "express";
import { getDeliveryFee } from "../controllers/delivery-fee.controller.js";

const router = express.Router();

router.get("/", getDeliveryFee);

export default router;
