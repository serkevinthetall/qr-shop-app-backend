import express from "express";
import { login, logout, me } from "../controllers/auth.controller.js";
import {
  getContactById,
  listContacts,
  searchContacts,
} from "../controllers/contact.controller.js";
import { getProductById, getProducts } from "../controllers/product.controller.js";
import {
  createQuotation,
  getQuotationById,
  listQuotations,
} from "../controllers/quotation.controller.js";
import { requireAppAuth } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/auth/login", login);
router.get("/auth/me", requireAppAuth, me);
router.post("/auth/logout", requireAppAuth, logout);

router.get("/contacts/search", requireAppAuth, searchContacts);
router.get("/contacts", requireAppAuth, listContacts);
router.get("/contacts/:id", requireAppAuth, getContactById);

router.get("/products", requireAppAuth, getProducts);
router.get("/products/:id", requireAppAuth, getProductById);

router.get("/quotations", requireAppAuth, listQuotations);
router.post("/quotations", requireAppAuth, createQuotation);
router.get("/quotations/:id", requireAppAuth, getQuotationById);

export default router;
