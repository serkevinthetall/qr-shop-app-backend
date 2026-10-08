import express from "express";
import { getPickupPoints } from "../controllers/pickup-point.controller.js";

const router = express.Router();

router.get("/", getPickupPoints);

export default router;
