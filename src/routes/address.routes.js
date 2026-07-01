import express from "express";
import {
  getAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  getAddressMeta,
} from "../controllers/address.controller.js";

const router = express.Router();

router.get("/meta", getAddressMeta);
router.get("/", getAddresses);
router.post("/", createAddress);
router.put("/:id", updateAddress);
router.delete("/:id", deleteAddress);

export default router;